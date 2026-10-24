using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using JsonSerializer = System.Text.Json.JsonSerializer;
using System.Threading;
using System.Threading.Tasks;
using LiteDB;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Models;
using Lib.Net.Http.WebPush;
using Lib.Net.Http.WebPush.Authentication;

namespace DomainLogic;

public sealed class PushOptions
{
    public string PublicKey { get; set; } = "";
    public string PrivateKey { get; set; } = "";
    public string Subject { get; set; } = "";
}

public sealed class PushNotificationService : IDisposable
{
    private readonly ILiteCollection<StoredPushSubscription> _subscriptions;
    private readonly PushServiceClient _client;
    private readonly ILogger<PushNotificationService> _logger;
    private readonly VapidAuthentication _vapid;
    private readonly object _gate = new();

    public PushNotificationService(ILiteDatabase database, PushServiceClient client,
        IOptions<PushOptions> options, ILogger<PushNotificationService> logger)
    {
        _subscriptions = database.GetCollection<StoredPushSubscription>("pushSubscriptions");
        _subscriptions.EnsureIndex(x => x.Channel);
        _subscriptions.EnsureIndex(x => x.DeviceHash);
        // Legacy subscriptions have no password scope and cannot be safely assigned one.
        var removed = _subscriptions.DeleteMany(x => x.PasswordScopeHash == null || x.PasswordScopeHash == "");
        if (removed > 0)
            logger.LogWarning("Removed {Count} unscoped push subscriptions; devices must enable notifications again", removed);
        _client = client;
        _logger = logger;
        var settings = options.Value;
        if (string.IsNullOrEmpty(settings.PublicKey) && string.IsNullOrEmpty(settings.PrivateKey) &&
            string.IsNullOrEmpty(settings.Subject)) return;

        if (!ValidPublicKey(settings.PublicKey) || !ValidKey(settings.PrivateKey, 32) ||
            !Uri.TryCreate(settings.Subject, UriKind.Absolute, out var subject) ||
            (subject.Scheme != "mailto" && subject.Scheme != "https"))
            throw new InvalidOperationException("Configure Push:PublicKey, Push:PrivateKey and a mailto: or https: Push:Subject.");

        _vapid = new VapidAuthentication(settings.PublicKey, settings.PrivateKey) { Subject = settings.Subject };
    }

    public string PublicKey => _vapid?.PublicKey ?? "";

    public bool HasSubscription(string channel, string deviceToken, string passwordScope)
    {
        var id = SubscriptionId(channel, DeviceHash(deviceToken), ScopeHash(passwordScope));
        lock (_gate) return _subscriptions.Exists(x => x.Id == id);
    }

    public void Subscribe(string channel, string deviceToken, ChannelPushSubscription subscription, string passwordScope)
    {
        RequireConfigured();
        if (string.IsNullOrWhiteSpace(channel) || channel.Length > 200)
            throw new HubException("Channel names for push notifications must be 1-200 characters.");
        if (subscription == null || !ValidEndpoint(subscription.Endpoint) ||
            !ValidPublicKey(subscription.P256dh) || !ValidKey(subscription.Auth, 16))
            throw new HubException("The browser push subscription is invalid or its push provider is unsupported.");

        var deviceHash = DeviceHash(deviceToken);
        var scopeHash = ScopeHash(passwordScope);
        var id = SubscriptionId(channel, deviceHash, scopeHash);
        lock (_gate)
        {
            if (_subscriptions.Exists(x => x.Endpoint == subscription.Endpoint && x.DeviceHash != deviceHash))
                throw new HubException("This push endpoint belongs to another device registration.");
            var existing = _subscriptions.FindById(id);
            if (existing == null && (_subscriptions.Count(x => x.DeviceHash == deviceHash) >= 20 ||
                _subscriptions.Count(x => x.Channel == channel) >= 500))
                throw new HubException("The push subscription limit has been reached (20 channel/password groups per device, 500 devices per channel).");

            _subscriptions.Upsert(new StoredPushSubscription
            {
                Id = id, Channel = channel, DeviceHash = deviceHash, PasswordScopeHash = scopeHash,
                Endpoint = subscription.Endpoint, P256dh = subscription.P256dh, Auth = subscription.Auth,
                LastNotifiedUnixSeconds = existing?.LastNotifiedUnixSeconds ?? 0
            });
        }
    }

    public void Unsubscribe(string channel, string deviceToken, string passwordScope)
    {
        var id = SubscriptionId(channel, DeviceHash(deviceToken), ScopeHash(passwordScope));
        lock (_gate) _subscriptions.Delete(id);
    }

    public async Task<ChannelPushResult> Notify(string channel, string passwordScope)
    {
        RequireConfigured();
        var scopeHash = ScopeHash(passwordScope);
        List<StoredPushSubscription> recipients;
        lock (_gate)
        {
            recipients = _subscriptions.Find(x => x.Channel == channel && x.PasswordScopeHash == scopeHash).ToList();
            if (recipients.Any(x => x.LastNotifiedUnixSeconds > DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 60))
                throw new HubException("Please wait one minute between notifications to this channel/password group.");
            foreach (var recipient in recipients)
            {
                recipient.LastNotifiedUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                _subscriptions.Update(recipient);
            }
        }

        var payload = JsonSerializer.Serialize(new { channel });
        var accepted = 0;
        var failed = 0;
        var expired = 0;
        using var batchTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        await Parallel.ForEachAsync(recipients, new ParallelOptions { MaxDegreeOfParallelism = 4 },
            async (recipient, cancellationToken) =>
            {
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, batchTimeout.Token);
                    timeout.CancelAfter(TimeSpan.FromSeconds(10));
                    await _client.RequestPushMessageDeliveryAsync(
                        new PushSubscription
                        {
                            Endpoint = recipient.Endpoint,
                            Keys = new Dictionary<string, string> { ["p256dh"] = recipient.P256dh, ["auth"] = recipient.Auth }
                        },
                        new PushMessage(payload) { TimeToLive = 3600 }, _vapid, timeout.Token);
                    Interlocked.Increment(ref accepted);
                }
                catch (PushServiceClientException ex) when (ex.StatusCode == HttpStatusCode.Gone ||
                                                   ex.StatusCode == HttpStatusCode.NotFound)
                {
                    lock (_gate)
                    {
                        // Do not delete a replacement subscription saved during delivery.
                        _subscriptions.DeleteMany(x => x.Endpoint == recipient.Endpoint &&
                            x.P256dh == recipient.P256dh && x.Auth == recipient.Auth);
                    }
                    Interlocked.Increment(ref expired);
                    _logger.LogInformation("Removed an expired browser push endpoint");
                }
                catch (Exception ex) when (ex is PushServiceClientException || ex is HttpRequestException ||
                                           ex is OperationCanceledException)
                {
                    Interlocked.Increment(ref failed);
                    // Push exception messages can contain secret endpoint URLs.
                    _logger.LogError("Browser push delivery failed ({FailureType})", ex.GetType().Name);
                }
            });
        return new ChannelPushResult { Accepted = accepted, Failed = failed, Expired = expired };
    }

    private void RequireConfigured()
    {
        if (_vapid == null) throw new HubException("Push notifications are not configured on this server.");
    }

    public void Dispose() => _vapid?.Dispose();

    private static string DeviceHash(string deviceToken)
    {
        if (!ValidKey(deviceToken, 32)) throw new HubException("The push device token is invalid.");
        return Hash(deviceToken);
    }

    private static string ScopeHash(string passwordScope)
    {
        if (!ValidKey(passwordScope, 32))
            throw new HubException("A valid password-scoped notification identifier is required. Refresh the page and enable notifications again.");
        return Hash(passwordScope);
    }

    private static string SubscriptionId(string channel, string deviceHash, string scopeHash) =>
        Hash(channel + "\n" + scopeHash + "\n" + deviceHash);
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static bool ValidKey(string value, int length)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 100) return false;
        try
        {
            return DecodeKey(value).Length == length;
        }
        catch (FormatException) { return false; }
    }

    private static byte[] DecodeKey(string value) =>
        Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/')
            .PadRight((value.Length + 3) / 4 * 4, '='));

    private static bool ValidPublicKey(string value)
    {
        if (!ValidKey(value, 65)) return false;
        var bytes = DecodeKey(value);
        if (bytes[0] != 4) return false;
        try
        {
            using var key = ECDiffieHellman.Create(new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint { X = bytes[1..33], Y = bytes[33..65] }
            });
            return true;
        }
        catch (CryptographicException) { return false; }
    }

    private static bool ValidEndpoint(string endpoint)
    {
        if (string.IsNullOrEmpty(endpoint) || endpoint.Length > 4096 ||
            !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https" ||
            uri.Port != 443 || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0) return false;
        // Never turn a client-supplied endpoint into arbitrary server-side HTTP access.
        return uri.Host == "fcm.googleapis.com" || uri.Host == "updates.push.services.mozilla.com" ||
               uri.Host.EndsWith(".push.services.mozilla.com", StringComparison.Ordinal) ||
               uri.Host == "web.push.apple.com" ||
               uri.Host.EndsWith(".notify.windows.com", StringComparison.Ordinal);
    }
}

public sealed class StoredPushSubscription
{
    public string Id { get; set; } = "";
    public string Channel { get; set; } = "";
    public string DeviceHash { get; set; } = "";
    public string PasswordScopeHash { get; set; } = "";
    public string Endpoint { get; set; } = "";
    public string P256dh { get; set; } = "";
    public string Auth { get; set; } = "";
    public long LastNotifiedUnixSeconds { get; set; }
}
