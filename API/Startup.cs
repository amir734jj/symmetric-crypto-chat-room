using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Domainlogic;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Hosting;
using Models;

namespace API
{
    public class Startup
    {
        // This method gets called by the runtime. Use this method to add services to the container.
        // For more information on how to configure your application, visit https://go.microsoft.com/fwlink/?LinkID=398940
        public void ConfigureServices(IServiceCollection services)
        {
            services.AddSignalR();
        }

        // This method gets called by the runtime. Use this method to configure the HTTP request pipeline.
        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            if (env.IsDevelopment())
            {
                app.UseDeveloperExceptionPage();
            }

            // app.Run(async (context) => { await context.Response.WriteAsync("Hello World!"); });

            app.UseFileServer();
            
            app.UseSignalR(route =>
            {
                route.MapHub<MessageHub>("/chat");
            });
        }
    }
}