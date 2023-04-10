using System;

namespace Models
{
    [Flags]
    public enum SignalRStateEnum
    {
        Uninitialized = 1,
        Initialized = 2,
        Initializing = 4,
        Failed = 8,
        Sending = 16,
        Receiving = 32
    }
}