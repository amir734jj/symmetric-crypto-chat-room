using System.Reflection;
using DomainLogic;
using LiteDB;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging.Abstractions;
using Models;
using Models.Hub;

internal static class HttpsAudioTests
{
    public static async Task Run()
    {
        using var database = new LiteDatabase(new MemoryStream());
        using var playback = new PlaybackLogic(database);
        var clients = new Dictionary<string, ITypedClient>();
        var observers = new Dictionary<string, ClientRecorder>();
        var status = DispatchProxy.Create<ITypedClient, ClientRecorder>();
        var statusRecorder = (ClientRecorder)(object)status;
        var prefix = Guid.NewGuid().ToString("N");
        var channel = prefix + "-audio";
        MessageHub Create(string suffix)
        {
            var id = prefix + suffix;
            var client = DispatchProxy.Create<ITypedClient, ClientRecorder>();
            clients[id] = client;
            observers[id] = (ClientRecorder)(object)client;
            return new MessageHub(playback, new TurnHealthChecker(), NullLogger<MessageHub>.Instance)
            {
                Context = new TestContext(id),
                Clients = new AudioClients(clients, status, id),
                Groups = new TestGroups()
            };
        }
        var first = Create("a");
        var second = Create("b");
        var normal = Create("normal");
        var outsider = Create("outside");
        ClientRecorder Recorder(MessageHub hub) => observers[hub.Context.ConnectionId];
        byte[] Frame()
        {
            var packet = new byte[HttpsAudioProtocol.FrameSize];
            packet[0] = 1;
            return packet;
        }
        try
        {
            foreach (var hub in new[] { first, second, normal, outsider })
                await hub.Rejoin(hub == outsider ? channel + "-other" : channel, hub.Context.ConnectionId, hub.Context.ConnectionId);

            await Reject(() => first.SendHttpsAudio(Frame()));
            Check((await first.JoinHttpsAudioVoice()).Count == 0, "First Stealth participant should join alone");
            Check((await second.JoinHttpsAudioVoice()).Single().ConnectionId == first.Context.ConnectionId,
                "Stealth peers must discover each other");
            Check((await normal.JoinVoice()).Count == 0, "WebRTC must not discover Stealth peers");
            Check((await outsider.JoinHttpsAudioVoice()).Count == 0, "Other channels must remain isolated");
            var peers = (List<VoiceParticipant>)Recorder(first).Calls.Last(call =>
                call.Method == nameof(ITypedClient.HttpsAudioParticipantsChanged)).Args[0]!;
            Check(peers.Single().ConnectionId == second.Context.ConnectionId, "Existing peers must receive roster changes");
            var online = (List<OnlineUser>)statusRecorder.Calls.Last(call =>
                call.Method == nameof(ITypedClient.Status) && ((List<OnlineUser>)call.Args[1]!).Any(user =>
                    user.ConnectionId == first.Context.ConnectionId)).Args[1]!;
            Check(online.Single(user => user.ConnectionId == first.Context.ConnectionId).HttpsAudio,
                "Presence must expose the selected transport");
            await Reject(() => first.JoinVoice());
            await Reject(() => normal.JoinHttpsAudioVoice());
            await Reject(() => normal.SendVoiceOffer(first.Context.ConnectionId, "offer"));
            await Reject(() => first.SendVoiceOffer(normal.Context.ConnectionId, "offer"));
            await Reject(() => normal.SendHttpsAudio(Frame()));

            var frame = Frame();
            await first.SendHttpsAudio(frame);
            var received = Recorder(second).Calls.Last(call => call.Method == nameof(ITypedClient.ReceiveHttpsAudio));
            Check((string)received.Args[0]! == first.Context.ConnectionId &&
                ((byte[])received.Args[1]!).SequenceEqual(frame), "Relay must preserve sender identity and ciphertext");
            Check(!Recorder(first).Calls.Any(call => call.Method == nameof(ITypedClient.ReceiveHttpsAudio)),
                "Audio must not echo back to the sender");
            Check(!Recorder(normal).Calls.Any(call => call.Method == nameof(ITypedClient.ReceiveHttpsAudio)) &&
                !Recorder(outsider).Calls.Any(call => call.Method == nameof(ITypedClient.ReceiveHttpsAudio)),
                "Audio must not cross transports or channels");
            Check(!playback.GetMessages(channel).Any(), "Audio must never enter chat playback storage");

            var count = Recorder(second).Calls.Count(call => call.Method == nameof(ITypedClient.ReceiveHttpsAudio));
            await first.SendHttpsAudio(new byte[1]);
            Check(Recorder(first).Calls.Any(call => call.Method == nameof(ITypedClient.HttpsAudioFailed)),
                "Invalid audio must explicitly notify and remove its sender");
            Check(Recorder(second).Calls.Count(call => call.Method == nameof(ITypedClient.ReceiveHttpsAudio)) == count,
                "Invalid frames must not be forwarded");
            await Reject(() => first.SendHttpsAudio(frame));
            Check((await first.JoinVoice()).Single().ConnectionId == normal.Context.ConnectionId,
                "A stopped Stealth session must be able to use ordinary WebRTC");
            await first.LeaveVoice();
            await first.JoinHttpsAudioVoice();
            for (var index = 0; index < 150; index++)
            {
                try { await first.SendHttpsAudio(frame); }
                catch (HubException) { break; }
            }
            Check(Recorder(first).Calls.Count(call => call.Method == nameof(ITypedClient.HttpsAudioFailed)) == 2,
                "Excessive audio rate must explicitly stop the sender");
            await first.JoinHttpsAudioVoice();
            await first.SendHttpsAudio(frame);
            Check(Recorder(first).Calls.Count(call => call.Method == nameof(ITypedClient.HttpsAudioFailed)) == 2,
                "Rejoin must reset the send-rate window");
            var wrongVersion = Frame();
            wrongVersion[0] = 2;
            await first.SendHttpsAudio(wrongVersion);
            Check(Recorder(first).Calls.Count(call => call.Method == nameof(ITypedClient.HttpsAudioFailed)) == 3,
                "Unsupported protocol versions must stop the sender explicitly");
            await first.JoinHttpsAudioVoice();
            await first.Leave();
            peers = (List<VoiceParticipant>)Recorder(second).Calls.Last(call =>
                call.Method == nameof(ITypedClient.HttpsAudioParticipantsChanged)).Args[0]!;
            Check(peers.Count == 0, "Disconnect must remove the peer and stop the remaining client's capture");
            Console.WriteLine("PASS: Stealth audio transport/channel isolation, ciphertext relay, no playback storage, presence, invalid frames, rate limits, rejoin and disconnect");

            foreach (var hub in new[] { first, second, normal, outsider }) await hub.Leave();
            foreach (var hub in new[] { first, second, normal, outsider })
                await hub.Rejoin(hub == outsider ? channel + "-other" : channel, hub.Context.ConnectionId, hub.Context.ConnectionId);
            VoiceCapabilities Capabilities(bool force = false, bool opus = true, bool https = true, bool rtc = true) =>
                new() { ForceStealth = force, SupportsOpus = opus, SupportsHttpsAudio = https, SupportsWebRtc = rtc };
            VoiceCallState LastState(MessageHub hub) => (VoiceCallState)Recorder(hub).Calls.Last(call =>
                call.Method == nameof(ITypedClient.VoiceCallChanged)).Args[0]!;
            int AudioCount(MessageHub hub) => Recorder(hub).Calls.Count(call =>
                call.Method == nameof(ITypedClient.ReceiveAutomaticAudio));

            await Reject(() => outsider.RequestHttpsAudio(0));
            var initial = await first.JoinAutomaticVoice(Capabilities());
            Check(!initial.HttpsAudio && initial.Opus && initial.Participants.Count == 0,
                "Automatic must start with WebRTC and prefer native Opus for a future fallback");
            var forced = await second.JoinAutomaticVoice(Capabilities(force: true));
            Check(forced.HttpsAudio && forced.Opus && LastState(first).HttpsAudio,
                "A forced Stealth participant must switch an existing Automatic participant");
            Check(forced.MediaRevision != initial.MediaRevision &&
                LastState(first).MediaRevision == forced.MediaRevision, "All participants must agree on the media epoch");
            Check(forced.Participants.Single().ConnectionId == first.Context.ConnectionId &&
                LastState(first).Participants.Single().ConnectionId == second.Context.ConnectionId,
                "Mixed preferences must discover each other in the same call");
            var opusFrame = new byte[161];
            opusFrame[0] = 2;
            await first.SendAutomaticAudio(forced.MediaRevision, opusFrame);
            Check(AudioCount(second) == 1 && AudioCount(first) == 0 && AudioCount(outsider) == 0,
                "Native Opus ciphertext must reach only other participants in this call");
            var receivedOpus = Recorder(second).Calls.Last(call => call.Method == nameof(ITypedClient.ReceiveAutomaticAudio));
            Check((long)receivedOpus.Args[0]! == forced.MediaRevision &&
                ((byte[])receivedOpus.Args[2]!).SequenceEqual(opusFrame), "Media epoch and ciphertext must survive forwarding");
            var compatibility = await normal.JoinAutomaticVoice(Capabilities(opus: false));
            Check(compatibility.HttpsAudio && !compatibility.Opus &&
                compatibility.MediaRevision != forced.MediaRevision && !LastState(first).Opus,
                "A browser lacking native Opus must negotiate one common compatibility codec");
            var before = AudioCount(second);
            await first.SendAutomaticAudio(forced.MediaRevision, opusFrame);
            Check(AudioCount(second) == before, "In-flight frames from an obsolete codec epoch must not be forwarded");
            await first.SendAutomaticAudio(compatibility.MediaRevision, Frame());
            Check(AudioCount(second) == before + 1 && AudioCount(normal) == 1,
                "Compatibility ciphertext must reach both Automatic and forced participants");
            await second.LeaveVoice();
            Check(LastState(first).HttpsAudio && !LastState(first).Opus,
                "Leaving the forced participant must not oscillate the call back to WebRTC");
            Check(!playback.GetMessages(channel).Any(), "Neither codec may persist audio in chat history");

            foreach (var hub in new[] { first, second, normal }) await hub.LeaveVoice();
            initial = await first.JoinAutomaticVoice(Capabilities());
            Check(!initial.HttpsAudio && initial.Opus, "An empty call must reset to Automatic on the next join");
            var joined = await second.JoinAutomaticVoice(Capabilities());
            Check(joined.MediaRevision == initial.MediaRevision, "Ordinary joins must not restart existing media");
            await normal.JoinVoice();
            await Reject(() => normal.SendVoiceOffer(first.Context.ConnectionId, "legacy"));
            await Reject(() => normal.RequestHttpsAudio(initial.MediaRevision));
            var fallback = await first.RequestHttpsAudio(initial.MediaRevision);
            Check(fallback.HttpsAudio && fallback.Opus && LastState(second).MediaRevision == fallback.MediaRevision,
                "WebRTC failure must coordinate a whole-call switch");
            var duplicate = await second.RequestHttpsAudio(initial.MediaRevision);
            Check(duplicate.MediaRevision == fallback.MediaRevision, "Repeated fallback reports must be idempotent");

            foreach (var hub in new[] { first, second, normal }) await hub.LeaveVoice();
            initial = await first.JoinAutomaticVoice(Capabilities());
            await normal.JoinAutomaticVoice(Capabilities(https: false, opus: false));
            await Reject(() => second.JoinAutomaticVoice(Capabilities(force: true)));
            await Reject(() => first.RequestHttpsAudio(initial.MediaRevision));
            Check(!LastState(first).HttpsAudio, "Unsupported fallback must not partially switch the call");
            await normal.LeaveVoice();
            await first.RequestHttpsAudio(initial.MediaRevision);
            Check(LastState(first).HttpsAudio, "Fallback can proceed after the incompatible browser leaves");
            await first.LeaveVoice();
            var browserFallback = await first.JoinAutomaticVoice(Capabilities(rtc: false));
            Check(browserFallback.HttpsAudio, "A browser without encrypted WebRTC must negotiate HTTPS immediately");
            await first.LeaveVoice();
            await Reject(() => first.JoinAutomaticVoice(Capabilities(https: false, rtc: false)));
            await Reject(() => outsider.SendAutomaticAudio(browserFallback.MediaRevision, opusFrame));
            await second.JoinAutomaticVoice(Capabilities(force: true));
            var oversized = new byte[HttpsAudioProtocol.MaximumOpusFrameSize + 1];
            oversized[0] = 2;
            var shortOpus = new byte[41];
            shortOpus[0] = 2;
            foreach (var invalid in new[] { Array.Empty<byte>(), shortOpus, oversized, Frame(), new byte[161] })
            {
                var state = await first.JoinAutomaticVoice(Capabilities());
                var failures = Recorder(first).Calls.Count(call => call.Method == nameof(ITypedClient.HttpsAudioFailed));
                var receivedAutomatic = AudioCount(second);
                await first.SendAutomaticAudio(state.MediaRevision, invalid);
                Check(Recorder(first).Calls.Count(call => call.Method == nameof(ITypedClient.HttpsAudioFailed)) == failures + 1 &&
                    AudioCount(second) == receivedAutomatic, "Invalid automatic audio must notify its sender without forwarding");
                await Reject(() => first.SendAutomaticAudio(state.MediaRevision, opusFrame));
            }
            var limited = await first.JoinAutomaticVoice(Capabilities());
            var beforeLimit = Recorder(first).Calls.Count(call => call.Method == nameof(ITypedClient.HttpsAudioFailed));
            for (var index = 0; index < 150; index++)
            {
                try { await first.SendAutomaticAudio(limited.MediaRevision, opusFrame); }
                catch (HubException) { break; }
            }
            Check(Recorder(first).Calls.Count(call => call.Method == nameof(ITypedClient.HttpsAudioFailed)) == beforeLimit + 1,
                "Automatic audio must explicitly stop excessive send rates");
            var rejoined = await first.JoinAutomaticVoice(Capabilities());
            await first.SendAutomaticAudio(rejoined.MediaRevision, opusFrame);
            Check(Recorder(first).Calls.Count(call => call.Method == nameof(ITypedClient.HttpsAudioFailed)) == beforeLimit + 1,
                "Automatic audio rejoin must reset rate limiting");
            Console.WriteLine("PASS: Automatic/forced interoperability, whole-call WebRTC fallback, native Opus negotiation, codec epochs, stale frame rejection, sticky fallback, reset, legacy isolation, invalid frames, rate limits and unsupported-browser handling");
        }
        finally
        {
            foreach (var hub in new[] { first, second, normal, outsider }) await hub.Leave();
        }
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static async Task Reject(Func<Task> action)
    {
        try { await action(); }
        catch (HubException) { return; }
        throw new InvalidOperationException("Expected invalid audio/signaling operation to be rejected");
    }

    private sealed class AudioClients(
        Dictionary<string, ITypedClient> clients, ITypedClient status, string id) : IHubCallerClients<ITypedClient>
    {
        public ITypedClient All => status;
        public ITypedClient Caller => clients[id];
        public ITypedClient Others => status;
        public ITypedClient AllExcept(IReadOnlyList<string> ids) => status;
        public ITypedClient Client(string connectionId) => clients[connectionId];
        public ITypedClient Clients(IReadOnlyList<string> ids) => status;
        public ITypedClient Group(string groupName) => status;
        public ITypedClient GroupExcept(string groupName, IReadOnlyList<string> ids) => status;
        public ITypedClient Groups(IReadOnlyList<string> groupNames) => status;
        public ITypedClient OthersInGroup(string groupName) => status;
        public ITypedClient User(string userId) => status;
        public ITypedClient Users(IReadOnlyList<string> userIds) => status;
    }
}
