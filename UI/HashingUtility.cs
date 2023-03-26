using System.Text;
using Org.BouncyCastle.Crypto.Digests;

namespace UI;

public class HashingUtility
{
    public byte[] HashString(string keyMaterial)
    {
        // Keyderivation via SHA256
        var keyMaterialBytes = Encoding.UTF8.GetBytes(keyMaterial);
        var digest = new Sha256Digest();
        digest.BlockUpdate(keyMaterialBytes, 0, keyMaterialBytes.Length);
        var keyBytes = new byte[digest.GetDigestSize()];
        digest.DoFinal(keyBytes, 0);

        return keyBytes;
    }
}