using System.ComponentModel;
using System.Reactive.Linq;
using System.Security.Claims;
using Blazored.SessionStorage;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.SignalR.Client;
using Models;
using Models.Hub;
using Models.ViewModels;
using ReactiveUI;
using TypedSignalR.Client;

namespace UI;

public sealed class SignalRStateManager : AuthenticationStateProvider, IDisposable, ITypedClient
{
    private readonly ISyncSessionStorageService _sessionStorageService;
    
    private readonly PayloadEncryptionService _payloadEncryptionService;
    
    private readonly NavigationManager _navigation;

    private readonly ILogger<SignalRStateManager> _logger;

    // ReSharper disable once InconsistentNaming
    private const string SESSION_KEY = "SYMMETRIC_CRYPTO_SESSION_KEY";

    private readonly State _state;
    private readonly ITypedServer _server;
    private readonly HubConnection _hubConnection;

    public SignalRStateManager(
        HubConnection hubConnection,
        State state,
        ISyncSessionStorageService sessionStorageService,
        PayloadEncryptionService payloadEncryptionService,
        NavigationManager navigation,
        ILogger<SignalRStateManager> logger)
    {
        _hubConnection = hubConnection;
        _sessionStorageService = sessionStorageService;
        _payloadEncryptionService = payloadEncryptionService;
        _navigation = navigation;
        _logger = logger;
        _state = state;

        _state.PropertyChanged += StateChangedHandler;
        
        this.WhenAnyValue(x => x._state.StateEnum)
            .Throttle(TimeSpan.FromSeconds(1), RxApp.TaskpoolScheduler)
            .Where(x => x.HasFlag(SignalRStateEnum.Uninitialized))
            .ObserveOn(RxApp.MainThreadScheduler)
            .InvokeCommand(ReactiveCommand.CreateFromTask(Initialize));
        
        _server = hubConnection.CreateHubProxy<ITypedServer>();
        hubConnection.Register<ITypedClient>(this);
    }

    private void StateChangedHandler(object? source, PropertyChangedEventArgs eventArgs)
    {
        _logger.LogTrace("State property {} changed, state: {}", eventArgs.PropertyName, _state.StateEnum);
    }
    
    public async Task Initialize()
    {
        // Short circuit if already initialized
        if (_state.StateEnum.HasFlag(SignalRStateEnum.Initializing) || _state.StateEnum.HasFlag(SignalRStateEnum.Initialized))
        {
            _logger.LogTrace("SignalRClientState cannot be initialized with current state: {}", _state.StateEnum);
            
            // Until while initializing
            while (_state.StateEnum.HasFlag(SignalRStateEnum.Initializing)) 
            {
                await Task.Delay(1);
            }
            
            return;
        }
                
        _state.StateEnum = SignalRStateEnum.Initializing;

        _logger.LogTrace("Initializing SignalRClientState");

        try
        {
            await _hubConnection.StartAsync();
            
            _state.StateEnum = SignalRStateEnum.Initialized;

            if (_sessionStorageService.ContainKey(SESSION_KEY))
            {
                await Login(_sessionStorageService.GetItem<LoginViewModel>(SESSION_KEY));
                
                _navigation.NavigateTo("/Chat");
            }

            _logger.LogTrace("Successfully initialized SignalRClientState");
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Failed to initialize SignalRClientState");

            _state.StateEnum = SignalRStateEnum.Failed;
        }
    }

    public async Task Login(LoginViewModel login)
    {
        while (!_hubConnection.State.HasFlag(HubConnectionState.Connected))
        {
            await Task.Delay(1);
        }
        
        _state.UserInfo = login;
        
        _sessionStorageService.SetItem(SESSION_KEY, login);
        
        await _server.Join(login.Channel, login.Name);
        
        NotifyAuthenticationStateChanged(GetAuthenticationStateAsync());
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
    }

    public async Task Send(MessagePayload messagePayload)
    {
        while (!_hubConnection.State.HasFlag(HubConnectionState.Connected))
        {
            await Task.Delay(1);
        }
        
        _state.StateEnum |= SignalRStateEnum.Sending;

        await _server.Send(_payloadEncryptionService.EncryptPayload(_state.UserInfo!.Password, messagePayload));

        _state.StateEnum &= ~SignalRStateEnum.Sending;
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

    public void Dispose()
    {
        _state.PropertyChanged -= StateChangedHandler;
    }

    public Task Inbox(MessagePayload messagePayload)
    {
        _state.StateEnum |= SignalRStateEnum.Receiving;   
        
        var isValid = _payloadEncryptionService.PayloadIsValid(_state.UserInfo!.Password, messagePayload.Token);
        
        // If message is valid then decrypt, otherwise don't bother
        if (isValid)
        {
            messagePayload = _payloadEncryptionService.DecryptPayload(_state.UserInfo!.Password, messagePayload);
        }

        _state.Messages.AddFirst((messagePayload, isValid));

        // To make sure it list doesn't get too large and consume a lot of memory
        if (_state.Messages.Count > 15)
        {
            _state.Messages.RemoveLast();
        }

        _state.StateEnum &= ~SignalRStateEnum.Receiving;

        return Task.CompletedTask;
    }

    public Task Status(MessageTypeEnum messageTypeEnum, List<string> names)
    {
        _state.Names = names;

        return Task.CompletedTask;
    }
}