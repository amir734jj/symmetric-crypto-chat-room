namespace Models
{
    public sealed class OnlineUser
    {
        public string ConnectionId { get; set; } = string.Empty;

        public string ClientInstanceId { get; set; } = string.Empty;

        public string Name { get; set; } = string.Empty;
    }
}