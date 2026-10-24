using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using DomainLogic;
using LiteDB;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Models;
using Models.Hub;
using Lib.Net.Http.WebPush;

internal static class PushTests
{
    public static PushNotificationService Disabled(ILiteDatabase database) =>
        new(database, new PushServiceClient(), Options.Create(new PushOptions()),
            NullLogger<PushNotificationService>.Instance);

    public static async Task Run()
    {
        using var database = new LiteDatabase(new MemoryStream());
        using var handler = new PushHandler();
        using var http = new HttpClient(handler);
        var client = new PushServiceClient(http) { AutoRetryAfter = false };
        var keys = Keys();
        var options = Options.Create(new PushOptions
        {
            PublicKey = keys.PublicKey, PrivateKey = keys.PrivateKey, Subject = "mailto:admin@example.com"
        });
        PushNotificationService Service() => new(database, client, options, NullLogger<PushNotificationService>.Instance);
        using var service = Service();
        var firstToken = Token();
        var secondToken = Token();
        var firstSubscription = Subscription("first");
        service.Subscribe("one", firstToken, firstSubscription);
        service.Subscribe("two", firstToken, firstSubscription);
        service.Subscribe("one", secondToken, Subscription("second"));
        Check(service.HasSubscription("one", firstToken), "Subscription should be saved");
        using (var reloaded = Service())
            Check(reloaded.HasSubscription("two", firstToken), "A new service must load durable subscriptions");
        service.Subscribe("one", firstToken, firstSubscription);
        Check(database.GetCollection<StoredPushSubscription>("pushSubscriptions").Count() == 3,
            "Subscribe must be idempotent and support multiple channels");
        Check(handler.Requests == 0, "Joining and subscribing must never automatically send notifications");
        service.Unsubscribe("one", Token());
        Check(service.HasSubscription("one", firstToken), "Another device must not remove this device's subscription");
        await Reject(() => service.Subscribe("one", secondToken, firstSubscription));
        foreach (var endpoint in new[]
        {
            "http://fcm.googleapis.com/push", "https://127.0.0.1/push",
            "https://fcm.googleapis.com.evil.example/push", "https://fcm.googleapis.com:8443/push",
            "https://user@fcm.googleapis.com/push"
        })
        {
            var invalid = Subscription("invalid");
            invalid.Endpoint = endpoint;
            await Reject(() => service.Subscribe("one", firstToken, invalid));
        }
        var invalidKeys = Subscription("invalid");
        invalidKeys.Auth = "invalid";
        await Reject(() => service.Subscribe("one", firstToken, invalidKeys));
        invalidKeys = Subscription("invalid-point");
        invalidKeys.P256dh = Convert.ToBase64String(new byte[65]);
        await Reject(() => service.Subscribe("one", firstToken, invalidKeys));
        await Reject(() => service.Subscribe("one", "not-a-token", firstSubscription));
        await Reject(() => Disabled(database).Subscribe("one", firstToken, firstSubscription));

        handler.Status = HttpStatusCode.Created;
        var result = await service.Notify("one");
        Check(result.Accepted == 2 && result.Failed == 0 && handler.Requests == 2,
            "Only subscribers to the selected channel must receive encrypted Web Push requests");
        await RejectAsync(() => service.Notify("one"));
        Check(handler.Requests == 2, "Channel cooldown must prevent another send");
        var subscriptions = database.GetCollection<StoredPushSubscription>("pushSubscriptions");
        foreach (var subscription in subscriptions.Find(x => x.Channel == "one").ToList())
        {
            subscription.LastNotifiedUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 58;
            subscriptions.Update(subscription);
        }
        await RejectAsync(() => service.Notify("one"));
        foreach (var subscription in subscriptions.Find(x => x.Channel == "one").ToList())
        {
            subscription.LastNotifiedUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 61;
            subscriptions.Update(subscription);
        }
        Check((await service.Notify("one")).Accepted == 2, "Notifications must resume once the one-minute cooldown expires");
        service.Unsubscribe("one", firstToken);
        Check(!service.HasSubscription("one", firstToken) && service.HasSubscription("two", firstToken),
            "Disabling one channel must preserve other channels");
        handler.Status = HttpStatusCode.ServiceUnavailable;
        result = await service.Notify("two");
        Check(result.Failed == 1 && service.HasSubscription("two", firstToken),
            "Transient errors must be reported and retain the subscription");
        service.Subscribe("expired", firstToken, firstSubscription);
        handler.Status = HttpStatusCode.Gone;
        result = await service.Notify("expired");
        Check(result.Expired == 1 && !service.HasSubscription("two", firstToken),
            "A gone endpoint must be removed from all channels");
        result = await service.Notify("empty");
        Check(result.Accepted == 0 && result.Failed == 0 && result.Expired == 0,
            "Empty channels must not pretend a notification was sent");
        var limitedToken = Token();
        for (var index = 0; index < 20; index++)
            service.Subscribe("limit-" + index, limitedToken, Subscription("limit"));
        await Reject(() => service.Subscribe("limit-20", limitedToken, Subscription("limit")));
        service.Subscribe("limit-0", limitedToken, Subscription("limit"));
        Check(service.HasSubscription("limit-0", limitedToken), "Updating an existing subscription must still work at the device limit");
        var crowdedSubscription = Subscription("crowded");
        for (var index = 0; index < 500; index++)
        {
            crowdedSubscription.Endpoint = "https://fcm.googleapis.com/push/crowded-" + index;
            service.Subscribe("crowded", Token(), crowdedSubscription);
        }
        await Reject(() => service.Subscribe("crowded", Token(), Subscription("crowded-overflow")));

        using var playback = new PlaybackLogic(database);
        var typedClient = DispatchProxy.Create<ITypedClient, ClientRecorder>();
        var hub = new MessageHub(playback, new TurnHealthChecker(), NullLogger<MessageHub>.Instance, service)
        {
            Context = new TestContext("push-" + Guid.NewGuid().ToString("N")),
            Clients = new TestClients(typedClient), Groups = new TestGroups()
        };
        await RejectAsync(() => hub.NotifyChannel());
        await RejectAsync(() => hub.SubscribeChannelPush(firstToken, firstSubscription));
        try
        {
            await hub.Rejoin("joined-push-channel", "Push user", Guid.NewGuid().ToString("N"));
            await hub.SubscribeChannelPush(firstToken, firstSubscription);
            Check(service.HasSubscription("joined-push-channel", firstToken),
                "Hub subscriptions must use the joined channel, not a client-specified channel");
            handler.Status = HttpStatusCode.Created;
            result = await hub.NotifyChannel();
            Check(result.Accepted == 1, "A joined user must be able to notify their channel");
            await hub.UnsubscribeChannelPush(firstToken);
            Check(!await hub.HasChannelPush(firstToken), "Hub must support disabling channel push");
        }
        finally { await hub.Leave(); }
        Console.WriteLine("PASS: channel push persistence, ownership, validation, delivery, expiry, cooldown and hub membership");
    }

    static ChannelPushSubscription Subscription(string name) => new()
    {
        Endpoint = "https://fcm.googleapis.com/push/" + name,
        P256dh = Keys().PublicKey,
        Auth = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    };

    static string Token() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    static PushOptions Keys()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var parameters = key.ExportParameters(true);
        var publicKey = new byte[65];
        publicKey[0] = 4;
        parameters.Q.X!.CopyTo(publicKey, 1);
        parameters.Q.Y!.CopyTo(publicKey, 33);
        string Encode(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return new PushOptions { PublicKey = Encode(publicKey), PrivateKey = Encode(parameters.D!) };
    }

    static Task Reject(Action action)
    {
        try { action(); }
        catch (HubException) { return Task.CompletedTask; }
        throw new Exception("Expected push request to be rejected");
    }

    static async Task RejectAsync(Func<Task> action)
    {
        try { await action(); }
        catch (HubException) { return; }
        throw new Exception("Expected push request to be rejected");
    }

    static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    sealed class PushHandler : HttpMessageHandler
    {
        public HttpStatusCode Status { get; set; }
        public int Requests;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Requests);
            Check(request.RequestUri!.Host == "fcm.googleapis.com", "Requests must go to the push provider");
            Check(request.Headers.Contains("Authorization"), "Web Push must use VAPID authorization");
            var body = await request.Content!.ReadAsByteArrayAsync(cancellationToken);
            Check(body.Length > 0 && body[0] != (byte)'{', "Push payload must be encrypted");
            Check(request.Content.Headers.ContentEncoding.Single() == "aes128gcm",
                "Push must use RFC 8291 encryption, including for Safari compatibility");
            Check(request.Headers.GetValues("TTL").Single() == "3600", "Push must expire after one hour");
            return new HttpResponseMessage(Status) { Content = new StringContent("") };
        }
    }
}
