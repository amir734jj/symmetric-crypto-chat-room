using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;
using Models;
using Models.Hub;

namespace Domainlogic
{
    public class MessageHub : Hub<ITypedClient>, ITypedServer
    {
        private readonly PlaybackLogic _playbackLogic;

        private readonly TurnHealthChecker _turnHealthChecker;

        private static readonly ConcurrentDictionary<string, (string Channel, string Name)> Users = new();

        private static readonly ConcurrentDictionary<string, byte> VoiceUsers = new();

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
        
        public async Task Join(string channel, string name)
        {
            await JoinRoom(channel, name);

            foreach (var messagePayload in _playbackLogic.GetMessages(channel))
            {
                await Clients.Client(Context.ConnectionId).Inbox(messagePayload);
            }
        }

        public Task Rejoin(string channel, string name)
        {
            return JoinRoom(channel, name);
        }

        private async Task JoinRoom(string channel, string name)
        {
            await Leave();

            await Groups.AddToGroupAsync(Context.ConnectionId, channel);

            Users[Context.ConnectionId] = (channel, name);
            
            await NotifyAll(channel, MessageTypeEnum.Joined);
        }

        public async Task Leave()
        {
            if (!Users.TryRemove(Context.ConnectionId, out var userInfo))
            {
                return;
            }

            if (VoiceUsers.TryRemove(Context.ConnectionId, out _))
            {
                await Clients.Group(userInfo.Channel).VoiceParticipantLeft(Context.ConnectionId);
            }

            await Groups.RemoveFromGroupAsync(Context.ConnectionId, userInfo.Channel);
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

        public Task RingVoice(string targetConnectionId)
        {
            var caller = GetCurrentUser();
            var target = GetUserInSameChannel(targetConnectionId, caller.Channel);
            Debug.Assert(target.Channel == caller.Channel);
            if (targetConnectionId == Context.ConnectionId)
            {
                throw new HubException("Cannot ring the current user");
            }

            return Clients.Client(targetConnectionId).VoiceCallReceived(Context.ConnectionId, caller.Name);
        }

        public Task RespondVoiceCall(string callerConnectionId, bool accepted)
        {
            var responder = GetCurrentUser();
            GetUserInSameChannel(callerConnectionId, responder.Channel);
            return Clients.Client(callerConnectionId).VoiceCallResponded(responder.Name, accepted);
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

        private (string Channel, string Name) GetCurrentUser()
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

        private static (string Channel, string Name) GetUserInSameChannel(string connectionId, string channel)
        {
            if (!Users.TryGetValue(connectionId, out var user) || user.Channel != channel)
            {
                throw new HubException("User is not online in the same channel");
            }

            return user;
        }

        private async Task NotifyAll(string channel, MessageTypeEnum type)
        {
            var users = Users
                .Where(x => x.Value.Channel == channel)
                .Select(x => new OnlineUser
                {
                    ConnectionId = x.Key,
                    Name = x.Value.Name
                })
                .ToList();
            
            await Clients.Group(channel).Status(type, users);
        }
    }
}