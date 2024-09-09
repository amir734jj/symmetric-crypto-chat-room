using Models;

namespace UI;

public class PayloadEncryptionService(
    SymmetricCryptography symmetricCryptography,
    HashingUtility hashingUtility,
    ILogger<PayloadEncryptionService> logger)
{
    public MessagePayload EncryptPayload(string password, MessagePayload payload)
    {
        logger.LogTrace("Starting payload encryption process");

        var keyMaterial = hashingUtility.HashString(password);

        // Only set during encryption
        payload.Token = symmetricCryptography.Encrypt(keyMaterial, Convert.ToBase64String(keyMaterial));
        payload.Message = symmetricCryptography.Encrypt(keyMaterial, payload.Message);

        foreach (var payloadFile in payload.Files)
        {
            payloadFile.Name = symmetricCryptography.Encrypt(keyMaterial, payloadFile.Name);
            payloadFile.Data = symmetricCryptography.Encrypt(keyMaterial, payloadFile.Data);
        }
        
        logger.LogTrace("Finished payload encryption process");

        return payload;
    }

    public MessagePayload DecryptPayload(string password, MessagePayload payload)
    {
        logger.LogTrace("Starting payload decryption process");

        var keyMaterial = hashingUtility.HashString(password);

        payload.Message = symmetricCryptography.Decrypt(keyMaterial, payload.Message);

        foreach (var payloadFile in payload.Files)
        {
            payloadFile.Name = symmetricCryptography.Decrypt(keyMaterial, payloadFile.Name);
            payloadFile.Data = symmetricCryptography.Decrypt(keyMaterial, payloadFile.Data);
        }
        
        logger.LogTrace("Finished payload decryption process");

        return payload;
    }
    
    public bool PayloadIsValid(string password, string token)
    {
        var keyMaterial = hashingUtility.HashString(password);
        
        return symmetricCryptography.Encrypt(keyMaterial, Convert.ToBase64String(keyMaterial)) == token;
    }
}