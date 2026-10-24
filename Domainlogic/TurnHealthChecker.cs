using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Models;

namespace DomainLogic;

public sealed class TurnHealthChecker
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(3);

    public async Task<TurnHealthStatus> CheckAsync()
    {
        var host = string.Empty;
        var port = 0;
        try
        {
            var configuration = TurnConfiguration.Load();
            host = configuration.Host;
            port = configuration.Port;
            if (string.IsNullOrWhiteSpace(host))
            {
                return new TurnHealthStatus
                {
                    Message = "TURN_HOST is not configured",
                    Port = port
                };
            }

            using var dnsCancellation = new CancellationTokenSource(Timeout);
            var addresses = await Dns.GetHostAddressesAsync(host, dnsCancellation.Token);
            var address = addresses.FirstOrDefault(candidate => candidate.AddressFamily == AddressFamily.InterNetwork)
                ?? addresses.FirstOrDefault();
            if (address == null)
            {
                throw new InvalidOperationException("DNS returned no addresses");
            }

            if (configuration.TlsOnly)
            {
                using var tlsCancellation = new CancellationTokenSource(Timeout);
                await CheckTurnTlsAsync(address, host, port, tlsCancellation.Token);
                return new TurnHealthStatus
                {
                    Healthy = true,
                    TurnTlsHealthy = true,
                    Host = host,
                    Port = port,
                    Message = "Server-side TURN TLS/STUN check passed (certificate validated). " +
                        "This does not verify client reachability or authenticated media relay."
                };
            }

            var stunTask = RunCheckAsync(token => CheckStunUdpAsync(address, port, token));
            var tcpTask = RunCheckAsync(token => CheckTurnTcpAsync(address, port, token));
            await Task.WhenAll(stunTask, tcpTask);
            var stunUdpHealthy = await stunTask;
            var turnTcpHealthy = await tcpTask;
            var healthy = stunUdpHealthy && turnTcpHealthy;

            return new TurnHealthStatus
            {
                Healthy = healthy,
                StunUdpHealthy = stunUdpHealthy,
                TurnTcpHealthy = turnTcpHealthy,
                Host = host,
                Port = port,
                Message = healthy
                    ? "Server-side STUN UDP response and TURN TCP listener are healthy. " +
                        "This does not verify client reachability or authenticated media relay."
                    : $"Server-side STUN UDP: {(stunUdpHealthy ? "healthy" : "failed")}; TURN TCP: {(turnTcpHealthy ? "healthy" : "failed")}"
            };
        }
        catch (Exception exception) when (exception is SocketException or OperationCanceledException
            or InvalidOperationException or AuthenticationException or IOException)
        {
            return new TurnHealthStatus
            {
                Host = host,
                Port = port,
                Message = $"TURN health check failed: {exception.Message}"
            };
        }
    }

    private static async Task<bool> RunCheckAsync(Func<CancellationToken, Task<bool>> check)
    {
        try
        {
            using var cancellation = new CancellationTokenSource(Timeout);
            return await check(cancellation.Token);
        }
        catch (Exception exception) when (exception is SocketException or OperationCanceledException)
        {
            return false;
        }
    }

    private static async Task<bool> CheckStunUdpAsync(IPAddress address, int port, CancellationToken cancellationToken)
    {
        var request = CreateStunRequest();

        using var client = new UdpClient(address.AddressFamily);
        client.Connect(address, port);
        await client.SendAsync(request, cancellationToken);
        var response = await client.ReceiveAsync(cancellationToken);

        return IsStunResponse(response.Buffer, request);
    }

    private static byte[] CreateStunRequest()
    {
        var request = new byte[20];
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(0, 2), 0x0001);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(4, 4), 0x2112A442);
        RandomNumberGenerator.Fill(request.AsSpan(8, 12));
        return request;
    }

    private static bool IsStunResponse(byte[] response, byte[] request) =>
        response.Length >= 20
            && BinaryPrimitives.ReadUInt16BigEndian(response.AsSpan(0, 2)) == 0x0101
            && response.AsSpan(4, 16).SequenceEqual(request.AsSpan(4, 16));

    private static async Task CheckTurnTlsAsync(
        IPAddress address, string host, int port, CancellationToken cancellationToken)
    {
        using var client = new TcpClient(address.AddressFamily);
        await client.ConnectAsync(address, port, cancellationToken);
        using var stream = new SslStream(client.GetStream());
        await stream.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
        {
            TargetHost = host
        }, cancellationToken);
        var request = CreateStunRequest();
        await stream.WriteAsync(request, cancellationToken);
        var response = new byte[20];
        await stream.ReadExactlyAsync(response, cancellationToken);
        if (!IsStunResponse(response, request))
        {
            throw new InvalidOperationException("TURN TLS endpoint returned an invalid STUN binding response");
        }
    }

    private static async Task<bool> CheckTurnTcpAsync(IPAddress address, int port, CancellationToken cancellationToken)
    {
        using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        await socket.ConnectAsync(new IPEndPoint(address, port), cancellationToken);
        return socket.Connected;
    }
}