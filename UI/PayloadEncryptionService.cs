using Models;

namespace UI;

public class PayloadEncryptionService
{
    private readonly SymmetricCryptography _symmetricCryptography;
    private readonly HashingUtility _hashingUtility;
    private readonly ILogger<PayloadEncryptionService> _logger;

    public PayloadEncryptionService(SymmetricCryptography symmetricCryptography, HashingUtility hashingUtility,  ILogger<PayloadEncryptionService> logger)
    {
        _symmetricCryptography = symmetricCryptography;
        _hashingUtility = hashingUtility;
        _logger = logger;
    }

    public MessagePayload EncryptPayload(string password, MessagePayload payload)
    {
        _logger.LogTrace("Starting payload encryption process");

        var keyMaterial = _hashingUtility.HashString(password);

        // Only set during encryption
        payload.Token = _symmetricCryptography.Encrypt(keyMaterial, Convert.ToBase64String(keyMaterial));
        payload.Message = _symmetricCryptography.Encrypt(keyMaterial, payload.Message);

        if (payload.File != null)
        {
            payload.File.Data =  _symmetricCryptography.Encrypt(keyMaterial, payload.File.Data);
        }
        
        _logger.LogTrace("Finished payload encryption process");

        return payload;
    }

    public MessagePayload DecryptPayload(string password, MessagePayload payload)
    {
        _logger.LogTrace("Starting payload decryption process");

        var keyMaterial = _hashingUtility.HashString(password);

        payload.Message = _symmetricCryptography.Decrypt(keyMaterial, payload.Message);

        if (payload.File != null)
        {
            payload.File.Data = _symmetricCryptography.Decrypt(keyMaterial, payload.File.Data);
        }
        
        _logger.LogTrace("Finished payload decryption process");

        return payload;
    }
    
    public bool PayloadIsValid(string password, string token)
    {
        var keyMaterial = _hashingUtility.HashString(password);
        
        return _symmetricCryptography.Encrypt(keyMaterial, Convert.ToBase64String(keyMaterial)) == token;
    }
}