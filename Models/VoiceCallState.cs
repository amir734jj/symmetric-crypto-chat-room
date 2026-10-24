using System.Collections.Generic;

namespace Models
{
    public class VoiceCallState
    {
        public long Revision { get; set; }
        public long MediaRevision { get; set; }
        public bool HttpsAudio { get; set; }
        public bool Opus { get; set; }
        public string Reason { get; set; } = "";
        public List<VoiceParticipant> Participants { get; set; } = new List<VoiceParticipant>();
    }

    public class VoiceCapabilities
    {
        public bool ForceStealth { get; set; }
        public bool SupportsWebRtc { get; set; }
        public bool SupportsHttpsAudio { get; set; }
        public bool SupportsOpus { get; set; }
    }
}
