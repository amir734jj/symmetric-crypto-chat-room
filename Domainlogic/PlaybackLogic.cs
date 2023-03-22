using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using LiteDB;
using Models;

namespace Domainlogic;

public sealed class PlaybackLogic : IDisposable
{
    private readonly ILiteCollection<MessagePayload> _collection;
        
    private readonly CancellationTokenSource _cleanupTaskCancellationToken;

    public PlaybackLogic(ILiteDatabase db)
    {
        _collection = db.GetCollection<MessagePayload>();

        _cleanupTaskCancellationToken = new CancellationTokenSource();
            
        Task.Run(DbCleanup, _cleanupTaskCancellationToken.Token);
    }
    
    private async Task DbCleanup()
    {
        while (!_cleanupTaskCancellationToken.IsCancellationRequested)
        {
            foreach (var messagePayload in _collection.FindAll().ToList().Where(messagePayload => (DateTimeOffset.Now - messagePayload.Expiration).TotalSeconds > 0))
            {
                _collection.Delete(messagePayload.Id);
            }

            await Task.Delay(TimeSpan.FromMinutes(1));
        }
    }

    public IEnumerable<MessagePayload> GetMessages()
    {
        return _collection.FindAll();
    }

    public void RecordMessage(MessagePayload message)
    {
        message.Expiration = DateTimeOffset.Now.AddMinutes(10);
            
        _collection.Insert(message);
    }

    public void Dispose()
    {
        _cleanupTaskCancellationToken?.Dispose();
    }
}