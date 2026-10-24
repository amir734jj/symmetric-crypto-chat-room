using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using LiteDB;
using Models;
using Models.Constants;

namespace DomainLogic;

public sealed class PlaybackLogic : IDisposable
{
    private readonly ILiteCollection<MessagePayload> _collection;
        
    private readonly CancellationTokenSource _cleanupTaskCancellationToken;

    public int RetentionMinutes { get; }

    public PlaybackLogic(ILiteDatabase db, int retentionMinutes = ChatConstants.DefaultMessageRetentionMinutes)
    {
        if (retentionMinutes <= 0) throw new ArgumentOutOfRangeException(nameof(retentionMinutes));
        RetentionMinutes = retentionMinutes;
        _collection = db.GetCollection<MessagePayload>();

        _cleanupTaskCancellationToken = new CancellationTokenSource();
            
        Task.Run(DbCleanup, _cleanupTaskCancellationToken.Token);
    }
    
    private async Task DbCleanup()
    {
        while (!_cleanupTaskCancellationToken.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            foreach (var messagePayload in _collection.FindAll().ToList().Where(messagePayload => messagePayload.Expiration <= now))
            {
                _collection.Delete(messagePayload.Id);
            }

            await Task.Delay(TimeSpan.FromMinutes(1), _cleanupTaskCancellationToken.Token);
        }
    }

    public IEnumerable<MessagePayload> GetMessages(string channel)
    {
        var now = DateTimeOffset.UtcNow;
        return _collection.Find(x => x.Channel == channel).Where(message => message.Expiration > now).ToList();
    }

    public void RecordMessage(MessagePayload message)
    {
        message.Expiration = DateTimeOffset.UtcNow.AddMinutes(RetentionMinutes);
            
        _collection.Insert(message);
    }

    public void Dispose()
    {
        _cleanupTaskCancellationToken?.Cancel();
        _cleanupTaskCancellationToken?.Dispose();
    }
}
