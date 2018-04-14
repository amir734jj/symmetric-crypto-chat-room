using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;

namespace Models
{
    public class MessageHub : Hub
    {
        public override async Task OnConnectedAsync()
        {
            await Clients.All.SendAsync("SendAction", "joined");
        }

        public override async Task OnDisconnectedAsync(Exception ex)
        {
            await Clients.All.SendAsync("SendAction", "left");
        }

        public async Task Send(MessagePayload message)
        {
            await Clients.All.SendAsync("SendMessage", message);
        }
    }
}