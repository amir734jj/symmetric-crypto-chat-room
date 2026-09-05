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

        Task<TurnHealthStatus> CheckTurnHealth();

        Task RingVoice(string targetConnectionId);

        Task CancelVoiceCall(string targetConnectionId);

        Task RespondVoiceCall(string callerConnectionId, bool accepted);

        Task LeaveVoice();

        Task SendVoiceOffer(string targetConnectionId, string offer);

        Task SendVoiceAnswer(string targetConnectionId, string answer);

        Task SendVoiceIceCandidate(string targetConnectionId, string candidate);
    }
}