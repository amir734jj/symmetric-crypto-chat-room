using System.Security.Claims;
using Blazored.SessionStorage;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.SignalR.Client;
using Models;
using Models.ViewModels;

namespace UI;

public class SignalRClientState : AuthenticationStateProvider
{
    public LinkedList<(MessagePayload messagePayload, bool valid)> Messages { get; }

    public int Count { get; set; }

    public List<string> Names { get; set; }

    public LoginViewModel? UserInfo { get; set; }

    public EventHandler OnChange { get; set; }

    private readonly HubConnection _hubConnection;

    private readonly ISyncSessionStorageService _sessionStorageService;
    
    private readonly PayloadEncryptionService _payloadEncryptionService;

    private readonly ILogger<SignalRClientState> _logger;

    public SignalRClientState(
        HubConnection hubConnection,
        ISyncSessionStorageService sessionStorageService,
        PayloadEncryptionService payloadEncryptionService,
        ILogger<SignalRClientState> logger)
    {
        _hubConnection = hubConnection;
        _sessionStorageService = sessionStorageService;
        _payloadEncryptionService = payloadEncryptionService;
        _logger = logger;

        Messages = new LinkedList<(MessagePayload messagePayload, bool valid)>();
        Names = new List<string>();
        Count = 0;
        UserInfo = null;

        Initialize();
    }

    private async Task Initialize()
    {
        _hubConnection.On("SendAction", new Action<string, int, List<string>>(SendActionHandler));
        _hubConnection.On("SendMessage", new Action<MessagePayload>(SendMessageHandler));

        await _hubConnection.StartAsync();

        if (_sessionStorageService.ContainKey("IDENTITY"))
        {
            await Login(_sessionStorageService.GetItem<LoginViewModel>("IDENTITY"));
        }

        OnChange += (_, _) =>
        {
            _logger.LogTrace("Change occured");
        };
    }

    private void SendActionHandler(string _, int count, List<string> names)
    {
        Count = count;
        Names = names;
        
        OnChange.Invoke(this, EventArgs.Empty);
    }

    private void SendMessageHandler(MessagePayload payload)
    {
        Messages.AddFirst((_payloadEncryptionService.DecryptPayload(UserInfo!.Password, payload), _payloadEncryptionService.PayloadIsValid(payload)));
        
        OnChange.Invoke(this, EventArgs.Empty);
    }

    public async Task Login(LoginViewModel? login)
    {
        UserInfo = login;
        
        _sessionStorageService.SetItem("IDENTITY", login);
        
        await _hubConnection.SendAsync("WhoAmi", login!.Name);
        
        NotifyAuthenticationStateChanged(GetAuthenticationStateAsync());
    }

    public bool IsLoggedIn()
    {
        return UserInfo != null;
    }

    public void Logout()
    {
        UserInfo = null;
        
        NotifyAuthenticationStateChanged(GetAuthenticationStateAsync());
    }

    public async Task Send(MessagePayload messagePayload)
    {
        await _hubConnection.SendAsync("Send", _payloadEncryptionService.EncryptPayload(UserInfo!.Password, messagePayload));
    }

    public override Task<AuthenticationState> GetAuthenticationStateAsync()
    {
        var identity = new ClaimsIdentity();

        // ReSharper disable once InvertIf
        if (IsLoggedIn())
        {
            var claims = new[] { new Claim(ClaimTypes.Name, UserInfo!.Name) };
            identity = new ClaimsIdentity(claims, "Server authentication");
        }

        return Task.FromResult(new AuthenticationState(new ClaimsPrincipal(identity)));
    }
}