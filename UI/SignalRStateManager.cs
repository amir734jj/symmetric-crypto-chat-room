using System.ComponentModel;
using System.Security.Claims;
using Blazored.SessionStorage;
using CaseExtensions;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.SignalR.Client;
using Models;
using Models.Hub;
using Models.ViewModels;
using TypedSignalR.Client;

namespace UI;

public sealed class SignalRStateManager : AuthenticationStateProvider, IDisposable, ITypedClient
{
    private const string VoiceModulePath = "./js/voice-chat.js?v=20260905-4";

    public event Func<string, string, Task>? VoiceOfferReceived;
    public event Func<string, string, Task>? VoiceAnswerReceived;
    public event Func<string, string, Task>? VoiceIceCandidateReceived;
    public event Func<string, Task>? VoiceParticipantLeftReceived;
    public event Func<string, string, Task>? VoiceCallReceivedEvent;
    public event Func<string, bool, Task>? VoiceCallCancelledEvent;
    public event Func<string, string, bool, Task>? VoiceCallRespondedEvent;
    public event Func<Task>? ConnectionReconnected;
    public event Func<Task>? PresenceChanged;

    public string? ConnectionId => _hubConnection.ConnectionId;

    private readonly ISyncSessionStorageService _sessionStorageService;
    
    private readonly PayloadEncryptionService _payloadEncryptionService;
    
    private readonly NavigationManager _navigation;

    private readonly ILogger<SignalRStateManager> _logger;

    private readonly IJSRuntime _jsRuntime;

    private IJSObjectReference? _voiceModule;

    // ReSharper disable once InconsistentNaming
    private const string SESSION_KEY = "SYMMETRIC_CRYPTO_SESSION_KEY";

    private const string CLIENT_INSTANCE_ID_KEY = "SYMMETRIC_CRYPTO_CLIENT_INSTANCE_ID";

    private readonly State _state;
    private readonly ITypedServer _server;
    private readonly HubConnection _hubConnection;
    private string _clientInstanceId;

    public (string CallerConnectionId, string CallerName)? PendingVoiceCall { get; private set; }

    public SignalRStateManager(
        HubConnection hubConnection,
        State state,
        ISyncSessionStorageService sessionStorageService,
        PayloadEncryptionService payloadEncryptionService,
        NavigationManager navigation,
        IJSRuntime jsRuntime,
        ILogger<SignalRStateManager> logger)
    {
        _hubConnection = hubConnection;
        _sessionStorageService = sessionStorageService;
        _payloadEncryptionService = payloadEncryptionService;
        _navigation = navigation;
        _jsRuntime = jsRuntime;
        _logger = logger;
        _state = state;
        _clientInstanceId = sessionStorageService.ContainKey(CLIENT_INSTANCE_ID_KEY)
            ? sessionStorageService.GetItem<string>(CLIENT_INSTANCE_ID_KEY)
            : Guid.NewGuid().ToString("N");
        sessionStorageService.SetItem(CLIENT_INSTANCE_ID_KEY, _clientInstanceId);

        _state.PropertyChanged += StateChangedHandler;

        _server = hubConnection.CreateHubProxy<ITypedServer>();
        hubConnection.Register<ITypedClient>(this);
        hubConnection.Reconnected += HubConnectionReconnected;
    }

    private async Task HubConnectionReconnected(string? connectionId)
    {
        if (_state.UserInfo != null)
        {
            await _server.Rejoin(_state.UserInfo.Channel, _state.UserInfo.Name, _clientInstanceId);
            if (ConnectionReconnected != null)
            {
                await ConnectionReconnected.Invoke();
            }
        }
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

            LoginViewModel? savedLogin = _sessionStorageService.ContainKey(SESSION_KEY)
                ? _sessionStorageService.GetItem<LoginViewModel>(SESSION_KEY)
                : null;
            if (savedLogin == null)
            {
                var nativeSession = await RestoreBackgroundSession();
                if (nativeSession != null)
                {
                    savedLogin = new LoginViewModel
                    {
                        Channel = nativeSession.Channel,
                        Name = nativeSession.Name,
                        Password = nativeSession.Password
                    };
                    _clientInstanceId = nativeSession.ClientInstanceId;
                    _sessionStorageService.SetItem(CLIENT_INSTANCE_ID_KEY, _clientInstanceId);
                }
            }

            if (savedLogin != null)
            {
                await Login(savedLogin);
                
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
        
        // sanitize channel
        login.Channel = login.Channel.Trim().ToKebabCase();
        
        _state.UserInfo = login;
        
        _sessionStorageService.SetItem(SESSION_KEY, login);
        
        await _server.Join(login.Channel, login.Name, _clientInstanceId);

        try
        {
            _voiceModule ??= await _jsRuntime.InvokeAsync<IJSObjectReference>("import", VoiceModulePath);
            var notificationsEnabled = await _voiceModule.InvokeAsync<bool>(
                "registerBackgroundCalls",
                login.Channel,
                login.Name,
                login.Password,
                _clientInstanceId);
            if (!notificationsEnabled)
            {
                _logger.LogWarning("Background calls are enabled, but incoming call notifications are disabled");
            }
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Unable to register Android background calls");
        }
        
        NotifyAuthenticationStateChanged(GetAuthenticationStateAsync());
    }

    public bool IsLoggedIn()
    {
        return _state.UserInfo != null;
    }

    public async Task Logout()
    {
        try
        {
            _voiceModule ??= await _jsRuntime.InvokeAsync<IJSObjectReference>("import", VoiceModulePath);
            await _voiceModule.InvokeVoidAsync("unregisterBackgroundCalls");
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Unable to unregister Android background calls");
        }

        if (_hubConnection.State == HubConnectionState.Connected)
        {
            await _server.Leave();
        }

        _state.UserInfo = null;
        _state.Names = [];
        _state.OnlineUsers = [];
        _state.Messages.Clear();
        
        _sessionStorageService.RemoveItem(SESSION_KEY);
        PendingVoiceCall = null;

        NotifyAuthenticationStateChanged(GetAuthenticationStateAsync());
    }

    public async Task Send(MessagePayload messagePayload)
    {
        while (!_hubConnection.State.HasFlag(HubConnectionState.Connected))
        {
            await Task.Delay(1);
        }
        
        _state.StateEnum |= SignalRStateEnum.Sending;
        try
        {
            await _server.Send(await _payloadEncryptionService.EncryptPayloadAsync(_state.UserInfo!.Password, messagePayload));
        }
        finally
        {
            _state.StateEnum &= ~SignalRStateEnum.Sending;
        }
    }

    public Task<List<VoiceParticipant>> JoinVoice()
    {
        return _server.JoinVoice();
    }

    public Task<TurnCredentials> GetTurnCredentials()
    {
        return _server.GetTurnCredentials();
    }

    public Task<TurnHealthStatus> CheckTurnHealth()
    {
        return _server.CheckTurnHealth();
    }

    public Task<string> RingVoice(string targetClientInstanceId)
    {
        return _server.RingVoice(targetClientInstanceId);
    }

    public Task CancelVoiceCall(string targetConnectionId, bool timedOut = false)
    {
        return _server.CancelVoiceCall(targetConnectionId, timedOut);
    }

    public Task RespondVoiceCall(string callerConnectionId, bool accepted)
    {
        return _server.RespondVoiceCall(callerConnectionId, accepted);
    }

    public Task LeaveVoice()
    {
        return _server.LeaveVoice();
    }

    public Task SendVoiceOffer(string targetConnectionId, string offer)
    {
        return _server.SendVoiceOffer(targetConnectionId, offer);
    }

    public Task SendVoiceAnswer(string targetConnectionId, string answer)
    {
        return _server.SendVoiceAnswer(targetConnectionId, answer);
    }

    public Task SendVoiceIceCandidate(string targetConnectionId, string candidate)
    {
        return _server.SendVoiceIceCandidate(targetConnectionId, candidate);
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
        _hubConnection.Reconnected -= HubConnectionReconnected;
    }

    public async Task Inbox(MessagePayload messagePayload)
    {
        _state.StateEnum |= SignalRStateEnum.Receiving;   
        
        var isValid = _payloadEncryptionService.PayloadIsValid(_state.UserInfo!.Password, messagePayload.Token);
        
        // If message is valid then decrypt, otherwise don't bother
        if (isValid)
        {
            messagePayload = await _payloadEncryptionService.DecryptPayloadAsync(_state.UserInfo!.Password, messagePayload);
        }

        _state.Messages.AddFirst((messagePayload, isValid));

        // To make sure it list doesn't get too large and consume a lot of memory
        if (_state.Messages.Count > 15)
        {
            _state.Messages.RemoveLast();
        }

        _state.StateEnum &= ~SignalRStateEnum.Receiving;

    }

    public async Task Status(MessageTypeEnum messageTypeEnum, List<OnlineUser> users)
    {
        _state.OnlineUsers = users;
        _state.Names = users.Select(user => user.Name).ToList();

        if (PresenceChanged != null)
        {
            await PresenceChanged.Invoke();
        }
    }

    public Task VoiceCallReceived(string callerConnectionId, string callerName)
    {
        PendingVoiceCall = (callerConnectionId, callerName);
        return VoiceCallReceivedEvent?.Invoke(callerConnectionId, callerName) ?? Task.CompletedTask;
    }

    public Task VoiceCallCancelled(string callerConnectionId, bool timedOut)
    {
        ClearPendingVoiceCall(callerConnectionId);
        return VoiceCallCancelledEvent?.Invoke(callerConnectionId, timedOut) ?? Task.CompletedTask;
    }

    public Task VoiceCallResponded(string responderConnectionId, string responderName, bool accepted)
    {
        return VoiceCallRespondedEvent?.Invoke(responderConnectionId, responderName, accepted) ?? Task.CompletedTask;
    }

    public Task VoiceParticipantLeft(string connectionId)
    {
        return VoiceParticipantLeftReceived?.Invoke(connectionId) ?? Task.CompletedTask;
    }

    public Task ReceiveVoiceOffer(string senderConnectionId, string offer)
    {
        return VoiceOfferReceived?.Invoke(senderConnectionId, offer) ?? Task.CompletedTask;
    }

    public Task ReceiveVoiceAnswer(string senderConnectionId, string answer)
    {
        return VoiceAnswerReceived?.Invoke(senderConnectionId, answer) ?? Task.CompletedTask;
    }

    public Task ReceiveVoiceIceCandidate(string senderConnectionId, string candidate)
    {
        return VoiceIceCandidateReceived?.Invoke(senderConnectionId, candidate) ?? Task.CompletedTask;
    }

    public void ClearPendingVoiceCall(string callerConnectionId)
    {
        if (PendingVoiceCall?.CallerConnectionId == callerConnectionId)
        {
            PendingVoiceCall = null;
        }
    }

    private async Task<NativeBackgroundSession?> RestoreBackgroundSession()
    {
        try
        {
            _voiceModule ??= await _jsRuntime.InvokeAsync<IJSObjectReference>("import", VoiceModulePath);
            return await _voiceModule.InvokeAsync<NativeBackgroundSession?>("restoreBackgroundSession");
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Unable to restore the Android background call session");
            return null;
        }
    }

    private sealed class NativeBackgroundSession
    {
        public string Channel { get; set; } = string.Empty;

        public string Name { get; set; } = string.Empty;

        public string Password { get; set; } = string.Empty;

        public string ClientInstanceId { get; set; } = string.Empty;
    }
}