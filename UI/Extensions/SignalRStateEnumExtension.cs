using Models;

namespace UI.Extensions;

public static class StatEnumExtension
{
    public static bool IsLoading(this SignalRStateEnum self)
    {
        return self.HasFlag(SignalRStateEnum.Initializing) ||
               self.HasFlag(SignalRStateEnum.Sending) ||
               self.HasFlag(SignalRStateEnum.Receiving);
    }
}