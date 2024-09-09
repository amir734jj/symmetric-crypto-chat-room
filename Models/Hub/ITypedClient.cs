using System.Collections.Generic;
using System.Threading.Tasks;

namespace Models.Hub
{
    public interface ITypedClient
    {
        public Task Inbox(MessagePayload messagePayload);

        public Task Status(MessageTypeEnum messageTypeEnum, List<string> names);
    }
}