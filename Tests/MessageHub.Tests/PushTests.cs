using System.Net;
using System.Collections.Concurrent;
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
    static readonly string Scope = Token();

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
        service.Subscribe("one", firstToken, firstSubscription, Scope);
        service.Subscribe("two", firstToken, firstSubscription, Scope);
        service.Subscribe("one", secondToken, Subscription("second"), Scope);
        Check(service.HasSubscription("one", firstToken, Scope), "Subscription should be saved");
        using (var reloaded = Service())
            Check(reloaded.HasSubscription("two", firstToken, Scope), "A new service must load durable subscriptions");
        service.Subscribe("one", firstToken, firstSubscription, Scope);
        Check(database.GetCollection<StoredPushSubscription>("pushSubscriptions").Count() == 3,
            "Subscribe must be idempotent and support multiple channels");
        Check(handler.Requests == 0, "Joining and subscribing must never automatically send notifications");
        service.Unsubscribe("one", Token(), Scope);
        Check(service.HasSubscription("one", firstToken, Scope), "Another device must not remove this device's subscription");
        await Reject(() => service.Subscribe("one", secondToken, firstSubscription, Scope));
        foreach (var endpoint in new[]
        {
            "http://fcm.googleapis.com/push", "https://127.0.0.1/push",
            "https://fcm.googleapis.com.evil.example/push", "https://fcm.googleapis.com:8443/push",
            "https://user@fcm.googleapis.com/push"
        })
        {
            var invalid = Subscription("invalid");
            invalid.Endpoint = endpoint;
            await Reject(() => service.Subscribe("one", firstToken, invalid, Scope));
        }
        var invalidKeys = Subscription("invalid");
        invalidKeys.Auth = "invalid";
        await Reject(() => service.Subscribe("one", firstToken, invalidKeys, Scope));
        invalidKeys = Subscription("invalid-point");
        invalidKeys.P256dh = Convert.ToBase64String(new byte[65]);
        await Reject(() => service.Subscribe("one", firstToken, invalidKeys, Scope));
        await Reject(() => service.Subscribe("one", "not-a-token", firstSubscription, Scope));
        await Reject(() => Disabled(database).Subscribe("one", firstToken, firstSubscription, Scope));

        handler.Status = HttpStatusCode.Created;
        var result = await service.Notify("one", Scope);
        Check(result.Accepted == 2 && result.Failed == 0 && handler.Requests == 2,
            "Only subscribers to the selected channel must receive encrypted Web Push requests");
        await RejectAsync(() => service.Notify("one", Scope));
        Check(handler.Requests == 2, "Channel cooldown must prevent another send");
        var subscriptions = database.GetCollection<StoredPushSubscription>("pushSubscriptions");
        foreach (var subscription in subscriptions.Find(x => x.Channel == "one").ToList())
        {
            subscription.LastNotifiedUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 58;
            subscriptions.Update(subscription);
        }
        await RejectAsync(() => service.Notify("one", Scope));
        foreach (var subscription in subscriptions.Find(x => x.Channel == "one").ToList())
        {
            subscription.LastNotifiedUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 61;
            subscriptions.Update(subscription);
        }
        Check((await service.Notify("one", Scope)).Accepted == 2, "Notifications must resume once the one-minute cooldown expires");
        service.Unsubscribe("one", firstToken, Scope);
        Check(!service.HasSubscription("one", firstToken, Scope) && service.HasSubscription("two", firstToken, Scope),
            "Disabling one channel must preserve other channels");
        handler.Status = HttpStatusCode.ServiceUnavailable;
        result = await service.Notify("two", Scope);
        Check(result.Failed == 1 && service.HasSubscription("two", firstToken, Scope),
            "Transient errors must be reported and retain the subscription");
        service.Subscribe("expired", firstToken, firstSubscription, Scope);
        handler.Status = HttpStatusCode.Gone;
        result = await service.Notify("expired", Scope);
        Check(result.Expired == 1 && !service.HasSubscription("two", firstToken, Scope),
            "A gone endpoint must be removed from all channels");
        result = await service.Notify("empty", Scope);
        Check(result.Accepted == 0 && result.Failed == 0 && result.Expired == 0,
            "Empty channels must not pretend a notification was sent");
        var limitedToken = Token();
        for (var index = 0; index < 20; index++)
            service.Subscribe("limit-" + index, limitedToken, Subscription("limit"), Scope);
        await Reject(() => service.Subscribe("limit-20", limitedToken, Subscription("limit"), Scope));
        service.Subscribe("limit-0", limitedToken, Subscription("limit"), Scope);
        Check(service.HasSubscription("limit-0", limitedToken, Scope), "Updating an existing subscription must still work at the device limit");
        var crowdedSubscription = Subscription("crowded");
        for (var index = 0; index < 500; index++)
        {
            crowdedSubscription.Endpoint = "https://fcm.googleapis.com/push/crowded-" + index;
            service.Subscribe("crowded", Token(), crowdedSubscription, Scope);
        }
        await Reject(() => service.Subscribe("crowded", Token(), Subscription("crowded-overflow"), Scope));

        using var playback = new PlaybackLogic(database);
        var typedClient = DispatchProxy.Create<ITypedClient, ClientRecorder>();
        var hub = new MessageHub(playback, new TurnHealthChecker(), NullLogger<MessageHub>.Instance, service)
        {
            Context = new TestContext("push-" + Guid.NewGuid().ToString("N")),
            Clients = new TestClients(typedClient), Groups = new TestGroups()
        };
        await RejectAsync(() => hub.NotifyChannel(Scope));
        await RejectAsync(() => hub.SubscribeChannelPush(firstToken, firstSubscription, Scope));
        try
        {
            await hub.Rejoin("joined-push-channel", "Push user", Guid.NewGuid().ToString("N"));
            await hub.SubscribeChannelPush(firstToken, firstSubscription, Scope);
            Check(service.HasSubscription("joined-push-channel", firstToken, Scope),
                "Hub subscriptions must use the joined channel, not a client-specified channel");
            handler.Status = HttpStatusCode.Created;
            result = await hub.NotifyChannel(Scope);
            Check(result.Accepted == 1, "A joined user must be able to notify their channel");
            await hub.UnsubscribeChannelPush(firstToken, Scope);
            Check(!await hub.HasChannelPush(firstToken, Scope), "Hub must support disabling channel push");
        }
        finally { await hub.Leave(); }
        Console.WriteLine("PASS: channel push persistence, ownership, validation, delivery, expiry, cooldown and hub membership");
        await PasswordIsolation(options);
    }

    static async Task PasswordIsolation(IOptions<PushOptions> options)
    {
        using var database = new LiteDatabase(new MemoryStream());
        var rows = database.GetCollection<BsonDocument>("pushSubscriptions");
        rows.Insert(new BsonDocument { ["_id"] = "legacy-missing", ["Channel"] = "shared" });
        rows.Insert(new BsonDocument { ["_id"] = "legacy-empty", ["Channel"] = "shared", ["PasswordScopeHash"] = "" });
        using var handler = new PushHandler { Status = HttpStatusCode.Created };
        using var http = new HttpClient(handler);
        using var service = new PushNotificationService(database, new PushServiceClient(http), options,
            NullLogger<PushNotificationService>.Instance);
        Check(rows.Count() == 0, "Legacy unscoped subscriptions must be removed, never assigned to a password group");
        var otherScope = Token();
        var firstToken = Token();
        var secondToken = Token();
        var sharedToken = Token();
        var sharedEndpoint = Subscription("both-passwords");
        service.Subscribe("shared", firstToken, Subscription("password-a"), Scope);
        service.Subscribe("shared", secondToken, Subscription("password-b"), otherScope);
        service.Subscribe("shared", sharedToken, sharedEndpoint, Scope);
        service.Subscribe("shared", sharedToken, sharedEndpoint, otherScope);
        Check(!service.HasSubscription("shared", firstToken, otherScope),
            "The same channel with a different password must not appear subscribed");
        using (var reloaded = new PushNotificationService(database, new PushServiceClient(http), options,
            NullLogger<PushNotificationService>.Instance))
            Check(reloaded.HasSubscription("shared", firstToken, Scope),
                "Password-scoped subscriptions must survive service restarts");
        Check((await service.Notify("shared", Token())).Accepted == 0 && handler.Requests == 0,
            "A nonmatching password must never trigger a channel-wide fallback");
        Check((await service.Notify("shared", Scope)).Accepted == 2 && handler.Requests == 2,
            "Only devices matching the first password must receive reminders");
        Check(handler.Endpoints.OrderBy(endpoint => endpoint).SequenceEqual(
            new[] { "/push/both-passwords", "/push/password-a" }),
            "No endpoint from the other password group may receive the first reminder");
        Check((await service.Notify("shared", otherScope)).Accepted == 2 && handler.Requests == 4,
            "Another password group must have separate recipients and cooldown");
        Check(handler.Endpoints.Count(endpoint => endpoint == "/push/password-a") == 1 &&
            handler.Endpoints.Count(endpoint => endpoint == "/push/password-b") == 1 &&
            handler.Endpoints.Count(endpoint => endpoint == "/push/both-passwords") == 2,
            "Each request must go to exactly the endpoints matching its password scope");
        await RejectAsync(() => service.Notify("shared", Scope));
        service.Unsubscribe("shared", firstToken, otherScope);
        Check(service.HasSubscription("shared", firstToken, Scope),
            "A different password must not disable the original password's subscription");
        service.Unsubscribe("shared", sharedToken, Scope);
        Check(!service.HasSubscription("shared", sharedToken, Scope) &&
            service.HasSubscription("shared", sharedToken, otherScope),
            "One browser can independently manage multiple passwords in the same channel");
        Check(database.GetCollection<StoredPushSubscription>("pushSubscriptions").FindAll()
            .All(row => row.PasswordScopeHash != Scope && row.PasswordScopeHash != otherScope),
            "The database must store only a hash of the notification capability");
        foreach (var invalid in new[] { "", "invalid", new string('a', 200), null! })
        {
            await Reject(() => service.HasSubscription("shared", firstToken, invalid));
            await Reject(() => service.Subscribe("shared", firstToken, Subscription("invalid-scope"), invalid));
            await Reject(() => service.Unsubscribe("shared", firstToken, invalid));
            await RejectAsync(() => service.Notify("shared", invalid));
        }
        Check(handler.Requests == 4, "Missing or invalid scopes must fail closed without delivering notifications");
        using var playback = new PlaybackLogic(database);
        var typedClient = DispatchProxy.Create<ITypedClient, ClientRecorder>();
        MessageHub Hub() => new(playback, new TurnHealthChecker(), NullLogger<MessageHub>.Instance, service)
        {
            Context = new TestContext("password-push-" + Guid.NewGuid().ToString("N")),
            Clients = new TestClients(typedClient), Groups = new TestGroups()
        };
        var alice = Hub();
        var bob = Hub();
        try
        {
            await alice.Rejoin("hub-password-group", "Alice", Guid.NewGuid().ToString("N"));
            await bob.Rejoin("hub-password-group", "Bob", Guid.NewGuid().ToString("N"));
            await alice.SubscribeChannelPush(Token(), Subscription("alice"), Scope);
            await bob.SubscribeChannelPush(Token(), Subscription("bob"), Scope);
            Check((await bob.NotifyChannel(otherScope)).Accepted == 0,
                "A joined hub caller with a nonmatching password must not notify the channel's subscribers");
            Check((await alice.NotifyChannel(Scope)).Accepted == 2,
                "Different usernames sharing the channel/password must both receive reminders");
        }
        finally
        {
            await alice.Leave();
            await bob.Leave();
        }
        Console.WriteLine("PASS: password-scoped push isolation, independent cooldown/subscriptions, persistence and fail-closed legacy migration");
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
        public ConcurrentBag<string> Endpoints { get; } = new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Requests);
            Check(request.RequestUri!.Host == "fcm.googleapis.com", "Requests must go to the push provider");
            Endpoints.Add(request.RequestUri.AbsolutePath);
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
