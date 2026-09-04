using System;
using System.Buffers.Binary;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Models;

namespace Domainlogic;

public sealed class TurnHealthChecker
{
    private const int DefaultTurnPort = 3478;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(3);

    public async Task<TurnHealthStatus> CheckAsync()
    {
        var host = Environment.GetEnvironmentVariable("TURN_HOST") ?? string.Empty;
        var port = int.TryParse(Environment.GetEnvironmentVariable("TURN_PORT"), out var configuredPort)
            ? configuredPort
            : DefaultTurnPort;

        if (string.IsNullOrWhiteSpace(host))
        {
            return new TurnHealthStatus
            {
                Message = "TURN_HOST is not configured",
                Port = port
            };
        }

        try
        {
            using var dnsCancellation = new CancellationTokenSource(Timeout);
            var addresses = await Dns.GetHostAddressesAsync(host, dnsCancellation.Token);
            var address = addresses.FirstOrDefault(candidate => candidate.AddressFamily == AddressFamily.InterNetwork)
                ?? addresses.FirstOrDefault();
            if (address == null)
            {
                throw new InvalidOperationException("DNS returned no addresses");
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
                    ? "STUN UDP response and TURN TCP listener are healthy"
                    : $"STUN UDP: {(stunUdpHealthy ? "healthy" : "failed")}; TURN TCP: {(turnTcpHealthy ? "healthy" : "failed")}"
            };
        }
        catch (Exception exception) when (exception is SocketException or OperationCanceledException or InvalidOperationException)
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
        const uint magicCookie = 0x2112A442;
        var request = new byte[20];
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(0, 2), 0x0001);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(4, 4), magicCookie);
        RandomNumberGenerator.Fill(request.AsSpan(8, 12));

        using var client = new UdpClient(address.AddressFamily);
        client.Connect(address, port);
        await client.SendAsync(request, cancellationToken);
        var response = await client.ReceiveAsync(cancellationToken);

        return response.Buffer.Length >= 20
            && BinaryPrimitives.ReadUInt16BigEndian(response.Buffer.AsSpan(0, 2)) == 0x0101
            && BinaryPrimitives.ReadUInt32BigEndian(response.Buffer.AsSpan(4, 4)) == magicCookie
            && response.Buffer.AsSpan(8, 12).SequenceEqual(request.AsSpan(8, 12));
    }

    private static async Task<bool> CheckTurnTcpAsync(IPAddress address, int port, CancellationToken cancellationToken)
    {
        using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        await socket.ConnectAsync(new IPEndPoint(address, port), cancellationToken);
        return socket.Connected;
    }
}