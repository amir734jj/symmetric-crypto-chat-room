namespace Models
{
    public sealed class TurnCredentials
    {
        public string Host { get; set; } = string.Empty;

        public int Port { get; set; } = 3478;

        public bool TlsOnly { get; set; }

        public string Username { get; set; } = string.Empty;

        public string Credential { get; set; } = string.Empty;

        public bool RelayOnly { get; set; }
    }
}