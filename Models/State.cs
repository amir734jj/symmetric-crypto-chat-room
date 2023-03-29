using System.Collections.Generic;
using System.ComponentModel;
using Models.ViewModels;

namespace Models
{
    public class State : INotifyPropertyChanged
    {
        public LinkedList<(MessagePayload messagePayload, bool valid)> Messages { get; set; }

        public int Count { get; set; }

        public List<string> Names { get; set; }

        public LoginViewModel UserInfo { get; set; }

        /// <summary>
        /// This is needed because calling async initialize in constructor is not supported in blazor
        /// And IsLoggedIn prematurely says user is not logged in. This way we make sure we get is
        /// logged in result when initialize has finished.
        /// </summary>
        public SignalRStateEnum StateEnum { get; set; }

        public event PropertyChangedEventHandler PropertyChanged;

        public State()
        {
            Messages = new LinkedList<(MessagePayload messagePayload, bool valid)>();
            Names = new List<string>();
            StateEnum  = SignalRStateEnum.Uninitialized;
        }
    }
}