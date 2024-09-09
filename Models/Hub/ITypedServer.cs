using System.Threading.Tasks;

namespace Models.Hub
{
    public interface ITypedServer
    {
        Task Send(MessagePayload message);

        Task Join(string channel, string name);
    }
}