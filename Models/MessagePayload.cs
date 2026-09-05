using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;

namespace Models
{
    public class MessagePayload
    {
        public int Id { get; set; }

        public string Name { get; set; }
        
        public string Channel { get; set; }
        
        [Required]
        public string Message { get; set; }
        
        public DateTime Date { get; set; }

        public List<FilePayload> Files { get; set; } = new List<FilePayload>();
        
        public DateTimeOffset Expiration { get; set; }
        
        public string Token { get; set; }
    }

    public class FilePayload
    {
        public byte[] Data { get; set; } = Array.Empty<byte>();

        public bool IsCompressed { get; set; }
        
        public string Name { get; set; }
        
        public string ContentType { get; set; }
    }
}