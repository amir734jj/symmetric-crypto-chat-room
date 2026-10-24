using System.Reflection;
using DomainLogic;
using LiteDB;
using Microsoft.Extensions.Logging.Abstractions;
using Models;
using Models.Constants;
using Models.Hub;

internal static class PlaybackTests
{
    public static async Task Run()
    {
        using var database = new LiteDatabase(new MemoryStream());
        var collection = database.GetCollection<MessagePayload>();
        var expiredMarker = Message("room");
        expiredMarker.Expiration = DateTimeOffset.UtcNow.AddMinutes(-1);
        collection.Insert(expiredMarker);
        using var playback = new PlaybackLogic(database);
        Check(playback.RetentionMinutes == 720 && ChatConstants.DefaultMessageRetentionMinutes == 720,
            "Default server retention must be exactly 12 hours");
        for (var attempt = 0; collection.FindById(expiredMarker.Id) != null && attempt < 100; attempt++)
            await Task.Delay(10);
        Check(collection.FindById(expiredMarker.Id) == null, "Background cleanup must remove expired messages");

        var message = Message("room");
        var before = DateTimeOffset.UtcNow;
        playback.RecordMessage(message);
        var after = DateTimeOffset.UtcNow;
        Check(message.Expiration >= before.AddHours(12) && message.Expiration <= after.AddHours(12),
            "New messages and attachments must receive the exact default 12-hour lifetime");
        var expired = Message("room");
        expired.Expiration = DateTimeOffset.UtcNow.AddSeconds(-1);
        collection.Insert(expired);
        var oldButValid = Message("room");
        oldButValid.Date = DateTime.UtcNow.AddHours(-11);
        oldButValid.Expiration = DateTimeOffset.UtcNow.AddHours(1);
        collection.Insert(oldButValid);
        var otherChannel = Message("other");
        playback.RecordMessage(otherChannel);
        var replay = playback.GetMessages("room").ToList();
        Check(replay.Select(item => item.Id).OrderBy(id => id).SequenceEqual(
            new[] { message.Id, oldButValid.Id }.OrderBy(id => id)),
            "Playback must retain older valid messages, reject expired records immediately, and isolate channels");
        Check(collection.FindById(expired.Id) != null,
            "Playback expiry must not depend on waiting for the next minute's cleanup");
        Check(replay.Single(item => item.Id == message.Id).Files.Single().Data.SequenceEqual(new byte[] { 1, 2, 3 }),
            "Encrypted attachment bytes must remain unchanged during retention and playback");

        var originalExpiration = collection.FindById(message.Id).Expiration;
        using var configured = new PlaybackLogic(database, 90);
        var custom = Message("custom");
        before = DateTimeOffset.UtcNow;
        configured.RecordMessage(custom);
        after = DateTimeOffset.UtcNow;
        Check(custom.Expiration >= before.AddMinutes(90) && custom.Expiration <= after.AddMinutes(90),
            "An override must set the exact configured lifetime, not the default");
        Check(collection.FindById(message.Id).Expiration == originalExpiration,
            "A configuration change must not silently rewrite existing expiration timestamps");
        var client = DispatchProxy.Create<ITypedClient, ClientRecorder>();
        using var push = PushTests.Disabled(database);
        var hub = new MessageHub(configured, new TurnHealthChecker(), NullLogger<MessageHub>.Instance,
            push)
        {
            Context = new TestContext("retention"),
            Clients = new TestClients(client), Groups = new TestGroups()
        };
        Check(await hub.GetMessageRetentionMinutes() == 90,
            "Clients must receive the actual server retention override");
        Check(await new MessageHub(playback, new TurnHealthChecker(), NullLogger<MessageHub>.Instance,
            push).GetMessageRetentionMinutes() == 720,
            "The default server retention must also be available to clients");
        foreach (var invalid in new[] { 0, -1, int.MinValue })
        {
            try { using var rejected = new PlaybackLogic(database, invalid); }
            catch (ArgumentOutOfRangeException) { continue; }
            throw new Exception("Nonpositive message retention must be rejected");
        }
        Console.WriteLine("PASS: default 12-hour/configured retention, immediate expiry, cleanup, attachment integrity and server-reported settings");
    }

    static MessagePayload Message(string channel) => new()
    {
        Channel = channel, Name = "Test", Message = "ciphertext", Token = "test-confirmation",
        Date = DateTime.UtcNow,
        Files = [new FilePayload { Name = "encrypted-name", Data = [1, 2, 3], ContentType = "application/octet-stream" }]
    };

    static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
