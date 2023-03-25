using System;
using System.ComponentModel.DataAnnotations;

namespace Models
{
    public class MessagePayload
    {
        public int Id { get; set; }

        public string Name { get; set; }
        
        [Required]
        public string Message { get; set; }
        
        public DateTime Date { get; set; }
        
        public FilePayload File { get; set; }
        
        public DateTimeOffset Expiration { get; set; }
    }

    public class FilePayload
    {
        public string Data { get; set; }
        
        public string Name { get; set; }
        
        public string ContentType { get; set; }
    }
}