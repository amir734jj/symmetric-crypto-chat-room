using System.Reflection;
using System.Security.Claims;
using DomainLogic;
using LiteDB;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Models;
using Models.Hub;

await PlaybackTests.Run();
await HttpsAudioTests.Run();
await PushTests.Run();
await RingingTests.Run();

using var database = new LiteDatabase(new MemoryStream());
using var playback = new PlaybackLogic(database);
var client = DispatchProxy.Create<ITypedClient, ClientRecorder>();
var recorder = (ClientRecorder)(object)client;
var channel = Guid.NewGuid().ToString("N");
var first = CreateHub("first");
var second = CreateHub("second");
var outsider = CreateHub("outsider");
var replacement = CreateHub("replacement");
try
{
    await first.Rejoin(channel, "Amir", "first-device");
    await TurnTests.Run(first);
    Check(LastPresence().Single().Name == "Amir", "Unique names should not get a suffix");
    await second.Rejoin(channel, "amir", "second-device");
    var users = LastPresence();
    Check(users.Count == 2, "Both matching names should remain online");
    Check(users.Select(user => user.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() == 2,
        "Matching names should have distinct labels");
    Check(users.All(user => user.Name.Contains("(session ")), "Matching names should include a session label");
    var firstName = users.Single(user => user.ConnectionId == "first").Name;
    var secondName = users.Single(user => user.ConnectionId == "second").Name;

    await first.RingVoice("second");
    Check((string)recorder.Calls.Last(call => call.Method == "VoiceCallReceived").Args[0]! == "first",
        "Online users must be able to ring each other before either joins the bridge");
    Check((string)recorder.Calls.Last(call => call.Method == "VoiceCallReceived").Args[1]! == firstName,
        "Incoming calls should identify the caller's session");
    await second.RespondVoiceCall("first", true);
    Check((bool)recorder.Calls.Last(call => call.Method == "VoiceCallResponded").Args[2]!,
        "An invitation must be accepted without requiring existing bridge membership");
    await Reject(() => first.SendVoiceOffer("second", "offer"),
        "Sending a ring must not automatically join the sender to the bridge");
    Check((await second.JoinVoice()).Count == 0,
        "Accepting users should join the bridge independently of the unjoined sender");
    await Reject(() => first.RingVoice("second"), "An already-joined user must not be rung");
    await Reject(() => first.SendVoiceOffer("second", "offer"),
        "A rejected ring must not join the sender to the bridge");
    await second.RingVoice("first");
    await first.RespondVoiceCall("second", false);
    await second.LeaveVoice();

    Check((await first.JoinVoice()).Count == 0, "First participant should join alone");
    await first.RingVoice("second");
    await second.RespondVoiceCall("first", true);
    var accepted = recorder.Calls.Last(call => call.Method == "VoiceCallResponded");
    Check((string)accepted.Args[1]! == secondName && (bool)accepted.Args[2]!,
        "Call responses should identify the responder's session");
    var peers = await second.JoinVoice();
    Check(peers.Single().ConnectionId == "first" && peers[0].Name == firstName,
        "An unjoined invitee should discover the sender when joining the bridge");
    await Reject(() => first.RingVoice("second"), "Connected peers must not ring each other");
    await Reject(() => second.RingVoice("first"), "Connected peers must not ring in either direction");
    Check((await first.JoinVoice()).Single().ConnectionId == "second" &&
        (await second.JoinVoice()).Single().ConnectionId == "first",
        "Rejected rings must preserve existing call memberships");
    await second.LeaveVoice();
    await first.RingVoice("second");
    await Reject(() => first.RingVoice("second"), "An already-pending incoming call must still be rejected");
    await first.CancelVoiceCall("second", true);
    var cancelled = recorder.Calls.Last(call => call.Method == "VoiceCallCancelled");
    Check((string)cancelled.Args[0]! == "first" && (bool)cancelled.Args[1]!,
        "Timed-out calls must still cancel the incoming ring");
    await Reject(() => second.RespondVoiceCall("first", true), "Cancelled calls must not be accepted");
    await first.RingVoice("second");
    await second.RespondVoiceCall("first", false);
    var declined = recorder.Calls.Last(call => call.Method == "VoiceCallResponded");
    Check((string)declined.Args[1]! == secondName && !(bool)declined.Args[2]!,
        "Same-name participants must be able to decline a call");
    await second.JoinVoice();
    await first.SendVoiceOffer("second", "offer");
    await second.SendVoiceAnswer("first", "answer");
    await first.SendVoiceIceCandidate("second", "candidate");
    Check(recorder.Calls.Any(call => call.Method == "ReceiveVoiceOffer"), "Same-name offers should be delivered");
    Check(recorder.Calls.Any(call => call.Method == "ReceiveVoiceAnswer"), "Same-name answers should be delivered");
    Check(recorder.Calls.Any(call => call.Method == "ReceiveVoiceIceCandidate"), "Same-name ICE should be delivered");

    var fileBytes = new byte[] { 0, 1, 2, 255 };
    var message = new MessagePayload
    {
        Channel = channel, Name = "Amir", Message = "encrypted", Token = "encrypted-token",
        Files = [new FilePayload { Name = "encrypted-name", Data = fileBytes, IsCompressed = true }]
    };
    await first.Send(message);
    Check(message.Name == firstName, "Messages should identify the sender's session");
    Check(playback.GetMessages(channel).Single().Name == firstName, "Playback should retain the sender's label");
    var saved = playback.GetMessages(channel).Single();
    Check(saved.Message == "encrypted" && saved.Token == "encrypted-token" &&
        saved.Files.Single().Name == "encrypted-name" && saved.Files[0].Data.SequenceEqual(fileBytes) &&
        saved.Files[0].IsCompressed, "Adding session labels must not alter encrypted messages or attachments");

    await Reject(() => first.RingVoice("first"), "Self-ringing must remain blocked");
    await Reject(() => first.SendVoiceOffer("first", "offer"), "Self-signaling must remain blocked");
    await outsider.Rejoin(channel + "-other", "Amir", "other-device");
    await outsider.JoinVoice();
    Check(LastPresence().Single().Name == "Amir", "Matching names in a different channel must not add a suffix");
    Check((await first.JoinVoice()).All(peer => peer.ConnectionId != "outsider"),
        "Voice discovery must not include other channels");
    await Reject(() => first.RingVoice("outsider"), "Cross-channel invitations must remain blocked");
    await Reject(() => first.SendVoiceOffer("outsider", "offer"), "Cross-channel signaling must remain blocked");
    await first.LeaveVoice();
    Check((string)recorder.Calls.Last(call => call.Method == "VoiceParticipantLeft").Args[0]! == "first",
        "Leaving voice must still notify other participants");
    await Reject(() => first.SendVoiceOffer("second", "offer"), "A participant outside voice must not signal");
    Check((await first.JoinVoice()).Single().ConnectionId == "second", "Rejoining voice must rediscover matching names");

    await first.LeaveVoice();
    await second.RingVoice("first");
    await replacement.Rejoin(channel, "Amir", "first-device");
    var disconnected = recorder.Calls.Last(call => call.Method == "VoiceCallResponded");
    Check((string)disconnected.Args[0]! == "first" && (string)disconnected.Args[1]! == firstName &&
        !(bool)disconnected.Args[2]!, "Reconnect cleanup must decline the stale connection's pending call");
    users = LastPresence();
    Check(users.Count == 2 && users.Any(user => user.ConnectionId == "second") &&
        users.Any(user => user.ConnectionId == "replacement"), "Reconnect should replace only the same client instance");
    await first.Leave();
    Check((await replacement.GetChannels()).Single(item => item.Name == channel).UserCount == 2,
        "A stale disconnect must not remove another connection");
    await replacement.Leave();
    Check(LastPresence().Single().Name == "amir", "The remaining name should no longer need a suffix");
    Console.WriteLine("PASS: same-name presence, ring/accept/decline/cancel, signaling, encrypted attachments, voice rejoin, reconnect cleanup, and channel isolation");
}
finally
{
    await first.Leave();
    await second.Leave();
    await outsider.Leave();
    await replacement.Leave();
}

MessageHub CreateHub(string id) => new(playback, new TurnHealthChecker(),
    Microsoft.Extensions.Logging.Abstractions.NullLogger<MessageHub>.Instance, PushTests.Disabled(database))
{
    Context = new TestContext(id),
    Clients = new TestClients(client),
    Groups = new TestGroups()
};

List<OnlineUser> LastPresence() =>
    (List<OnlineUser>)recorder.Calls.Last(call => call.Method == "Status").Args[1]!;

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static async Task Reject(Func<Task> action, string message)
{
    try { await action(); }
    catch (HubException) { return; }
    throw new InvalidOperationException(message);
}

public class ClientRecorder : DispatchProxy
{
    public List<(string Method, object?[] Args)> Calls { get; } = [];

    protected override object Invoke(MethodInfo? method, object?[]? args)
    {
        Calls.Add((method!.Name, args!));
        return Task.CompletedTask;
    }
}

sealed class TestContext(string id) : HubCallerContext
{
    public override string ConnectionId => id;
    public override string UserIdentifier => id;
    public override ClaimsPrincipal? User => null;
    public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?>();
    public override IFeatureCollection Features { get; } = new FeatureCollection();
    public override CancellationToken ConnectionAborted => CancellationToken.None;
    public override void Abort() { }
}

sealed class TestGroups : IGroupManager
{
    public Task AddToGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) =>
        Task.CompletedTask;
    public Task RemoveFromGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) =>
        Task.CompletedTask;
}

sealed class TestClients(ITypedClient client) : IHubCallerClients<ITypedClient>
{
    public ITypedClient All => client;
    public ITypedClient Caller => client;
    public ITypedClient Others => client;
    public ITypedClient AllExcept(IReadOnlyList<string> excludedConnectionIds) => client;
    public ITypedClient Client(string connectionId) => client;
    public ITypedClient Clients(IReadOnlyList<string> connectionIds) => client;
    public ITypedClient Group(string groupName) => client;
    public ITypedClient GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => client;
    public ITypedClient Groups(IReadOnlyList<string> groupNames) => client;
    public ITypedClient OthersInGroup(string groupName) => client;
    public ITypedClient User(string userId) => client;
    public ITypedClient Users(IReadOnlyList<string> userIds) => client;
}
