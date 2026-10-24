using System.Collections.Generic;
using System.Threading.Tasks;

namespace Models.Hub
{
    public interface ITypedServer
    {
        Task Send(MessagePayload message);

        Task Join(string channel, string name, string clientInstanceId);

        Task Rejoin(string channel, string name, string clientInstanceId);

        Task Leave();

        Task<List<ChannelSummary>> GetChannels();

        Task<string> GetPushPublicKey();

        Task<bool> HasChannelPush(string deviceToken);

        Task SubscribeChannelPush(string deviceToken, ChannelPushSubscription subscription);

        Task UnsubscribeChannelPush(string deviceToken);

        Task<ChannelPushResult> NotifyChannel();

        Task<List<VoiceParticipant>> JoinVoice();

        Task<List<VoiceParticipant>> JoinHttpsAudioVoice();

        Task SendHttpsAudio(byte[] frame);

        Task<VoiceCallState> JoinAutomaticVoice(VoiceCapabilities capabilities);

        Task<VoiceCallState> RequestHttpsAudio(long mediaRevision);

        Task SendAutomaticAudio(long mediaRevision, byte[] frame);

        Task<TurnCredentials> GetTurnCredentials();

        Task<TurnHealthStatus> CheckTurnHealth();

        Task RingVoice(string targetConnectionId);

        Task CancelVoiceCall(string targetConnectionId, bool timedOut);

        Task RespondVoiceCall(string callerConnectionId, bool accepted);

        Task LeaveVoice();

        Task SendVoiceOffer(string targetConnectionId, string offer);

        Task SendVoiceAnswer(string targetConnectionId, string answer);

        Task SendVoiceIceCandidate(string targetConnectionId, string candidate);
    }
}