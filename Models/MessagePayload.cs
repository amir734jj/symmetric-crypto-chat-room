using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;

namespace Models
{
    public class MessagePayload : IValidatableObject
    {
        public int Id { get; set; }

        public string Name { get; set; }
        
        public string Channel { get; set; }
        
        public string Message { get; set; } = string.Empty;
        
        public DateTime Date { get; set; }

        public List<FilePayload> Files { get; set; } = new List<FilePayload>();
        
        public DateTimeOffset Expiration { get; set; }
        
        public string Token { get; set; }

        public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
        {
            if (string.IsNullOrWhiteSpace(Message) && Files.Count == 0)
            {
                yield return new ValidationResult(
                    "Enter a message or attach at least one file.",
                    new[] { nameof(Message), nameof(Files) });
            }
        }
    }

    public class FilePayload
    {
        public byte[] Data { get; set; } = Array.Empty<byte>();

        public bool IsCompressed { get; set; }
        
        public string Name { get; set; }
        
        public string ContentType { get; set; }
    }
}