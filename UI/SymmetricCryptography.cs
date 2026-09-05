using System.Text;
using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Security;

namespace UI;

public class SymmetricCryptography
{
    private const int ChunkSize = 64 * 1024;

    /// <summary>
    /// See: https://stackoverflow.com/a/75841861/1834787
    /// </summary>
    private static byte[] Process(bool encrypt, byte[] keyBytes, byte[] input)
    {
        return CreateCipher(encrypt, keyBytes).DoFinal(input);
    }

    public string Encrypt(byte[] keyMaterial, string plaintext)
    {
        var plaintextBytes = Encoding.UTF8.GetBytes(plaintext); // UTF-8 encode
        var ciphertextBytes = Process(true, keyMaterial, plaintextBytes);
        var ciphertext =  Convert.ToBase64String(ciphertextBytes).Replace("+", "-").Replace("/", "_"); // Base64url encode
        
        return ciphertext;
    }

    public  string Decrypt(byte[] keyMaterial, string ciphertext)
    {
        var ciphertextBytes = Convert.FromBase64String(ciphertext.Replace("-", "+").Replace("_", "/")); // Base64url decode
        var decryptedBytes = Process(false, keyMaterial, ciphertextBytes);
        var plaintext = Encoding.UTF8.GetString(decryptedBytes); // UTF-8 decode
        return plaintext;
    }

    public byte[] Encrypt(byte[] keyMaterial, byte[] plaintext)
    {
        return Process(true, keyMaterial, plaintext);
    }

    public byte[] Decrypt(byte[] keyMaterial, byte[] ciphertext)
    {
        return Process(false, keyMaterial, ciphertext);
    }

    public Task<byte[]> EncryptAsync(byte[] keyMaterial, byte[] plaintext)
    {
        return ProcessAsync(true, keyMaterial, plaintext);
    }

    public Task<byte[]> DecryptAsync(byte[] keyMaterial, byte[] ciphertext)
    {
        return ProcessAsync(false, keyMaterial, ciphertext);
    }

    private static async Task<byte[]> ProcessAsync(bool encrypt, byte[] keyBytes, byte[] input)
    {
        var cipher = CreateCipher(encrypt, keyBytes);

        var output = new byte[cipher.GetOutputSize(input.Length)];
        var outputOffset = 0;
        for (var inputOffset = 0; inputOffset < input.Length; inputOffset += ChunkSize)
        {
            var length = Math.Min(ChunkSize, input.Length - inputOffset);
            outputOffset += cipher.ProcessBytes(input, inputOffset, length, output, outputOffset);
            await Task.Yield();
        }

        outputOffset += cipher.DoFinal(output, outputOffset);
        return outputOffset == output.Length ? output : output[..outputOffset];
    }

    private static IBufferedCipher CreateCipher(bool encrypt, byte[] keyBytes)
    {
        var cipher = CipherUtilities.GetCipher("AES/CTR/NoPadding");
        cipher.Init(encrypt, new ParametersWithIV(
            ParameterUtilities.CreateKeyParameter("AES", keyBytes),
            new byte[16]));
        return cipher;
    }
}