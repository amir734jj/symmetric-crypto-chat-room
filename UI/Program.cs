using Blazor.Extensions.Logging;
using BlazorDownloadFile;
using Blazored.SessionStorage;
using CurrieTechnologies.Razor.PageVisibility;
using Havit.Blazor.Components.Web;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.AspNetCore.SignalR.Client;
using Models;
using UI;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

var serverlessBaseUri = string.IsNullOrEmpty(builder.Configuration["ServerlessBaseURI"])
    ? builder.HostEnvironment.BaseAddress
    : builder.Configuration["ServerlessBaseURI"]!;

builder.Services.AddOptions();
builder.Services.AddAuthorizationCore();

builder.Services.AddSingleton(new HubConnectionBuilder()
    .WithUrl(new Uri(new Uri(serverlessBaseUri), "signalr"))
    .WithAutomaticReconnect()
    .AddJsonProtocol()
    .Build());

builder.Services.AddPageVisibility();

builder.Services.AddBlazoredSessionStorageAsSingleton();

builder.Services.AddSingleton<HashingUtility>();
builder.Services.AddSingleton<SymmetricCryptography>();
builder.Services.AddSingleton<PayloadEncryptionService>();
builder.Services.AddSingleton<State>();
builder.Services.AddSingleton<SignalRStateManager>();
builder.Services.AddScoped<AuthenticationStateProvider, SignalRStateManager>();

builder.Services.AddHxServices();
builder.Services.AddBlazorDownloadFile();

builder.Services.AddLogging(x => x.AddBrowserConsole()
    .SetMinimumLevel(LogLevel.Trace));

await builder.Build().RunAsync();