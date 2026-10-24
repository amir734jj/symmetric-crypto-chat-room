namespace Models
{
    public sealed class ChannelPushSubscription
    {
        public string Endpoint { get; set; } = "";
        public string P256dh { get; set; } = "";
        public string Auth { get; set; } = "";
    }

    public sealed class ChannelPushResult
    {
        public int Accepted { get; set; }
        public int Failed { get; set; }
        public int Expired { get; set; }
    }
}
