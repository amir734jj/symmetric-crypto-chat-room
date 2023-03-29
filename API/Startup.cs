using ByteSizeLib;
using Domainlogic;
using LiteDB;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

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
            .WithOrigins(_configuration.GetSection("TrustedSpaUrls").Get<string[]>())
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
            c.MaximumReceiveMessageSize = (long)ByteSize.FromMegaBytes(50).Bytes; // 50 mega-bytes
            c.StreamBufferCapacity = 50;
            c.EnableDetailedErrors = true;
        });

        services.AddSingleton<ILiteDatabase>(new LiteDatabase("db.litedb"));
        services.AddSingleton<PlaybackLogic>();
    }

    // This method gets called by the runtime. Use this method to configure the HTTP request pipeline.
    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();

            app.UseCors("CorsPolicy");
        }

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