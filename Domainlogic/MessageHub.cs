using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;
using Models;

namespace Domainlogic
{
    public class MessageHub : Hub
    {
        private readonly PlaybackLogic _playbackLogic;

        // connected IDs
        private static readonly HashSet<string> ConnectedIds = new();

        private static readonly IDictionary<string, string> Names = new ConcurrentDictionary<string, string>();

        public MessageHub(PlaybackLogic playbackLogic)
        {
            _playbackLogic = playbackLogic;
        }
        
        public override async Task OnConnectedAsync()
        {
            ConnectedIds.Add(Context.ConnectionId);
            
            foreach (var messagePayload in _playbackLogic.GetMessages())
            {
                await Clients.Client(Context.ConnectionId).SendAsync("SendMessage", messagePayload);
            }
            
            await NotifyAll(MessageTypeEnum.Joined);
        }

        public override async Task OnDisconnectedAsync(Exception ex)
        {
            ConnectedIds.Remove(Context.ConnectionId);
            Names.Remove(Context.ConnectionId);
            
            await NotifyAll(MessageTypeEnum.Left);
        }

        public async Task Send(MessagePayload message)
        {
            _playbackLogic.RecordMessage(message);
            
            await Clients.All.SendAsync("SendMessage", message);
        }
        
        public async Task WhoAmi(string name)
        {
            Names[Context.ConnectionId] = name;

            await NotifyAll(MessageTypeEnum.Status);
        }

        private async Task NotifyAll(MessageTypeEnum type)
        {
            await Clients.All.SendAsync("SendAction", type.ToString(), ConnectedIds.Count, Names.Values.ToList());
        }
    }
}