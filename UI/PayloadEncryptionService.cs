using System.Security.Cryptography;
using System.Text;
using ICSharpCode.SharpZipLib.GZip;
using Microsoft.JSInterop;
using Models;
using Models.Constants;

namespace UI;

public class PayloadEncryptionService(
    SymmetricCryptography symmetricCryptography,
    ILogger<PayloadEncryptionService> logger,
    IJSRuntime jsRuntime)
{
    private const string TokenPrefix = "pbkdf2-sha256-v1:";
    private static readonly byte[] ConfirmationMessage = Encoding.UTF8.GetBytes("symmetric-crypto-chat-room/payload-key/v1");

    public async Task<string> DerivePushScopeAsync(string password, string channel)
    {
        var salt = HashingUtility.HashString($"symmetric-crypto-chat-room/push-salt/v1:{channel}")[..16];
        var keyMaterial = await DerivePayloadKeyAsync(password, salt);
        try
        {
            using var hmac = new HMACSHA256(keyMaterial);
            var scope = hmac.ComputeHash(Encoding.UTF8.GetBytes("symmetric-crypto-chat-room/push-scope/v1"));
            return Convert.ToBase64String(scope).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
        finally { CryptographicOperations.ZeroMemory(keyMaterial); }
    }

    public async Task<MessagePayload> EncryptPayloadAsync(string password, MessagePayload payload)
    {
        logger.LogTrace("Starting payload encryption process");

        var salt = RandomNumberGenerator.GetBytes(16);
        var keyMaterial = await DerivePayloadKeyAsync(password, salt);

        payload.Token = $"{TokenPrefix}{Convert.ToBase64String(salt)}:{Convert.ToBase64String(CreateConfirmation(keyMaterial))}";
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

    public async Task<bool> TryDecryptPayloadAsync(string password, MessagePayload payload)
    {
        logger.LogTrace("Starting payload decryption process");

        byte[] keyMaterial;
        bool passwordMatches;
        if (payload.Token?.StartsWith(TokenPrefix, StringComparison.Ordinal) == true)
        {
            var parts = payload.Token[TokenPrefix.Length..].Split(':');
            var salt = new byte[16];
            var confirmation = new byte[32];
            if (parts.Length != 2 ||
                !Convert.TryFromBase64String(parts[0], salt, out var saltLength) || saltLength != salt.Length ||
                !Convert.TryFromBase64String(parts[1], confirmation, out var confirmationLength) || confirmationLength != confirmation.Length)
            {
                logger.LogWarning("Received a payload with an invalid PBKDF2 token");
                return false;
            }
            keyMaterial = await DerivePayloadKeyAsync(password, salt);
            passwordMatches = CryptographicOperations.FixedTimeEquals(CreateConfirmation(keyMaterial), confirmation);
        }
        else
        {
            if (payload.Token?.Contains(':') == true)
            {
                logger.LogWarning("Received a payload with an unsupported encryption token version");
                return false;
            }
            keyMaterial = HashingUtility.HashString(password);
            passwordMatches = symmetricCryptography.Encrypt(keyMaterial, Convert.ToBase64String(keyMaterial)) == payload.Token;
        }

        if (!passwordMatches)
        {
            logger.LogDebug("Payload password validation failed; leaving encrypted contents unreadable");
            return false;
        }

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

        return true;
    }

    private static byte[] CreateConfirmation(byte[] keyMaterial)
    {
        using var hmac = new HMACSHA256(keyMaterial);
        return hmac.ComputeHash(ConfirmationMessage);
    }

    private async Task<byte[]> DerivePayloadKeyAsync(string password, byte[] salt)
    {
        await using var module = await jsRuntime.InvokeAsync<IJSObjectReference>(
            "import", "./js/password-key-derivation.js");
        return await module.InvokeAsync<byte[]>("derivePayloadKey", password, salt);
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