using System.IO;
using Microsoft.AspNetCore;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;
using System;
using System.Security.Cryptography;

namespace API
{
    public class Program
    {
        public static void Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--generate-vapid-keys")
            {
                using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
                var parameters = key.ExportParameters(true);
                var publicKey = new byte[65];
                publicKey[0] = 4;
                Buffer.BlockCopy(parameters.Q.X, 0, publicKey, 1, 32);
                Buffer.BlockCopy(parameters.Q.Y, 0, publicKey, 33, 32);
                Console.WriteLine($"Push__PublicKey={Base64Url(publicKey)}");
                Console.WriteLine($"Push__PrivateKey={Base64Url(parameters.D)}");
                return;
            }
            BuildWebHost(args).Run();
        }

        private static string Base64Url(byte[] bytes) =>
            Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static IWebHost BuildWebHost(string[] args) =>
            WebHost.CreateDefaultBuilder(args)
                .UseStartup<Startup>()
                .UseContentRoot(Directory.GetCurrentDirectory())
                .ConfigureLogging(logging => logging.SetMinimumLevel(LogLevel.Error))
                .ConfigureLogging((hostingContext, logging) =>
                {
                    logging.AddConfiguration(hostingContext.Configuration.GetSection("Logging"));
                    logging.AddConsole();
                    logging.AddDebug();
                    logging.AddEventSourceLogger();
                }).Build();
    }
}