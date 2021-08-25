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
        // connected IDs
        private static readonly HashSet<string> ConnectedIds = new HashSet<string>();

        private static readonly IDictionary<string, string> Names = new ConcurrentDictionary<string, string>();

        public override async Task OnConnectedAsync()
        {
            ConnectedIds.Add(Context.ConnectionId);
            
            await Clients.All.SendAsync("SendAction", "joined", ConnectedIds.Count, Names.Values.ToList());
        }

        public override async Task OnDisconnectedAsync(Exception ex)
        {
            ConnectedIds.Remove(Context.ConnectionId);
            
            await Clients.All.SendAsync("SendAction", "left", ConnectedIds.Count, Names.Values.ToList());
        }

        public async Task Send(MessagePayload message)
        {
            await Clients.All.SendAsync("SendMessage", message);
        }
        
        public async Task WhoAmi(string name)
        {
            Names[Context.ConnectionId] = name;
        }
    }
}