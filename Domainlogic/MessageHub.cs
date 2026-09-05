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
using Models;
using Models.Hub;

namespace DomainLogic
{
    public class MessageHub : Hub<ITypedClient>, ITypedServer
    {
        private readonly PlaybackLogic _playbackLogic;

        private readonly TurnHealthChecker _turnHealthChecker;

        private static readonly ConcurrentDictionary<string, (string Channel, string Name, string ClientInstanceId, long JoinedOrder)> Users = new();

        private static readonly ConcurrentDictionary<string, string> ClientConnections = new();

        private static readonly ConcurrentDictionary<string, (string Channel, string Name, string ClientInstanceId, long JoinedOrder)> BackgroundUsers = new();

        private static readonly ConcurrentDictionary<string, string> BackgroundClientConnections = new();

        private static long _joinedOrder;

        private static readonly ConcurrentDictionary<string, byte> VoiceUsers = new();

        private static readonly ConcurrentDictionary<string, string> PendingVoiceCalls = new();

        public MessageHub(PlaybackLogic playbackLogic, TurnHealthChecker turnHealthChecker)
        {
            _playbackLogic = playbackLogic;
            _turnHealthChecker = turnHealthChecker;
        }
        
        public override Task OnConnectedAsync()
        {
            return Task.CompletedTask;
        }

        public override async Task OnDisconnectedAsync(Exception ex)
        {
            await Leave();
            await RemoveBackgroundConnection(Context.ConnectionId);
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

        public async Task RegisterBackground(string channel, string name, string clientInstanceId)
        {
            ValidateClientInstanceId(clientInstanceId);
            await RemoveBackgroundConnection(Context.ConnectionId);

            var staleConnectionId = ClaimClientConnection(
                BackgroundClientConnections,
                clientInstanceId,
                Context.ConnectionId);
            if (staleConnectionId != null)
            {
                await RemoveBackgroundConnection(staleConnectionId);
            }

            BackgroundUsers[Context.ConnectionId] = (
                channel,
                name,
                clientInstanceId,
                Interlocked.Increment(ref _joinedOrder));
            await NotifyAll(channel, MessageTypeEnum.Joined);
        }

        public Task UnregisterBackground()
        {
            return RemoveBackgroundConnection(Context.ConnectionId);
        }

        private async Task JoinRoom(string channel, string name, string clientInstanceId)
        {
            ValidateClientInstanceId(clientInstanceId);

            await Leave();

            var staleConnectionId = ClaimClientConnection(ClientConnections, clientInstanceId, Context.ConnectionId);
            if (staleConnectionId != null)
            {
                await RemoveConnection(staleConnectionId);
            }

            await Groups.AddToGroupAsync(Context.ConnectionId, channel);

            Users[Context.ConnectionId] = (channel, name, clientInstanceId, Interlocked.Increment(ref _joinedOrder));

            await TransferPendingCallToForeground(channel, clientInstanceId);
            await NotifyAll(channel, MessageTypeEnum.Joined);
        }

        public Task Leave()
        {
            return RemoveConnection(Context.ConnectionId);
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
                    .VoiceCallResponded(connectionId, userInfo.Name, false);
            }

            foreach (var pendingCall in PendingVoiceCalls.Where(call => call.Value == connectionId))
            {
                if (TryRemovePendingCall(pendingCall.Key, connectionId))
                {
                    await Clients.Client(pendingCall.Key).VoiceCallCancelled(connectionId, false);
                }
            }

            if (VoiceUsers.TryRemove(connectionId, out _))
            {
                await Clients.Group(userInfo.Channel).VoiceParticipantLeft(connectionId);
            }

            await Groups.RemoveFromGroupAsync(connectionId, userInfo.Channel);
            await NotifyAll(userInfo.Channel, MessageTypeEnum.Left);
        }

        private async Task RemoveBackgroundConnection(string connectionId)
        {
            if (!BackgroundUsers.TryRemove(connectionId, out var userInfo))
            {
                return;
            }

            ((ICollection<KeyValuePair<string, string>>)BackgroundClientConnections)
                .Remove(new KeyValuePair<string, string>(userInfo.ClientInstanceId, connectionId));

            if (PendingVoiceCalls.TryRemove(connectionId, out var callerConnectionId))
            {
                await Clients.Client(callerConnectionId)
                    .VoiceCallResponded(connectionId, userInfo.Name, false);
            }

            await NotifyAll(userInfo.Channel, MessageTypeEnum.Left);
        }

        public Task<List<VoiceParticipant>> JoinVoice()
        {
            var userInfo = GetCurrentUser();
            VoiceUsers.TryAdd(Context.ConnectionId, 0);

            var participants = VoiceUsers.Keys
                .Where(connectionId => connectionId != Context.ConnectionId)
                .Where(connectionId => Users.TryGetValue(connectionId, out var peer) && peer.Channel == userInfo.Channel)
                .Select(connectionId => new VoiceParticipant
                {
                    ConnectionId = connectionId,
                    Name = Users[connectionId].Name
                })
                .ToList();

            return Task.FromResult(participants);
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
            var relayOnlySetting = Environment.GetEnvironmentVariable("TURN_RELAY_ONLY");
            var relayOnly = !bool.TryParse(relayOnlySetting, out var configuredRelayOnly) || configuredRelayOnly;

            return Task.FromResult(new TurnCredentials
            {
                Host = Environment.GetEnvironmentVariable("TURN_HOST") ?? string.Empty,
                Username = username,
                Credential = credential,
                RelayOnly = relayOnly
            });
        }

        public Task<TurnHealthStatus> CheckTurnHealth()
        {
            GetCurrentUser();
            return _turnHealthChecker.CheckAsync();
        }

        public async Task<string> RingVoice(string targetClientInstanceId)
        {
            var caller = GetCurrentUser();
            var targetConnectionId = ResolveClientConnection(targetClientInstanceId, caller.Channel);
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
                await Clients.Client(targetConnectionId).VoiceCallReceived(Context.ConnectionId, caller.Name);
            }
            catch
            {
                TryRemovePendingCall(targetConnectionId, Context.ConnectionId);
                throw;
            }

            return targetConnectionId;
        }

        public Task CancelVoiceCall(string targetConnectionId, bool timedOut)
        {
            var caller = GetCurrentUser();
            if (!TryRemovePendingCall(targetConnectionId, Context.ConnectionId) ||
                !TryGetUser(targetConnectionId, out var target) ||
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
                .VoiceCallResponded(Context.ConnectionId, responder.Name, accepted);
        }

        public async Task LeaveVoice()
        {
            var userInfo = GetCurrentUser();
            if (VoiceUsers.TryRemove(Context.ConnectionId, out _))
            {
                await Clients.Group(userInfo.Channel).VoiceParticipantLeft(Context.ConnectionId);
            }
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
            if (!VoiceUsers.ContainsKey(Context.ConnectionId) ||
                !VoiceUsers.ContainsKey(targetConnectionId) ||
                !Users.TryGetValue(targetConnectionId, out var target) ||
                target.Channel != userInfo.Channel)
            {
                throw new HubException("Voice peer is not in the same channel");
            }
        }

        private static (string Channel, string Name, string ClientInstanceId, long JoinedOrder) GetUserInSameChannel(string connectionId, string channel)
        {
            if (!TryGetUser(connectionId, out var user) || user.Channel != channel)
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

        private static bool TryGetUser(
            string connectionId,
            out (string Channel, string Name, string ClientInstanceId, long JoinedOrder) user)
        {
            return Users.TryGetValue(connectionId, out user) ||
                BackgroundUsers.TryGetValue(connectionId, out user);
        }

        private static string ResolveClientConnection(string clientInstanceId, string channel)
        {
            if (ClientConnections.TryGetValue(clientInstanceId, out var foregroundConnectionId) &&
                Users.TryGetValue(foregroundConnectionId, out var foregroundUser) &&
                foregroundUser.Channel == channel)
            {
                return foregroundConnectionId;
            }

            if (BackgroundClientConnections.TryGetValue(clientInstanceId, out var backgroundConnectionId) &&
                BackgroundUsers.TryGetValue(backgroundConnectionId, out var backgroundUser) &&
                backgroundUser.Channel == channel)
            {
                return backgroundConnectionId;
            }

            if (TryGetUser(clientInstanceId, out var legacyUser) && legacyUser.Channel == channel)
            {
                return clientInstanceId;
            }

            throw new HubException("User is not online in the same channel");
        }

        private static string ClaimClientConnection(
            ConcurrentDictionary<string, string> connections,
            string clientInstanceId,
            string connectionId)
        {
            while (true)
            {
                if (connections.TryAdd(clientInstanceId, connectionId))
                {
                    return null;
                }

                var previousConnectionId = connections[clientInstanceId];
                if (previousConnectionId == connectionId)
                {
                    return null;
                }

                if (connections.TryUpdate(clientInstanceId, connectionId, previousConnectionId))
                {
                    return previousConnectionId;
                }
            }
        }

        private async Task TransferPendingCallToForeground(string channel, string clientInstanceId)
        {
            var backgroundConnectionId = BackgroundUsers
                .Where(user => user.Value.Channel == channel && user.Value.ClientInstanceId == clientInstanceId)
                .Select(user => user.Key)
                .FirstOrDefault();
            if (backgroundConnectionId == null ||
                !PendingVoiceCalls.TryRemove(backgroundConnectionId, out var callerConnectionId))
            {
                return;
            }

            if (!PendingVoiceCalls.TryAdd(Context.ConnectionId, callerConnectionId) ||
                !Users.TryGetValue(callerConnectionId, out var caller))
            {
                await Clients.Client(callerConnectionId)
                    .VoiceCallResponded(backgroundConnectionId, Users[Context.ConnectionId].Name, false);
                return;
            }

            await Clients.Client(backgroundConnectionId)
                .VoiceCallCancelled(callerConnectionId, false);
            await Clients.Client(Context.ConnectionId)
                .VoiceCallReceived(callerConnectionId, caller.Name);
        }

        private static void ValidateClientInstanceId(string clientInstanceId)
        {
            if (string.IsNullOrWhiteSpace(clientInstanceId) || clientInstanceId.Length > 128)
            {
                throw new HubException("Client instance ID is invalid");
            }
        }

        private async Task NotifyAll(string channel, MessageTypeEnum type)
        {
            var foregroundClientIds = Users
                .Where(user => user.Value.Channel == channel)
                .Select(user => user.Value.ClientInstanceId)
                .ToHashSet();
            var users = Users
                .Where(x => x.Value.Channel == channel)
                .Select(x => new { ConnectionId = x.Key, x.Value.ClientInstanceId, x.Value.Name, x.Value.JoinedOrder })
                .Concat(BackgroundUsers
                    .Where(x => x.Value.Channel == channel && !foregroundClientIds.Contains(x.Value.ClientInstanceId))
                    .Select(x => new { ConnectionId = x.Key, x.Value.ClientInstanceId, x.Value.Name, x.Value.JoinedOrder }))
                .OrderByDescending(x => x.JoinedOrder)
                .Select(x => new OnlineUser
                {
                    ConnectionId = x.ConnectionId,
                    ClientInstanceId = x.ClientInstanceId,
                    Name = x.Name
                })
                .ToList();
            
            await Clients.Group(channel).Status(type, users);
        }
    }
}