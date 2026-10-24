namespace Models
{
    public sealed class TurnConnectionTestResult
    {
        public bool Succeeded { get; set; }

        public bool Tls { get; set; }

        public string Url { get; set; } = string.Empty;

        public string Message { get; set; } = string.Empty;
    }
}
