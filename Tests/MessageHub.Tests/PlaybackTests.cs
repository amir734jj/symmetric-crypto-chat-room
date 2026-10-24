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
        await FileOnlyReplay();
    }

    static async Task FileOnlyReplay()
    {
        using var database = new LiteDatabase(new MemoryStream());
        using var playback = new PlaybackLogic(database);
        using var push = PushTests.Disabled(database);
        var client = DispatchProxy.Create<ITypedClient, ClientRecorder>();
        var recorder = (ClientRecorder)(object)client;
        var channel = Guid.NewGuid().ToString("N");
        MessageHub Hub(string connectionId) => new(playback, new TurnHealthChecker(),
            NullLogger<MessageHub>.Instance, push)
        {
            Context = new TestContext(connectionId),
            Clients = new TestClients(client), Groups = new TestGroups()
        };
        var sender = Hub("file-sender");
        var laterJoiner = Hub("file-joiner");
        try
        {
            await sender.Rejoin(channel, "Sender", Guid.NewGuid().ToString("N"));
            var fileOnly = Message(channel);
            fileOnly.Message = string.Empty;
            fileOnly.Files[0].IsCompressed = true;
            fileOnly.Files.Add(new FilePayload
            {
                Name = "second-encrypted-name", Data = [0, 255, 128],
                ContentType = "image/png"
            });
            var before = DateTimeOffset.UtcNow;
            await sender.Send(fileOnly);
            var after = DateTimeOffset.UtcNow;
            var collection = database.GetCollection<MessagePayload>();
            var stored = collection.FindById(fileOnly.Id);
            Check(stored.Expiration >= before.AddHours(12) && stored.Expiration <= after.AddHours(12),
                "Sending a file-only message must persist it with the exact default 12-hour lifetime");

            stored.Date = DateTime.UtcNow.AddHours(-11);
            stored.Expiration = DateTimeOffset.UtcNow.AddHours(1);
            collection.Update(stored);
            var savedExpiration = collection.FindById(stored.Id).Expiration;
            var expired = Message(channel);
            expired.Message = string.Empty;
            expired.Expiration = DateTimeOffset.UtcNow.AddSeconds(-1);
            collection.Insert(expired);
            var otherChannel = Message(channel + "-other");
            otherChannel.Message = string.Empty;
            playback.RecordMessage(otherChannel);
            await sender.Leave();
            recorder.Calls.Clear();
            await laterJoiner.Join(channel, "Later joiner", Guid.NewGuid().ToString("N"));
            var replay = recorder.Calls.Where(call => call.Method == nameof(ITypedClient.Inbox))
                .Select(call => (MessagePayload)call.Args[0]!)
                .Where(message => message.Files.Count > 0).ToList();
            Check(replay.Count == 1 && replay[0].Id == fileOnly.Id,
                "A later joiner must receive an 11-hour-old file-only message, but not expired or other-channel files");
            var received = replay[0];
            Check(received.Message == string.Empty && received.Token == fileOnly.Token &&
                received.Expiration == savedExpiration && received.Files.Count == fileOnly.Files.Count,
                "File-only playback must preserve the encryption token, expiration and all attachments");
            for (var index = 0; index < fileOnly.Files.Count; index++)
            {
                var expected = fileOnly.Files[index];
                var actual = received.Files[index];
                Check(actual.Name == expected.Name && actual.ContentType == expected.ContentType &&
                    actual.IsCompressed == expected.IsCompressed && actual.Data.SequenceEqual(expected.Data),
                    "File-only playback must preserve encrypted names, bytes, content types and compression flags");
            }
        }
        finally
        {
            await sender.Leave();
            await laterJoiner.Leave();
        }
        Console.WriteLine("PASS: file-only messages retain encrypted attachments for 12 hours and replay to later joiners");
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
