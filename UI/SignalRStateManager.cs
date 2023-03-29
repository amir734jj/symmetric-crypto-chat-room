using System.Security.Claims;
using Blazored.SessionStorage;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.SignalR.Client;
using Models;
using Models.ViewModels;

namespace UI;

public class SignalRStateManager : AuthenticationStateProvider
{
    public EventHandler? OnChange { get; set; }

    private readonly HubConnection _hubConnection;

    private readonly ISyncSessionStorageService _sessionStorageService;
    
    private readonly PayloadEncryptionService _payloadEncryptionService;

    private readonly ILogger<SignalRStateManager> _logger;

    // ReSharper disable once InconsistentNaming
    private const string SESSION_KEY = "SYMMETRIC_CRYPTO_SESSION_KEY";

    private readonly State _state;

    public bool IsLoading()
    {
        return _state.StateEnum.HasFlag(SignalRStateEnum.Initializing) ||
               _state.StateEnum.HasFlag(SignalRStateEnum.Sending) ||
               _state.StateEnum.HasFlag(SignalRStateEnum.Receiving);
    }
    
    public SignalRStateManager(
        HubConnection hubConnection,
        State state,
        ISyncSessionStorageService sessionStorageService,
        PayloadEncryptionService payloadEncryptionService,
        ILogger<SignalRStateManager> logger)
    {
        _hubConnection = hubConnection;
        _sessionStorageService = sessionStorageService;
        _payloadEncryptionService = payloadEncryptionService;
        _logger = logger;
        
        _state = state;
    }

    public async Task Initialize()
    {
        // Short circuit if already initialized
        if (_state.StateEnum is SignalRStateEnum.Initializing or SignalRStateEnum.Initialized)
        {
            _logger.LogTrace("SignalRClientState cannot be initialized with current state: {}.", _state);
            
            // Until while initializing
            while (_state.StateEnum == SignalRStateEnum.Initializing) 
            {
                await Task.Delay(1);
            }
            
            return;
        }
                
        _state.StateEnum = SignalRStateEnum.Initializing;
                
        OnChange?.Invoke(this, EventArgs.Empty);

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

            _state.StateEnum = SignalRStateEnum.Initialized;
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Failed to initialize SignalRClientState");

            _state.StateEnum = SignalRStateEnum.Failed;
        }
        
        OnChange?.Invoke(this, EventArgs.Empty);
    }

    private void SendActionHandler(string _, int count, List<string> names)
    {
        _state.Count = count;
        _state.Names = names;
        
        OnChange?.Invoke(this, EventArgs.Empty);
    }

    private void SendMessageHandler(MessagePayload payload)
    {
        _state.StateEnum |= SignalRStateEnum.Receiving;        
        
        OnChange?.Invoke(this, EventArgs.Empty);
        
        var isValid = _payloadEncryptionService.PayloadIsValid(_state.UserInfo!.Password, payload.Token);
        
        // If message is valid then decrypt, otherwise don't bother
        if (isValid)
        {
            payload = _payloadEncryptionService.DecryptPayload(_state.UserInfo!.Password, payload);
        }

        _state.Messages.AddFirst((payload, isValid));

        // To make sure it list doesn't get too large and consume a lot of memory
        if (_state.Messages.Count > 15)
        {
            _state.Messages.RemoveLast();
        }

        _state.StateEnum &= ~SignalRStateEnum.Receiving;
        
        OnChange?.Invoke(this, EventArgs.Empty);
    }

    public async Task Login(LoginViewModel? login)
    {
        _state.UserInfo = login;
        
        _sessionStorageService.SetItem(SESSION_KEY, login);
        
        await _hubConnection.SendAsync("WhoAmi", login!.Name);
        
        NotifyAuthenticationStateChanged(GetAuthenticationStateAsync());     
        
        OnChange?.Invoke(this, EventArgs.Empty);
    }

    public bool IsLoggedIn()
    {
        return _state.UserInfo != null;
    }

    public void Logout()
    {
        _state.UserInfo = null;
        
        _sessionStorageService.RemoveItem(SESSION_KEY);

        NotifyAuthenticationStateChanged(GetAuthenticationStateAsync());
        
        OnChange?.Invoke(this, EventArgs.Empty);
    }

    public async Task Send(MessagePayload messagePayload)
    {
        _state.StateEnum |= SignalRStateEnum.Sending;
        
        OnChange?.Invoke(this, EventArgs.Empty);

        await _hubConnection.SendAsync("Send", _payloadEncryptionService.EncryptPayload(_state.UserInfo!.Password, messagePayload));

        _state.StateEnum &= ~SignalRStateEnum.Sending;        
        
        OnChange?.Invoke(this, EventArgs.Empty);
    }

    public override Task<AuthenticationState> GetAuthenticationStateAsync()
    {
        var identity = new ClaimsIdentity();

        // ReSharper disable once InvertIf
        if (IsLoggedIn())
        {
            var claims = new[] { new Claim(ClaimTypes.Name, _state.UserInfo!.Name) };
            identity = new ClaimsIdentity(claims, "Server authentication");
        }

        return Task.FromResult(new AuthenticationState(new ClaimsPrincipal(identity)));
    }
}