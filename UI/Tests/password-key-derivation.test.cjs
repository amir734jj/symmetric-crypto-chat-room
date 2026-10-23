const assert = require("node:assert/strict");
const { pbkdf2Sync, webcrypto } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

async function createHarness(crypto = webcrypto) {
    const scope = vm.createContext({ crypto, TextEncoder, Uint8Array, TypeError });
    const source = await readFile(path.join(
        __dirname, "..", "wwwroot", "js", "password-key-derivation.js"), "utf8");
    const module = new vm.SourceTextModule(source, { context: scope });
    await module.link(() => { throw new Error("Password derivation must not import remote code"); });
    await module.evaluate();
    return module.namespace;
}

test("Web Crypto derives standard 256-bit PBKDF2-SHA256 keys without padding passwords", async () => {
    const { derivePayloadKey } = await createHarness();
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
    for (const password of ["x", "cat", " spaces stay ", "p\u00e4ss\u{1f511}"]) {
        const actual = await derivePayloadKey(password, salt);
        const expected = pbkdf2Sync(password, salt, 210000, 32, "sha256");
        assert.equal(actual.length, 32);
        assert.deepEqual(Buffer.from(actual), expected);
    }
    assert.notDeepEqual(await derivePayloadKey("cat", salt), await derivePayloadKey("cat000", salt));
    const otherSalt = salt.slice();
    otherSalt[0]++;
    assert.notDeepEqual(await derivePayloadKey("cat", salt), await derivePayloadKey("cat", otherSalt));
});

test("invalid passwords and salts fail explicitly", async () => {
    const { derivePayloadKey } = await createHarness();
    await assert.rejects(derivePayloadKey(null, new Uint8Array(16)), /Password must be a string/);
    for (const salt of [null, [], new Uint8Array(8), new Uint8Array(17)]) {
        await assert.rejects(derivePayloadKey("cat", salt), /16-byte salt/);
    }
});

test("Web Crypto failures propagate instead of falling back to weaker derivation", async () => {
    const { derivePayloadKey } = await createHarness({
        subtle: { importKey: async () => { throw new Error("Web Crypto unavailable"); } }
    });
    await assert.rejects(derivePayloadKey("cat", new Uint8Array(16)), /Web Crypto unavailable/);
});

test("missing Web Crypto reports the secure-context requirement", async () => {
    const { derivePayloadKey } = await createHarness(null);
    await assert.rejects(derivePayloadKey("cat", new Uint8Array(16)), /HTTPS or localhost/);
});
