using System;

namespace Models
{
    public class MessagePayload
    {
        public string Name { get; set; }
        
        public string Message { get; set; }
        
        public DateTime Date { get; set; }
        
        public FilePayload File { get; set; }
    }

    public class FilePayload
    {
        public string Data { get; set; }
        
        public string Name { get; set; }
    }
}