using System.Text;
using Models;
using Org.BouncyCastle.Crypto.Digests;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Security;

namespace UI;

public class PayloadEncryptionService
{
    /// <summary>
    /// See: https://stackoverflow.com/a/75841861/1834787
    /// </summary>
    static byte[] Process(bool encrypt, string keyMaterial, byte[] input)
    {
        // Keyderivation via SHA256
        var keyMaterialBytes = Encoding.UTF8.GetBytes(keyMaterial);
        var digest = new Sha256Digest();
        digest.BlockUpdate(keyMaterialBytes, 0, keyMaterialBytes.Length);
        var keyBytes = new byte[digest.GetDigestSize()];
        digest.DoFinal(keyBytes, 0);

        // Encryption/Decryption with AES-CTR using a static IV
        var cipher = CipherUtilities.GetCipher("AES/CTR/NoPadding");
        cipher.Init(encrypt, new ParametersWithIV(ParameterUtilities.CreateKeyParameter("AES", keyBytes), new byte[16]));
        return cipher.DoFinal(input);
    }

    static string Encrypt(string keyMaterial, string plaintext)
    {
        var plaintextBytes = Encoding.UTF8.GetBytes(plaintext); // UTF-8 encode
        var ciphertextBytes = Process(true, keyMaterial, plaintextBytes);
        return Convert.ToBase64String(ciphertextBytes).Replace("+", "-").Replace("/", "_"); // Base64url encode
    }

    static string Decrypt(string keyMaterial, string ciphertext)
    {
        var ciphertextBytes = Convert.FromBase64String(ciphertext.Replace("-", "+").Replace("_", "/")); // Base64url decode
        var decryptedBytes = Process(false, keyMaterial, ciphertextBytes);
        return Encoding.UTF8.GetString(decryptedBytes); // UTF-8 decode
    }

    public MessagePayload EncryptPayload(string password, MessagePayload payload)
    {
        payload.Message = Encrypt(password, payload.Message);

        if (payload.File != null)
        {
            payload.File.Data = Encrypt(password, payload.Message);
        }

        return payload;
    }

    public MessagePayload DecryptPayload(string password, MessagePayload payload)
    {
        payload.Message = Decrypt(password, payload.Message);

        if (payload.File != null)
        {
            payload.File.Data = Decrypt(password, payload.Message);
        }

        return payload;
    }
    
    private static bool IsBase64String(string base64)
    {
        var buffer = new Span<byte>(new byte[base64.Length]);
        return Convert.TryFromBase64String(base64, buffer , out _);
    }

    public bool PayloadIsValid(MessagePayload payload)
    {
        return IsBase64String(payload.Message) && IsBase64String(payload.Name) &&
               payload.File != null && IsBase64String(payload.File.Data);
    }
}