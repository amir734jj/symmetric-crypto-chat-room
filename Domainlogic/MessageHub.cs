using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;
using Models;
using Models.Hub;

namespace Domainlogic
{
    public class MessageHub : Hub<ITypedClient>, ITypedServer
    {
        private readonly PlaybackLogic _playbackLogic;

        private static readonly ConcurrentDictionary<string, (string Channel, string Name)> Users = new();

        public MessageHub(PlaybackLogic playbackLogic)
        {
            _playbackLogic = playbackLogic;
        }
        
        public override Task OnConnectedAsync()
        {
            return Task.CompletedTask;
        }

        public override async Task OnDisconnectedAsync(Exception ex)
        {
            if (Users.TryGetValue(Context.ConnectionId, out var userInfo))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, userInfo.Channel);

                Users.Remove(Context.ConnectionId, out _);
            
                await NotifyAll(userInfo.Channel, MessageTypeEnum.Left);
            }
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
            
            await NotifyAll(message.Channel, MessageTypeEnum.Status);
        }
        
        public async Task Join(string channel, string name)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, channel);

            Users.TryAdd(Context.ConnectionId, (channel, name));
            
            await NotifyAll(channel, MessageTypeEnum.Joined);
            
            foreach (var messagePayload in _playbackLogic.GetMessages(channel))
            {
                await Clients.Client(Context.ConnectionId).Inbox(messagePayload);
            }
        }

        private async Task NotifyAll(string channel, MessageTypeEnum type)
        {
            var users = Users
                .Where(x => x.Value.Channel == channel)
                .Select(x => x.Value.Name)
                .ToList();
            
            await Clients.Group(channel).Status(type, users);
        }
    }
}