using System.Text;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Security;

namespace UI;

public class SymmetricCryptography
{
    /// <summary>
    /// See: https://stackoverflow.com/a/75841861/1834787
    /// </summary>
    static byte[] Process(bool encrypt, byte[] keyBytes, byte[] input)
    {
        // Encryption/Decryption with AES-CTR using a static IV
        var cipher = CipherUtilities.GetCipher("AES/CTR/NoPadding");
        cipher.Init(encrypt, new ParametersWithIV(ParameterUtilities.CreateKeyParameter("AES", keyBytes), new byte[16]));
        return cipher.DoFinal(input);
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
}