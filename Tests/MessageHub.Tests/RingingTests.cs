using System.Reflection;
using DomainLogic;
using LiteDB;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging.Abstractions;
using Models;
using Models.Hub;

internal static class RingingTests
{
    public static async Task Run()
    {
        foreach (var mode in new[] { "webrtc", "https", "automatic", "automatic-stealth" })
            await CheckBridge(mode);
        Console.WriteLine("PASS: no ringing bridge members, bridge presence, join-during-ring cleanup and rejoin across all call transports");
    }

    private static async Task CheckBridge(string mode)
    {
        using var database = new LiteDatabase(new MemoryStream());
        using var playback = new PlaybackLogic(database);
        using var push = PushTests.Disabled(database);
        var client = DispatchProxy.Create<ITypedClient, ClientRecorder>();
        var recorder = (ClientRecorder)(object)client;
        var channel = Guid.NewGuid().ToString("N");
        MessageHub Hub(string name) => new(playback, new TurnHealthChecker(), NullLogger<MessageHub>.Instance, push)
        {
            Context = new TestContext(channel + name), Clients = new TestClients(client), Groups = new TestGroups()
        };
        var first = Hub("first");
        var second = Hub("second");
        var firstId = first.Context.ConnectionId;
        var secondId = second.Context.ConnectionId;
        async Task Join(MessageHub hub)
        {
            if (mode == "webrtc") await hub.JoinVoice();
            else if (mode == "https") await hub.JoinHttpsAudioVoice();
            else await hub.JoinAutomaticVoice(new VoiceCapabilities
            {
                SupportsWebRtc = true, SupportsHttpsAudio = true,
                ForceStealth = mode == "automatic-stealth"
            });
        }
        List<OnlineUser> Presence() =>
            (List<OnlineUser>)recorder.Calls.Last(call => call.Method == nameof(ITypedClient.Status)).Args[1]!;
        try
        {
            await first.Rejoin(channel, "First", firstId);
            await second.Rejoin(channel, "Second", secondId);
            await first.RingVoice(secondId);
            await Join(second);
            Check(Presence().Single(user => user.ConnectionId == secondId).InVoice,
                mode + ": everyone in the channel must see bridge membership");
            Check(recorder.Calls.Any(call => call.Method == nameof(ITypedClient.VoiceCallCancelled) &&
                (string)call.Args[0]! == firstId),
                mode + ": joining during an incoming invitation must stop the receiver's ringtone");
            Check(recorder.Calls.Any(call => call.Method == nameof(ITypedClient.VoiceCallResponded) &&
                (string)call.Args[0]! == secondId && (bool)call.Args[2]!),
                mode + ": joining during an invitation must clear the caller's outgoing ring");
            await Reject(() => second.RespondVoiceCall(firstId, true));
            var rings = recorder.Calls.Count(call => call.Method == nameof(ITypedClient.VoiceCallReceived));
            await Reject(() => first.RingVoice(secondId));
            Check(recorder.Calls.Count(call => call.Method == nameof(ITypedClient.VoiceCallReceived)) == rings,
                mode + ": rejected rings must not emit an incoming-call event");
            await Join(first);
            await Reject(() => second.RingVoice(firstId));
            await Reject(() => first.RingVoice(secondId));
            Check(Presence().All(user => user.InVoice), mode + ": both people should be in the same bridge without more ringing");
            await second.LeaveVoice();
            Check(!Presence().Single(user => user.ConnectionId == secondId).InVoice,
                mode + ": leaving must restore the ability to invite that person");
            await first.RingVoice(secondId);
            await second.RespondVoiceCall(firstId, true);
            await Join(second);
            await Reject(() => first.RingVoice(secondId));
        }
        finally
        {
            await first.Leave();
            await second.Leave();
        }
    }

    private static async Task Reject(Func<Task> action)
    {
        try { await action(); }
        catch (HubException) { return; }
        throw new Exception("Expected bridge ring or obsolete answer to be rejected");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
