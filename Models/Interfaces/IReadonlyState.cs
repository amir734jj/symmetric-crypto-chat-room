using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Models.Interfaces
{
    public interface IReadonlyState
    {
        public List<string> Names { get; set; }
        
        public int Count { get; set; }

        /// <summary>
        /// This is needed because calling async initialize in constructor is not supported in blazor
        /// And IsLoggedIn prematurely says user is not logged in. This way we make sure we get is
        /// logged in result when initialize has finished.
        /// </summary>
        [JsonConverter(typeof(JsonStringEnumConverter))]
        public SignalRStateEnum StateEnum { get; set; }
    }
}