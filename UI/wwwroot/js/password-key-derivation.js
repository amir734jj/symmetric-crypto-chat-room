export async function derivePayloadKey(password, salt) {
    if (!(salt instanceof Uint8Array) || salt.length !== 16) {
        throw new TypeError("Payload key derivation requires a 16-byte salt");
    }
    if (typeof password !== "string") throw new TypeError("Password must be a string");
    if (!globalThis.crypto?.subtle) {
        throw new Error("Password encryption requires Web Crypto over HTTPS or localhost");
    }

    const passwordKey = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const key = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations: 210000 },
        passwordKey,
        256);
    return new Uint8Array(key);
}
