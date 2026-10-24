using System.Collections.Generic;
using System.Threading.Tasks;

namespace Models.Hub
{
    public interface ITypedClient
    {
        public Task Inbox(MessagePayload messagePayload);

        public Task Status(MessageTypeEnum messageTypeEnum, List<OnlineUser> users);

        public Task VoiceCallReceived(string callerConnectionId, string callerName);

        public Task VoiceCallCancelled(string callerConnectionId, bool timedOut);

        public Task VoiceCallResponded(string responderConnectionId, string responderName, bool accepted);

        public Task VoiceParticipantLeft(string connectionId);

        public Task ReceiveVoiceOffer(string senderConnectionId, string offer);

        public Task ReceiveVoiceAnswer(string senderConnectionId, string answer);

        public Task ReceiveVoiceIceCandidate(string senderConnectionId, string candidate);

        public Task HttpsAudioParticipantsChanged(List<VoiceParticipant> participants);

        public Task ReceiveHttpsAudio(string senderConnectionId, byte[] frame);

        public Task HttpsAudioFailed(string message);

        public Task VoiceCallChanged(VoiceCallState state);

        public Task ReceiveAutomaticAudio(long mediaRevision, string senderConnectionId, byte[] frame);
    }
}