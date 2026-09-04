namespace Models
{
    public sealed class TurnHealthStatus
    {
        public bool Healthy { get; set; }

        public bool StunUdpHealthy { get; set; }

        public bool TurnTcpHealthy { get; set; }

        public string Message { get; set; } = string.Empty;

        public string Host { get; set; } = string.Empty;

        public int Port { get; set; }
    }
}