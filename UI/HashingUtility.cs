using System.Security.Cryptography;
using System.Text;
using Org.BouncyCastle.Crypto.Digests;

namespace UI;

public class HashingUtility
{
    public byte[] HashString(string keyMaterial)
    {
        // Key derivation via SHA256
        var keyMaterialBytes = Encoding.UTF8.GetBytes(keyMaterial);
        var digest = new Sha256Digest();
        digest.BlockUpdate(keyMaterialBytes, 0, keyMaterialBytes.Length);
        var keyBytes = new byte[digest.GetDigestSize()];
        digest.DoFinal(keyBytes, 0);

        return keyBytes;
    }

    public byte[] DeriveVoiceKey(string password, string channel)
    {
        return Rfc2898DeriveBytes.Pbkdf2(
            password,
            Encoding.UTF8.GetBytes($"voice:{channel}"),
            210_000,
            HashAlgorithmName.SHA256,
            32);
    }
}