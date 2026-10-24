using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Models;
using Models.Hub;

namespace DomainLogic
{
    public class MessageHub : Hub<ITypedClient>, ITypedServer
    {
        private readonly PlaybackLogic _playbackLogic;

        private readonly TurnHealthChecker _turnHealthChecker;

        private readonly ILogger<MessageHub> _logger;

        private static readonly ConcurrentDictionary<string, (string Channel, string Name, string ClientInstanceId, long JoinedOrder)> Users = new();

        private static readonly ConcurrentDictionary<string, string> ClientConnections = new();

        private static long _joinedOrder;

        private static readonly ConcurrentDictionary<string, byte> VoiceUsers = new();

        private static readonly ConcurrentDictionary<string, (long Window, int Count)> AudioRates = new();

        private static readonly object VoiceGate = new();
        private static readonly ConcurrentDictionary<string, VoiceCapabilities> AutomaticVoiceUsers = new();
        private static readonly Dictionary<string, VoiceCallState> AutomaticCalls = new();
        private static long _voiceRevision;

        private static readonly ConcurrentDictionary<string, string> PendingVoiceCalls = new();

        public MessageHub(PlaybackLogic playbackLogic, TurnHealthChecker turnHealthChecker, ILogger<MessageHub> logger)
        {
            _playbackLogic = playbackLogic;
            _turnHealthChecker = turnHealthChecker;
            _logger = logger;
        }
        
        public override Task OnConnectedAsync()
        {
            return Task.CompletedTask;
        }

        public override async Task OnDisconnectedAsync(Exception ex)
        {
            await Leave();
        }

        public async Task Send(MessagePayload message)
        {
            if (Users.TryGetValue(Context.ConnectionId, out var userInfo))
            {
                if (userInfo.Channel != message.Channel)
                {
                    throw new ArgumentException($"user was logged-in to {userInfo.Channel} but its sending message to {message.Channel}");
                }
            }
            else
            {
                throw new ArgumentException("SignalR client is not logged-in");
            }
            
            message.Name = GetDisplayName(userInfo);
            _playbackLogic.RecordMessage(message);
            
            await Clients.Group(message.Channel).Inbox(message);
        }
        
        public async Task Join(string channel, string name, string clientInstanceId)
        {
            await JoinRoom(channel, name, clientInstanceId);

            foreach (var messagePayload in _playbackLogic.GetMessages(channel))
            {
                await Clients.Client(Context.ConnectionId).Inbox(messagePayload);
            }
        }

        public Task Rejoin(string channel, string name, string clientInstanceId)
        {
            return JoinRoom(channel, name, clientInstanceId);
        }

        private async Task JoinRoom(string channel, string name, string clientInstanceId)
        {
            if (string.IsNullOrWhiteSpace(clientInstanceId) || clientInstanceId.Length > 128)
            {
                throw new HubException("Client instance ID is invalid");
            }

            await Leave();

            var staleConnectionId = ClaimClientConnection(clientInstanceId, Context.ConnectionId);
            if (staleConnectionId != null)
            {
                await RemoveConnection(staleConnectionId);
            }

            await Groups.AddToGroupAsync(Context.ConnectionId, channel);

            Users[Context.ConnectionId] = (channel, name, clientInstanceId, Interlocked.Increment(ref _joinedOrder));

            await NotifyAll(channel, MessageTypeEnum.Joined);
        }

        public Task Leave()
        {
            return RemoveConnection(Context.ConnectionId);
        }

        public Task<List<ChannelSummary>> GetChannels()
        {
            var channels = Users.Values
                .GroupBy(user => user.Channel, StringComparer.OrdinalIgnoreCase)
                .Select(group => new ChannelSummary
                {
                    Name = group.Key,
                    UserCount = group.Count()
                })
                .OrderBy(channel => channel.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            if (!channels.Any(channel => string.Equals(channel.Name, "public", StringComparison.OrdinalIgnoreCase)))
            {
                channels.Insert(0, new ChannelSummary { Name = "public" });
            }

            return Task.FromResult(channels);
        }

        private async Task RemoveConnection(string connectionId)
        {
            if (!Users.TryRemove(connectionId, out var userInfo))
            {
                return;
            }

            ((ICollection<KeyValuePair<string, string>>)ClientConnections)
                .Remove(new KeyValuePair<string, string>(userInfo.ClientInstanceId, connectionId));

            if (PendingVoiceCalls.TryRemove(connectionId, out var callerConnectionId))
            {
                await Clients.Client(callerConnectionId)
                    .VoiceCallResponded(connectionId, GetDisplayName(userInfo), false);
            }

            foreach (var pendingCall in PendingVoiceCalls.Where(call => call.Value == connectionId))
            {
                if (TryRemovePendingCall(pendingCall.Key, connectionId))
                {
                    await Clients.Client(pendingCall.Key).VoiceCallCancelled(connectionId, false);
                }
            }

            AudioRates.TryRemove(connectionId, out _);
            if (VoiceUsers.TryRemove(connectionId, out var transport))
            {
                await Clients.Group(userInfo.Channel).VoiceParticipantLeft(connectionId);
                if (transport == 1) await NotifyHttpsAudioParticipants(userInfo.Channel);
            }
            await RemoveAutomaticVoice(connectionId, userInfo.Channel);

            await Groups.RemoveFromGroupAsync(connectionId, userInfo.Channel);
            await NotifyAll(userInfo.Channel, MessageTypeEnum.Left);
        }

        public Task<List<VoiceParticipant>> JoinVoice()
        {
            var userInfo = GetCurrentUser();
            JoinVoiceTransport(0);
            return Task.FromResult(GetVoiceParticipants(userInfo.Channel, Context.ConnectionId, 0));
        }

        public async Task<List<VoiceParticipant>> JoinHttpsAudioVoice()
        {
            var userInfo = GetCurrentUser();
            JoinVoiceTransport(1);
            await NotifyHttpsAudioParticipants(userInfo.Channel);
            await NotifyAll(userInfo.Channel, MessageTypeEnum.Joined);
            return GetVoiceParticipants(userInfo.Channel, Context.ConnectionId, 1);
        }

        private void JoinVoiceTransport(byte transport)
        {
            VoiceUsers.TryAdd(Context.ConnectionId, transport);
            if (!VoiceUsers.TryGetValue(Context.ConnectionId, out var current) || current != transport)
            {
                throw new HubException("Leave the call before changing audio transport");
            }
        }

        private static List<VoiceParticipant> GetVoiceParticipants(string channel, string currentId, byte transport)
        {
            return VoiceUsers
                .Where(pair => pair.Value == transport && pair.Key != currentId &&
                    AutomaticVoiceUsers.ContainsKey(pair.Key) == AutomaticVoiceUsers.ContainsKey(currentId))
                .Select(pair => Users.TryGetValue(pair.Key, out var user) && user.Channel == channel
                    ? new VoiceParticipant { ConnectionId = pair.Key, Name = GetDisplayName(user) }
                    : null)
                .Where(peer => peer != null)
                .ToList();
        }

        private async Task NotifyHttpsAudioParticipants(string channel)
        {
            foreach (var peer in GetVoiceParticipants(channel, string.Empty, 1))
            {
                await Clients.Client(peer.ConnectionId).HttpsAudioParticipantsChanged(
                    GetVoiceParticipants(channel, peer.ConnectionId, 1));
            }
        }

        public async Task SendHttpsAudio(byte[] frame)
        {
            var user = GetCurrentUser();
            if (!VoiceUsers.TryGetValue(Context.ConnectionId, out var transport) || transport != 1)
            {
                throw new HubException("Join Stealth audio before sending audio frames");
            }

            var window = Environment.TickCount64 / 1000;
            var rate = AudioRates.AddOrUpdate(Context.ConnectionId, (window, 1),
                (_, previous) => previous.Window == window ? (window, previous.Count + 1) : (window, 1));
            if (frame == null || frame.Length != HttpsAudioProtocol.FrameSize || frame[0] != 1 ||
                rate.Count > HttpsAudioProtocol.MaximumFramesPerSecond)
            {
                _logger.LogWarning("Rejected invalid or excessive HTTPS audio from {ConnectionId}", Context.ConnectionId);
                await LeaveVoice();
                await Clients.Caller.HttpsAudioFailed("HTTPS audio stopped: invalid frame or excessive send rate.");
                return;
            }

            foreach (var peer in GetVoiceParticipants(user.Channel, Context.ConnectionId, 1))
            {
                await Clients.Client(peer.ConnectionId).ReceiveHttpsAudio(Context.ConnectionId, frame);
            }
        }

        public async Task<VoiceCallState> JoinAutomaticVoice(VoiceCapabilities capabilities)
        {
            var user = GetCurrentUser();
            if (capabilities == null || (!capabilities.SupportsWebRtc && !capabilities.SupportsHttpsAudio))
                throw new HubException("This browser cannot run encrypted WebRTC or HTTPS audio");
            VoiceCallState result;
            lock (VoiceGate)
            {
                if (VoiceUsers.ContainsKey(Context.ConnectionId))
                    throw new HubException("Leave the current call before joining again");
                AutomaticCalls.TryGetValue(user.Channel, out var previous);
                var https = previous?.HttpsAudio == true || capabilities.ForceStealth || !capabilities.SupportsWebRtc;
                var members = AutomaticMembers(user.Channel);
                if (https && (!capabilities.SupportsHttpsAudio || members.Any(id => !AutomaticVoiceUsers[id].SupportsHttpsAudio)))
                    throw new HubException("Everyone needs an HTTPS-audio-capable browser to switch this call to Stealth");
                var opus = capabilities.SupportsOpus && (previous?.Opus ?? true);
                var revision = ++_voiceRevision;
                AutomaticCalls[user.Channel] = new VoiceCallState
                {
                    Revision = revision,
                    MediaRevision = previous == null || previous.HttpsAudio != https || (https && previous.Opus != opus)
                        ? revision : previous.MediaRevision,
                    HttpsAudio = https,
                    Opus = opus,
                    Reason = previous?.HttpsAudio == true ? previous.Reason
                        : https ? capabilities.ForceStealth
                            ? "A participant requested Stealth audio; the whole call is audio-only."
                            : "A browser needs HTTPS audio; the whole call is audio-only."
                        : "Automatic: using encrypted WebRTC."
                };
                AutomaticVoiceUsers[Context.ConnectionId] = new VoiceCapabilities
                {
                    ForceStealth = capabilities.ForceStealth,
                    SupportsWebRtc = capabilities.SupportsWebRtc,
                    SupportsHttpsAudio = capabilities.SupportsHttpsAudio,
                    SupportsOpus = capabilities.SupportsOpus
                };
                SetAutomaticTransport(user.Channel, https);
                result = AutomaticSnapshot(user.Channel, Context.ConnectionId);
            }
            await NotifyAutomaticCall(user.Channel);
            await NotifyAll(user.Channel, MessageTypeEnum.Joined);
            return result;
        }

        public async Task<VoiceCallState> RequestHttpsAudio(long mediaRevision)
        {
            var user = GetCurrentUser();
            VoiceCallState result;
            lock (VoiceGate)
            {
                if (!AutomaticVoiceUsers.ContainsKey(Context.ConnectionId))
                    throw new HubException("Join the automatic call before requesting fallback");
                var current = AutomaticCalls[user.Channel];
                if (!current.HttpsAudio && current.MediaRevision == mediaRevision)
                {
                    if (AutomaticMembers(user.Channel).Any(id => !AutomaticVoiceUsers[id].SupportsHttpsAudio))
                        throw new HubException("A participant's browser cannot use HTTPS audio");
                    var revision = ++_voiceRevision;
                    AutomaticCalls[user.Channel] = new VoiceCallState
                    {
                        Revision = revision, MediaRevision = revision, HttpsAudio = true, Opus = current.Opus,
                        Reason = "WebRTC media could not connect; the whole call switched to Stealth audio."
                    };
                    SetAutomaticTransport(user.Channel, true);
                }
                result = AutomaticSnapshot(user.Channel, Context.ConnectionId);
            }
            await NotifyAutomaticCall(user.Channel);
            await NotifyAll(user.Channel, MessageTypeEnum.Joined);
            return result;
        }

        private static List<string> AutomaticMembers(string channel) => AutomaticVoiceUsers.Keys
            .Where(id => Users.TryGetValue(id, out var user) && user.Channel == channel).ToList();

        private static void SetAutomaticTransport(string channel, bool https)
        {
            foreach (var id in AutomaticMembers(channel)) VoiceUsers[id] = https ? (byte)1 : (byte)0;
        }

        private static VoiceCallState AutomaticSnapshot(string channel, string id)
        {
            var state = AutomaticCalls[channel];
            return new VoiceCallState
            {
                Revision = state.Revision, MediaRevision = state.MediaRevision,
                HttpsAudio = state.HttpsAudio, Opus = state.Opus, Reason = state.Reason,
                Participants = GetVoiceParticipants(channel, id, state.HttpsAudio ? (byte)1 : (byte)0)
            };
        }

        private async Task NotifyAutomaticCall(string channel)
        {
            List<(string Id, VoiceCallState State)> updates;
            lock (VoiceGate)
            {
                updates = AutomaticMembers(channel).Select(id => (id, AutomaticSnapshot(channel, id))).ToList();
            }
            foreach (var update in updates) await Clients.Client(update.Id).VoiceCallChanged(update.State);
        }

        private async Task RemoveAutomaticVoice(string id, string channel)
        {
            lock (VoiceGate)
            {
                if (!AutomaticVoiceUsers.TryRemove(id, out _)) return;
                VoiceUsers.TryRemove(id, out _);
                if (AutomaticMembers(channel).Count == 0) AutomaticCalls.Remove(channel);
                else AutomaticCalls[channel].Revision = ++_voiceRevision;
            }
            await NotifyAutomaticCall(channel);
        }

        public async Task SendAutomaticAudio(long mediaRevision, byte[] frame)
        {
            var user = GetCurrentUser();
            VoiceCallState state;
            lock (VoiceGate)
            {
                if (!AutomaticVoiceUsers.ContainsKey(Context.ConnectionId))
                    throw new HubException("Join the automatic call before sending audio");
                state = AutomaticCalls[user.Channel];
            }
            var window = Environment.TickCount64 / 1000;
            var rate = AudioRates.AddOrUpdate(Context.ConnectionId, (window, 1),
                (_, previous) => previous.Window == window ? (window, previous.Count + 1) : (window, 1));
            if (rate.Count > HttpsAudioProtocol.MaximumFramesPerSecond || frame == null || frame.Length < 42 ||
                frame.Length > HttpsAudioProtocol.MaximumOpusFrameSize || (frame[0] != 1 && frame[0] != 2) ||
                (state.HttpsAudio && state.MediaRevision == mediaRevision &&
                    (frame[0] != (state.Opus ? 2 : 1) || (!state.Opus && frame.Length != HttpsAudioProtocol.FrameSize))))
            {
                _logger.LogWarning("Rejected invalid or excessive automatic audio from {ConnectionId}", Context.ConnectionId);
                await LeaveVoice();
                await Clients.Caller.HttpsAudioFailed("Stealth audio stopped: invalid frame or excessive send rate.");
                return;
            }
            if (!state.HttpsAudio || state.MediaRevision != mediaRevision)
            {
                _logger.LogDebug("Discarded audio from an obsolete call revision for {ConnectionId}", Context.ConnectionId);
                return;
            }
            foreach (var peer in GetVoiceParticipants(user.Channel, Context.ConnectionId, 1))
                await Clients.Client(peer.ConnectionId).ReceiveAutomaticAudio(mediaRevision, Context.ConnectionId, frame);
        }

        public Task<TurnCredentials> GetTurnCredentials()
        {
            GetCurrentUser();

            var secret = Environment.GetEnvironmentVariable("TURN_SECRET");
            if (string.IsNullOrWhiteSpace(secret))
            {
                throw new HubException("TURN_SECRET is not configured");
            }

            var expires = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds();
            var username = $"{expires}:{Context.ConnectionId}";
            using var hmac = new HMACSHA1(Encoding.UTF8.GetBytes(secret));
            var credential = Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes(username)));
            TurnConfiguration configuration;
            try
            {
                configuration = TurnConfiguration.Load();
            }
            catch (InvalidOperationException exception)
            {
                throw new HubException(exception.Message);
            }

            return Task.FromResult(new TurnCredentials
            {
                Host = configuration.Host,
                Port = configuration.Port,
                TlsOnly = configuration.TlsOnly,
                Username = username,
                Credential = credential,
                RelayOnly = configuration.RelayOnly
            });
        }

        public Task<TurnHealthStatus> CheckTurnHealth()
        {
            GetCurrentUser();
            return _turnHealthChecker.CheckAsync();
        }

        public async Task RingVoice(string targetConnectionId)
        {
            var caller = GetCurrentUser();
            var target = GetUserInSameChannel(targetConnectionId, caller.Channel);
            Debug.Assert(target.Channel == caller.Channel);
            if (targetConnectionId == Context.ConnectionId)
            {
                throw new HubException("Cannot ring the current user");
            }

            if (!PendingVoiceCalls.TryAdd(targetConnectionId, Context.ConnectionId))
            {
                throw new HubException("User already has an incoming call");
            }

            try
            {
                await Clients.Client(targetConnectionId).VoiceCallReceived(Context.ConnectionId, GetDisplayName(caller));
            }
            catch
            {
                TryRemovePendingCall(targetConnectionId, Context.ConnectionId);
                throw;
            }
        }

        public Task CancelVoiceCall(string targetConnectionId, bool timedOut)
        {
            var caller = GetCurrentUser();
            if (!TryRemovePendingCall(targetConnectionId, Context.ConnectionId) ||
                !Users.TryGetValue(targetConnectionId, out var target) ||
                target.Channel != caller.Channel)
            {
                return Task.CompletedTask;
            }

            return Clients.Client(targetConnectionId).VoiceCallCancelled(Context.ConnectionId, timedOut);
        }

        public Task RespondVoiceCall(string callerConnectionId, bool accepted)
        {
            var responder = GetCurrentUser();
            GetUserInSameChannel(callerConnectionId, responder.Channel);
            if (!TryRemovePendingCall(Context.ConnectionId, callerConnectionId))
            {
                throw new HubException("Voice call is no longer pending");
            }

            return Clients.Client(callerConnectionId)
                .VoiceCallResponded(Context.ConnectionId, GetDisplayName(responder), accepted);
        }

        public async Task LeaveVoice()
        {
            var userInfo = GetCurrentUser();
            AudioRates.TryRemove(Context.ConnectionId, out _);
            if (VoiceUsers.TryRemove(Context.ConnectionId, out var transport))
            {
                await Clients.Group(userInfo.Channel).VoiceParticipantLeft(Context.ConnectionId);
                if (transport == 1)
                {
                    await NotifyHttpsAudioParticipants(userInfo.Channel);
                    await NotifyAll(userInfo.Channel, MessageTypeEnum.Left);
                }
            }
            await RemoveAutomaticVoice(Context.ConnectionId, userInfo.Channel);
        }

        public Task SendVoiceOffer(string targetConnectionId, string offer)
        {
            EnsureVoicePeer(targetConnectionId);
            return Clients.Client(targetConnectionId).ReceiveVoiceOffer(Context.ConnectionId, offer);
        }

        public Task SendVoiceAnswer(string targetConnectionId, string answer)
        {
            EnsureVoicePeer(targetConnectionId);
            return Clients.Client(targetConnectionId).ReceiveVoiceAnswer(Context.ConnectionId, answer);
        }

        public Task SendVoiceIceCandidate(string targetConnectionId, string candidate)
        {
            EnsureVoicePeer(targetConnectionId);
            return Clients.Client(targetConnectionId).ReceiveVoiceIceCandidate(Context.ConnectionId, candidate);
        }

        private (string Channel, string Name, string ClientInstanceId, long JoinedOrder) GetCurrentUser()
        {
            if (!Users.TryGetValue(Context.ConnectionId, out var userInfo))
            {
                throw new HubException("SignalR client is not logged-in");
            }

            return userInfo;
        }

        private void EnsureVoicePeer(string targetConnectionId)
        {
            var userInfo = GetCurrentUser();
            if (targetConnectionId == Context.ConnectionId ||
                !VoiceUsers.TryGetValue(Context.ConnectionId, out var sourceTransport) || sourceTransport != 0 ||
                !VoiceUsers.TryGetValue(targetConnectionId, out var targetTransport) || targetTransport != 0 ||
                AutomaticVoiceUsers.ContainsKey(Context.ConnectionId) != AutomaticVoiceUsers.ContainsKey(targetConnectionId) ||
                !Users.TryGetValue(targetConnectionId, out var target) ||
                target.Channel != userInfo.Channel)
            {
                throw new HubException("Voice peer is not in the same channel");
            }
        }

        private static (string Channel, string Name, string ClientInstanceId, long JoinedOrder) GetUserInSameChannel(string connectionId, string channel)
        {
            if (!Users.TryGetValue(connectionId, out var user) || user.Channel != channel)
            {
                throw new HubException("User is not online in the same channel");
            }

            return user;
        }

        private static bool TryRemovePendingCall(string targetConnectionId, string callerConnectionId)
        {
            return ((ICollection<KeyValuePair<string, string>>)PendingVoiceCalls)
                .Remove(new KeyValuePair<string, string>(targetConnectionId, callerConnectionId));
        }

        private static string? ClaimClientConnection(string clientInstanceId, string connectionId)
        {
            while (true)
            {
                if (ClientConnections.TryAdd(clientInstanceId, connectionId))
                {
                    return null;
                }

                var previousConnectionId = ClientConnections[clientInstanceId];
                if (previousConnectionId == connectionId)
                {
                    return null;
                }

                if (ClientConnections.TryUpdate(clientInstanceId, connectionId, previousConnectionId))
                {
                    return previousConnectionId;
                }
            }
        }

        private async Task NotifyAll(string channel, MessageTypeEnum type)
        {
            var users = Users
                .Where(x => x.Value.Channel == channel)
                .OrderByDescending(x => x.Value.JoinedOrder)
                .Select(x => new OnlineUser
                {
                    ConnectionId = x.Key,
                    Name = GetDisplayName(x.Value),
                    HttpsAudio = VoiceUsers.TryGetValue(x.Key, out var transport) && transport == 1
                })
                .ToList();
            
            await Clients.Group(channel).Status(type, users);
        }

        private static string GetDisplayName((string Channel, string Name, string ClientInstanceId, long JoinedOrder) user)
        {
            var duplicateName = Users.Values.Any(other =>
                other.Channel == user.Channel &&
                other.JoinedOrder != user.JoinedOrder &&
                string.Equals(other.Name, user.Name, StringComparison.OrdinalIgnoreCase));
            return duplicateName ? $"{user.Name} (session {user.JoinedOrder})" : user.Name;
        }
    }
}