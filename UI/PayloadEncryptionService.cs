using ICSharpCode.SharpZipLib.GZip;
using Models;
using Models.Constants;

namespace UI;

public class PayloadEncryptionService(
    SymmetricCryptography symmetricCryptography,
    ILogger<PayloadEncryptionService> logger)
{
    public async Task<MessagePayload> EncryptPayloadAsync(string password, MessagePayload payload)
    {
        logger.LogTrace("Starting payload encryption process");

        var keyMaterial = HashingUtility.HashString(password);

        // Only set during encryption
        payload.Token = symmetricCryptography.Encrypt(keyMaterial, Convert.ToBase64String(keyMaterial));
        payload.Message = symmetricCryptography.Encrypt(keyMaterial, payload.Message);

        foreach (var payloadFile in payload.Files)
        {
            payloadFile.Name = symmetricCryptography.Encrypt(keyMaterial, payloadFile.Name);
            var compressed = await TryCompressAsync(payloadFile.Data);
            if (compressed != null)
            {
                payloadFile.Data = compressed;
                payloadFile.IsCompressed = true;
            }
            payloadFile.Data = await symmetricCryptography.EncryptAsync(keyMaterial, payloadFile.Data);
        }
        
        logger.LogTrace("Finished payload encryption process");

        return payload;
    }

    public async Task<MessagePayload> DecryptPayloadAsync(string password, MessagePayload payload)
    {
        logger.LogTrace("Starting payload decryption process");

        var keyMaterial = HashingUtility.HashString(password);

        payload.Message = symmetricCryptography.Decrypt(keyMaterial, payload.Message);

        foreach (var payloadFile in payload.Files)
        {
            payloadFile.Name = symmetricCryptography.Decrypt(keyMaterial, payloadFile.Name);
            payloadFile.Data = await symmetricCryptography.DecryptAsync(keyMaterial, payloadFile.Data);
            if (payloadFile.IsCompressed)
            {
                payloadFile.Data = await DecompressAsync(payloadFile.Data);
                payloadFile.IsCompressed = false;
            }
        }
        
        logger.LogTrace("Finished payload decryption process");

        return payload;
    }
    
    public bool PayloadIsValid(string password, string token)
    {
        var keyMaterial = HashingUtility.HashString(password);
        
        return symmetricCryptography.Encrypt(keyMaterial, Convert.ToBase64String(keyMaterial)) == token;
    }

    private static async Task<byte[]?> TryCompressAsync(byte[] input)
    {
        if (input.Length < 1024) return null;

        using var output = new MemoryStream();
        using (var compression = new GZipOutputStream(output) { IsStreamOwner = false })
        {
            compression.SetLevel(1);
            for (var offset = 0; offset < input.Length; offset += 64 * 1024)
            {
                var count = Math.Min(64 * 1024, input.Length - offset);
                compression.Write(input, offset, count);
                await Task.Yield();
            }

            compression.Finish();
        }

        return output.Length < input.Length ? output.ToArray() : null;
    }

    private static async Task<byte[]> DecompressAsync(byte[] input)
    {
        using var compressed = new MemoryStream(input);
        using var decompression = new GZipInputStream(compressed);
        using var output = new MemoryStream();
        var buffer = new byte[64 * 1024];
        int bytesRead;
        while ((bytesRead = decompression.Read(buffer, 0, buffer.Length)) > 0)
        {
            if (output.Length + bytesRead > ChatConstants.MaxAttachmentBytes)
            {
                throw new InvalidDataException("Decompressed attachment exceeds the allowed size");
            }

            output.Write(buffer, 0, bytesRead);
            await Task.Yield();
        }

        return output.ToArray();
    }
}