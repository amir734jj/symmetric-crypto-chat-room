using System;

namespace DomainLogic;

internal sealed class TurnConfiguration
{
    public string Host { get; private init; }

    public int Port { get; private init; }

    public bool TlsOnly { get; private init; }

    public bool RelayOnly { get; private init; }

    public static TurnConfiguration Load()
    {
        var tlsSetting = Environment.GetEnvironmentVariable("TURN_TLS_ONLY");
        var tlsOnly = false;
        if (!string.IsNullOrEmpty(tlsSetting) && !bool.TryParse(tlsSetting, out tlsOnly))
        {
            throw new InvalidOperationException("TURN_TLS_ONLY must be true or false");
        }

        var host = Environment.GetEnvironmentVariable("TURN_HOST")?.Trim() ?? string.Empty;
        if (tlsOnly && string.IsNullOrWhiteSpace(host))
        {
            throw new InvalidOperationException("TURN_HOST is required for TURN TLS certificate validation");
        }

        var port = tlsOnly ? 443 : 3478;
        var portSetting = Environment.GetEnvironmentVariable("TURN_PORT");
        if (!string.IsNullOrEmpty(portSetting) &&
            (!int.TryParse(portSetting, out port) || port < 1 || port > 65535))
        {
            throw new InvalidOperationException("TURN_PORT must be an integer between 1 and 65535");
        }

        var relayOnlySetting = Environment.GetEnvironmentVariable("TURN_RELAY_ONLY");
        return new TurnConfiguration
        {
            Host = host,
            Port = port,
            TlsOnly = tlsOnly,
            RelayOnly = tlsOnly || !bool.TryParse(relayOnlySetting, out var relayOnly) || relayOnly
        };
    }
}
