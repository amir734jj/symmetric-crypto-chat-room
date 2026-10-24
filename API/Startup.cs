using System;
using System.Net.Http;
using ByteSizeLib;
using DomainLogic;
using LiteDB;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Lib.Net.Http.WebPush;
using Models.Constants;

namespace API;

public class Startup
{
    private readonly IConfigurationRoot _configuration;

    private readonly IWebHostEnvironment _env;

    public Startup(IWebHostEnvironment env)
    {
        _env = env;

        var builder = new ConfigurationBuilder()
            .SetBasePath(env.ContentRootPath)
            .AddJsonFile("appsettings.json", true, true)
            .AddJsonFile($"appsettings.{env.EnvironmentName}.json", true)
            .AddJsonFile("secureHeaderSettings.json", true, true)
            .AddEnvironmentVariables();

        _configuration = builder.Build();
    }

    // This method gets called by the runtime. Use this method to add services to the container.
    // For more information on how to configure your application, visit https://go.microsoft.com/fwlink/?LinkID=398940
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddCors(options => options.AddPolicy("CorsPolicy", builder => builder
            .WithOrigins(_configuration.GetSection("TrustedSpaUrls").Get<string[]>() ?? Array.Empty<string>())
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials()));

        services.AddControllers();

        services.AddHealthChecks();

        services.AddOptions();

        services.AddResponseCompression();

        services.AddLogging();

        services.AddRouting(options => options.LowercaseUrls = true);

        services.AddSignalR(c =>
        {
            c.KeepAliveInterval = TimeSpan.FromSeconds(30);
            c.ClientTimeoutInterval = TimeSpan.FromSeconds(90);
            c.MaximumReceiveMessageSize = (long)ByteSize.FromMegaBytes(50).Bytes; // 50 mega-bytes
            c.StreamBufferCapacity = 50;
            c.EnableDetailedErrors = true;
        });

        var messageRetentionMinutes = _configuration.GetValue<int>(
            "MESSAGE_RETENTION_MINUTES", ChatConstants.DefaultMessageRetentionMinutes);
        if (messageRetentionMinutes <= 0)
            throw new InvalidOperationException("MESSAGE_RETENTION_MINUTES must be a positive whole number.");

        services.AddSingleton<ILiteDatabase>(new LiteDatabase(
            _configuration["DATABASE_PATH"] ?? "db.litedb"));
        services.AddSingleton(provider => new PlaybackLogic(
            provider.GetRequiredService<ILiteDatabase>(), messageRetentionMinutes));
        services.AddSingleton<TurnHealthChecker>();
        services.Configure<PushOptions>(_configuration.GetSection("Push"));
        services.AddSingleton(_ => new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }));
        services.AddSingleton(provider => new PushServiceClient(provider.GetRequiredService<HttpClient>())
        {
            AutoRetryAfter = false
        });
        services.AddSingleton<PushNotificationService>();
    }

    // This method gets called by the runtime. Use this method to configure the HTTP request pipeline.
    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();

            app.UseCors("CorsPolicy");
        }

        app.UseResponseCompression();

        app.UseDefaultFiles()
            .UseStaticFiles(new StaticFileOptions
            {
                // Needed to serve dll files of Blazor webassembly
                ServeUnknownFileTypes = true
            }).UseSpa(opt =>
            {
                opt.ApplicationBuilder
                    .UseRouting()
                    .UseEndpoints(endpoints =>
                    {
                        endpoints.MapControllers();
                        endpoints.MapHub<MessageHub>("/signalr");
                    });
            });
    }
}
