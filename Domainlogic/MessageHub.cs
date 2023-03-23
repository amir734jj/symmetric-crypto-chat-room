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
        private static readonly HashSet<string> ConnectedIds = new HashSet<string>();

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

            await Clients.All.SendAsync("SendAction", "joined", ConnectedIds.Count, Names.Values.ToList());
        }

        public override async Task OnDisconnectedAsync(Exception ex)
        {
            ConnectedIds.Remove(Context.ConnectionId);
            Names.Remove(Context.ConnectionId);

            await Clients.All.SendAsync("SendAction", "left", ConnectedIds.Count, Names.Values.ToList());
        }

        public async Task Send(MessagePayload message)
        {
            _playbackLogic.RecordMessage(message);
            
            await Clients.All.SendAsync("SendMessage", message);
        }
        
        public void WhoAmi(string name)
        {
            Names[Context.ConnectionId] = name;
        }
    }
}