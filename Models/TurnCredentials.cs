namespace Models
{
    public sealed class TurnCredentials
    {
        public string Host { get; set; } = string.Empty;

        public string Username { get; set; } = string.Empty;

        public string Credential { get; set; } = string.Empty;

        public bool RelayOnly { get; set; }
    }
}