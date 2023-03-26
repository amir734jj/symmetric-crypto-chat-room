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

    public EventHandler? OnChange { get; set; }

    private readonly HubConnection _hubConnection;

    private readonly ISyncSessionStorageService _sessionStorageService;
    
    private readonly PayloadEncryptionService _payloadEncryptionService;

    private readonly ILogger<SignalRClientState> _logger;

    // ReSharper disable once InconsistentNaming
    private const string SESSION_KEY = "SYMMETRIC_CRYPTO_SESSION_KEY";

    /// <summary>
    /// This is needed because calling async initialize in constructor is not supported in blazor
    /// And IsLoggedIn prematurely says user is not logged in. This way we make sure we get is
    /// logged in result when initialize has finished.
    /// </summary>
    private State _state;

    private enum State
    {
        Uninitialized, Initialized, Initializing, Failed
    }
    
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

        _state = State.Uninitialized;
    }

    public async Task Initialize()
    {
        // Short circuit if already initialized
        if (_state is State.Initializing or State.Initialized)
        {
            _logger.LogTrace("SignalRClientState cannot be initialized with current state: {}.", _state);
            
            // Until while initializing
            while (_state == State.Initializing) 
            {
                await Task.Delay(1);
            }
            
            return;
        }
        
        _state = State.Initializing;

        _logger.LogTrace("Initializing SignalRClientState.");

        try
        {
            _hubConnection.On("SendAction", new Action<string, int, List<string>>(SendActionHandler));
            _hubConnection.On("SendMessage", new Action<MessagePayload>(SendMessageHandler));

            await _hubConnection.StartAsync();

            if (_sessionStorageService.ContainKey(SESSION_KEY))
            {
                await Login(_sessionStorageService.GetItem<LoginViewModel>(SESSION_KEY));
            }

            OnChange += (_, _) => { _logger.LogTrace("SignalR client session change occured."); };

            _logger.LogTrace("Successfully initialized SignalRClientState.");

            _state = State.Initialized;
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Failed to initialize SignalRClientState");

            _state = State.Failed;
        }
    }

    private void SendActionHandler(string _, int count, List<string> names)
    {
        Count = count;
        Names = names;
        
        OnChange?.Invoke(this, EventArgs.Empty);
    }

    private void SendMessageHandler(MessagePayload payload)
    {
        var isValid = _payloadEncryptionService.PayloadIsValid(UserInfo!.Password, payload.Token);
        
        // If message is valid then decrypt, otherwise don't bother
        if (isValid)
        {
            payload = _payloadEncryptionService.DecryptPayload(UserInfo!.Password, payload);
        }

        Messages.AddFirst((payload, isValid));

        // To make sure it list doesn't get too large and consume a lot of memory
        if (Messages.Count > 15)
        {
            Messages.RemoveLast();
        }
        
        OnChange?.Invoke(this, EventArgs.Empty);
    }

    public async Task Login(LoginViewModel? login)
    {
        UserInfo = login;
        
        _sessionStorageService.SetItem(SESSION_KEY, login);
        
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