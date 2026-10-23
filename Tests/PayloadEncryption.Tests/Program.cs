global using Microsoft.Extensions.Logging;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.JSInterop;
using Models;
using UI;

foreach (var (password, channel, expectedHex) in new[]
{
    ("cat", "public", "56618186cf40374fe1ecaea0b787d4171b7efa40b03ceffe66932588687e8cc5"),
    ("p\u00e4ss\uD83D\uDD11", "private-room", "d32c2bab084296b3e9a066d7959d4cf53d516c6d03fdc19cf2fea712bddf6a5f")
})
{
    Check(HashingUtility.DeriveVoiceKey(password, channel).SequenceEqual(Convert.FromHexString(expectedHex)),
        "C# voice derivation must match independent PBKDF2-SHA256 vectors without changing existing media keys");
}
Console.WriteLine("PASS: C# voice key derivation matches independent short-password and Unicode PBKDF2 vectors");

var cipher = new SymmetricCryptography();
var keyDerivation = new TestKeyDerivation();
var service = new PayloadEncryptionService(cipher, NullLogger<PayloadEncryptionService>.Instance, keyDerivation);

var compressedBytes = Enumerable.Repeat((byte)65, 4096).ToArray();
var binaryBytes = new byte[] { 0, 1, 2, 128, 255 };
var payload = new MessagePayload
{
    Channel = "public", Name = "Alice", Message = "Hello, encrypted world!",
    Files =
    [
        new() { Name = "large.txt", Data = compressedBytes.ToArray(), ContentType = "text/plain" },
        new() { Name = "small.bin", Data = binaryBytes.ToArray(), ContentType = "application/octet-stream" }
    ]
};
const string sharedPassword = "local-only-secret-password";
await service.EncryptPayloadAsync(sharedPassword, payload);
Check(payload.Token.StartsWith("pbkdf2-sha256-v1:", StringComparison.Ordinal), "New messages must use the versioned PBKDF2 format");
Check(payload.Message != "Hello, encrypted world!", "Message text must be encrypted");
Check(payload.Files.All(file => file.Name != "large.txt" && file.Name != "small.bin"), "Filenames must be encrypted");
Check(payload.Files[0].IsCompressed, "Compressible attachments must retain compression");
Check(!payload.Files[1].IsCompressed, "Small binary attachments must retain their original format");
Check(!payload.Files[0].Data.SequenceEqual(compressedBytes) && !payload.Files[1].Data.SequenceEqual(binaryBytes),
    "All attachment contents must be encrypted");
var tokenParts = payload.Token.Split(':');
var publicSalt = Convert.FromBase64String(tokenParts[1]);
var confirmation = Convert.FromBase64String(tokenParts[2]);
Check(tokenParts.Length == 3 && publicSalt.Length == 16 && confirmation.Length == 32,
    "The token must contain only its version, 16-byte salt, and 32-byte HMAC");
var independentKey = Rfc2898DeriveBytes.Pbkdf2(sharedPassword, publicSalt, 210_000, HashAlgorithmName.SHA256, 32);
var expectedConfirmation = HMACSHA256.HashData(
    independentKey, Encoding.UTF8.GetBytes("symmetric-crypto-chat-room/payload-key/v1"));
Check(confirmation.SequenceEqual(expectedConfirmation), "The confirmation must be an HMAC, not the password or key");
Check(!confirmation.SequenceEqual(independentKey), "The derived key must not be transmitted as the confirmation");
var wirePayload = JsonSerializer.Serialize(payload);
Check(!wirePayload.Contains(sharedPassword, StringComparison.Ordinal) &&
    !wirePayload.Contains(Convert.ToBase64String(independentKey), StringComparison.Ordinal),
    "Serialized payloads must not include the password or raw derived key");
Check(!await service.TryDecryptPayloadAsync("incorrect-password", payload), "Wrong passwords must leave messages unreadable");
Check(JsonSerializer.Serialize(payload) == wirePayload, "Wrong-password validation must not mutate ciphertext");
var receiver = new PayloadEncryptionService(cipher, NullLogger<PayloadEncryptionService>.Instance, keyDerivation);
Check(await receiver.TryDecryptPayloadAsync(sharedPassword, payload), "Another client must decrypt with the same password");
Check(payload.Message == "Hello, encrypted world!" && payload.Files[0].Name == "large.txt" &&
    payload.Files[1].Name == "small.bin", "Message text and filenames must round-trip");
Check(payload.Files[0].Data.SequenceEqual(compressedBytes) && payload.Files[1].Data.SequenceEqual(binaryBytes) &&
    payload.Files.All(file => !file.IsCompressed), "Compressed and binary attachments must round-trip");
Console.WriteLine("PASS: random-salt token format, local-only secrets, wrong-password isolation, text, filenames, and compressed/binary attachments");

var first = await service.EncryptPayloadAsync("cat", new MessagePayload { Message = "Same text" });
var second = await service.EncryptPayloadAsync("cat", new MessagePayload { Message = "Same text" });
Check(first.Token.Split(':')[1] != second.Token.Split(':')[1] && first.Message != second.Message,
    "Repeated messages must use distinct salts and derived keys");
Check(await receiver.TryDecryptPayloadAsync("cat", first) && await receiver.TryDecryptPayloadAsync("cat", second),
    "Short passwords must work without padding");
var empty = await service.EncryptPayloadAsync("cat", new MessagePayload());
Check(await receiver.TryDecryptPayloadAsync("cat", empty) && empty.Message == string.Empty,
    "Empty message text must round-trip for attachment-only messages");
Console.WriteLine("PASS: fresh per-message salts, short passwords, and empty text");

var legacyKey = HashingUtility.HashString("old-password");
var legacy = new MessagePayload
{
    Message = cipher.Encrypt(legacyKey, "Cached text"),
    Token = cipher.Encrypt(legacyKey, Convert.ToBase64String(legacyKey)),
    Files = [new() { Name = cipher.Encrypt(legacyKey, "cached.bin"), Data = cipher.Encrypt(legacyKey, binaryBytes) }]
};
Check(!await receiver.TryDecryptPayloadAsync("wrong-password", legacy), "Wrong passwords must not unlock legacy messages");
Check(await receiver.TryDecryptPayloadAsync("old-password", legacy) && legacy.Message == "Cached text" &&
    legacy.Files[0].Name == "cached.bin" && legacy.Files[0].Data.SequenceEqual(binaryBytes),
    "Legacy SHA-256 messages and attachments must remain decryptable");
Console.WriteLine("PASS: legacy cached messages and attachments remain readable");

var log = new WarningRecorder();
var loggedService = new PayloadEncryptionService(cipher, log, keyDerivation);
foreach (var invalidToken in new[]
{
    "pbkdf2-sha256-v1:",
    "pbkdf2-sha256-v1:not-base64:invalid",
    $"pbkdf2-sha256-v1:{Convert.ToBase64String(new byte[15])}:{Convert.ToBase64String(new byte[32])}",
    $"pbkdf2-sha256-v1:{Convert.ToBase64String(new byte[16])}:{Convert.ToBase64String(new byte[31])}",
    $"pbkdf2-sha256-v1:{Convert.ToBase64String(new byte[16])}:{Convert.ToBase64String(new byte[32])}:extra",
    "pbkdf2-sha256-v2:unsupported",
    "unknown-version:value"
})
{
    var invalid = new MessagePayload { Token = invalidToken, Message = "ciphertext" };
    var warningsBefore = log.Warnings;
    Check(!await loggedService.TryDecryptPayloadAsync("cat", invalid) && invalid.Message == "ciphertext",
        "Malformed or unsupported versioned tokens must stay unreadable without a legacy fallback");
    Check(log.Warnings == warningsBefore + 1, "Invalid token formats must be reported explicitly");
}
Console.WriteLine("PASS: malformed salts, confirmations, and unsupported versions are logged and rejected");

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

sealed class WarningRecorder : ILogger<PayloadEncryptionService>
{
    public int Warnings { get; private set; }
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (logLevel == LogLevel.Warning) Warnings++;
    }

}

sealed class TestKeyDerivation : IJSRuntime, IJSObjectReference
{
    public ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args) =>
        InvokeAsync<TValue>(identifier, CancellationToken.None, args);

    public ValueTask<TValue> InvokeAsync<TValue>(string identifier, CancellationToken cancellationToken, object?[]? args)
    {
        if (identifier == "import" && args is ["./js/password-key-derivation.js"])
        {
            return ValueTask.FromResult((TValue)(object)this);
        }
        if (identifier == "derivePayloadKey" && args is [string password, byte[] salt] && salt.Length == 16)
        {
            return ValueTask.FromResult((TValue)(object)Rfc2898DeriveBytes.Pbkdf2(
                password, salt, 210_000, HashAlgorithmName.SHA256, 32));
        }
        throw new InvalidOperationException($"Unexpected key derivation interop: {identifier}");
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
