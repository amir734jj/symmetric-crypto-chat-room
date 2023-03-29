using System;

namespace Models
{
    [Flags]
    public enum SignalRStateEnum
    {
        Uninitialized, Initialized, Initializing, Failed, Sending, Receiving
    }
}