using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using DomainLogic;
using Microsoft.AspNetCore.SignalR;

internal static class TurnTests
{
    public static async Task Run(MessageHub hub)
    {
        string[] names = ["TURN_HOST", "TURN_PORT", "TURN_TLS_ONLY", "TURN_RELAY_ONLY", "TURN_SECRET"];
        var original = names.ToDictionary(name => name, Environment.GetEnvironmentVariable);
        try
        {
            foreach (var name in names) Environment.SetEnvironmentVariable(name, null);
            Environment.SetEnvironmentVariable("TURN_SECRET", "test-only-secret");
            var legacy = await hub.GetTurnCredentials();
            Check(legacy.Port == 3478 && !legacy.TlsOnly && legacy.RelayOnly,
                "Legacy settings must preserve port 3478 and relay-only defaults");
            using var hmac = new HMACSHA1(Encoding.UTF8.GetBytes("test-only-secret"));
            Check(legacy.Credential == Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes(legacy.Username))),
                "TURN credentials must retain coturn-compatible HMAC authentication");
            Check(legacy.Username.EndsWith(":first"), "TURN usernames must retain the connection ID");

            Environment.SetEnvironmentVariable("TURN_PORT", "12345");
            Environment.SetEnvironmentVariable("TURN_RELAY_ONLY", "false");
            var customLegacy = await hub.GetTurnCredentials();
            Check(customLegacy.Port == 12345 && !customLegacy.RelayOnly,
                "Legacy custom ports and direct routing must remain configurable");

            Environment.SetEnvironmentVariable("TURN_PORT", null);
            Environment.SetEnvironmentVariable("TURN_TLS_ONLY", "true");
            await Reject(hub, "TURN_HOST");
            var missingHost = await new TurnHealthChecker().CheckAsync();
            Check(!missingHost.Healthy && missingHost.Message.Contains("TURN_HOST"),
                "TLS health must report missing host configuration");

            Environment.SetEnvironmentVariable("TURN_HOST", "turn.example.com");
            var tls = await hub.GetTurnCredentials();
            Check(tls.TlsOnly && tls.Port == 443 && tls.RelayOnly && tls.Host == "turn.example.com",
                "TLS-only must default to 443 and override direct routing");
            Environment.SetEnvironmentVariable("TURN_PORT", "5349");
            Check((await hub.GetTurnCredentials()).Port == 5349, "TLS must support custom public ports");

            foreach (var value in new[] { "0", "-1", "65536", "abc" })
            {
                Environment.SetEnvironmentVariable("TURN_PORT", value);
                await Reject(hub, "TURN_PORT");
                var invalid = await new TurnHealthChecker().CheckAsync();
                Check(!invalid.Healthy && invalid.Message.Contains("TURN_PORT"),
                    "Health and credentials must reject the same invalid ports");
            }
            Environment.SetEnvironmentVariable("TURN_PORT", null);
            Environment.SetEnvironmentVariable("TURN_TLS_ONLY", "invalid");
            await Reject(hub, "TURN_TLS_ONLY");
            Check(!(await new TurnHealthChecker().CheckAsync()).Healthy,
                "Invalid TLS mode must not silently use a legacy health check");

            await CheckLegacyHealth();
            await CheckUntrustedTls();
            Console.WriteLine("PASS: TURN defaults, TLS-only routing, custom ports, credential authentication, configuration errors, legacy health, and TLS certificate rejection");
        }
        finally
        {
            foreach (var pair in original) Environment.SetEnvironmentVariable(pair.Key, pair.Value);
        }
    }

    private static async Task CheckLegacyHealth()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            using var udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, port));
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            Environment.SetEnvironmentVariable("TURN_HOST", "127.0.0.1");
            Environment.SetEnvironmentVariable("TURN_PORT", port.ToString());
            Environment.SetEnvironmentVariable("TURN_TLS_ONLY", "false");
            var serve = Task.Run(async () =>
            {
                using var socket = await listener.AcceptTcpClientAsync(timeout.Token);
                var request = await udp.ReceiveAsync(timeout.Token);
                request.Buffer[0] = 1;
                request.Buffer[1] = 1;
                await udp.SendAsync(request.Buffer, request.RemoteEndPoint, timeout.Token);
            });
            var health = await new TurnHealthChecker().CheckAsync();
            await serve;
            Check(health.Healthy && health.StunUdpHealthy && health.TurnTcpHealthy && !health.TurnTlsHealthy,
                "Legacy health must check the configured UDP and TCP port");
        }
        finally
        {
            listener.Stop();
        }
    }

    private static async Task CheckUntrustedTls()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=localhost", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        san.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(san.Build());
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            Environment.SetEnvironmentVariable("TURN_PORT", ((IPEndPoint)listener.LocalEndpoint).Port.ToString());
            Environment.SetEnvironmentVariable("TURN_TLS_ONLY", "true");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var serve = Task.Run(async () =>
            {
                using var client = await listener.AcceptTcpClientAsync(timeout.Token);
                using var stream = new SslStream(client.GetStream());
                try
                {
                    await stream.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
                    {
                        ServerCertificate = certificate
                    }, timeout.Token);
                }
                catch (Exception exception) when (exception is AuthenticationException or IOException)
                {
                    // The client rejects this untrusted certificate during the handshake.
                }
            });
            var health = await new TurnHealthChecker().CheckAsync();
            await serve;
            Check(!health.Healthy && !health.TurnTlsHealthy && health.Message.Contains("TURN health check failed"),
                "An untrusted TLS certificate must never produce a healthy result");
        }
        finally
        {
            listener.Stop();
        }
    }

    private static async Task Reject(MessageHub hub, string setting)
    {
        try
        {
            await hub.GetTurnCredentials();
        }
        catch (HubException exception) when (exception.Message.Contains(setting))
        {
            return;
        }
        throw new InvalidOperationException($"Expected an explicit {setting} configuration error");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
