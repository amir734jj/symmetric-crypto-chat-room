using System.Collections.Generic;
using System.ComponentModel;
using System.Text.Json.Serialization;
using Models.Interfaces;
using Models.ViewModels;

namespace Models
{
    public class State : INotifyPropertyChanged, IReadonlyState
    {
        public LinkedList<(MessagePayload messagePayload, bool valid)> Messages { get; set; } = new LinkedList<(MessagePayload messagePayload, bool valid)>();

        public int Count { get; set; }

        public List<string> Names { get; set; } = new List<string>();

        public LoginViewModel UserInfo { get; set; }

        /// <summary>
        /// This is needed because calling async initialize in constructor is not supported in blazor
        /// And IsLoggedIn prematurely says user is not logged in. This way we make sure we get is
        /// logged in result when initialize has finished.
        /// </summary>
        [JsonConverter(typeof(JsonStringEnumConverter))]
        public SignalRStateEnum StateEnum { get; set; } = SignalRStateEnum.Uninitialized;

        public event PropertyChangedEventHandler PropertyChanged;
    }
}