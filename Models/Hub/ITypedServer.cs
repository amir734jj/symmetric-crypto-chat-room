using System.Collections.Generic;
using System.Threading.Tasks;

namespace Models.Hub
{
    public interface ITypedServer
    {
        Task Send(MessagePayload message);

        Task Join(string channel, string name);

        Task Rejoin(string channel, string name);

        Task Leave();

        Task<List<VoiceParticipant>> JoinVoice();

        Task<TurnCredentials> GetTurnCredentials();

        Task LeaveVoice();

        Task SendVoiceOffer(string targetConnectionId, string offer);

        Task SendVoiceAnswer(string targetConnectionId, string answer);

        Task SendVoiceIceCandidate(string targetConnectionId, string candidate);
    }
}