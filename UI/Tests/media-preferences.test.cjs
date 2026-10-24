const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const storageKey = "SYMMETRIC_CRYPTO_FORCE_HTTPS_AUDIO";

async function harness(storage = new Map(), overrides = {}) {
    const context = vm.createContext({
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            ...overrides
        }
    });
    const source = await readFile(path.join(__dirname, "..", "wwwroot", "js", "media-defaults.js"), "utf8");
    const module = new vm.SourceTextModule(source, { context });
    await module.link(() => { throw new Error("Unexpected import"); });
    await module.evaluate();
    return module.namespace;
}

test("new browsers default to Automatic without writing a preference", async () => {
    const storage = new Map();
    const preferences = await harness(storage);
    assert.equal(preferences.getForceStealthPreference(), false);
    assert.equal(storage.size, 0);
});

test("both enabling and disabling Stealth survive a new page/module instance", async () => {
    const storage = new Map([["unrelated", "keep"]]);
    const firstVisit = await harness(storage);
    firstVisit.setForceStealthPreference(true);
    assert.equal(storage.get(storageKey), "true");
    const nextVisit = await harness(storage);
    assert.equal(nextVisit.getForceStealthPreference(), true);
    nextVisit.setForceStealthPreference(false);
    assert.equal(storage.get(storageKey), "false");
    assert.equal((await harness(storage)).getForceStealthPreference(), false);
    assert.equal(storage.get("unrelated"), "keep");
    assert.equal(storage.size, 2, "Only the audio-mode boolean is stored");
});

test("invalid stored values and nonboolean writes are rejected explicitly", async () => {
    const storage = new Map([[storageKey, "invalid"]]);
    const preferences = await harness(storage);
    assert.throws(() => preferences.getForceStealthPreference(), /preference is invalid/);
    for (const value of ["true", "false", 1, null, undefined]) {
        assert.throws(() => preferences.setForceStealthPreference(value), /must be a boolean/);
    }
    assert.equal(storage.get(storageKey), "invalid");
    preferences.setForceStealthPreference(true);
    assert.equal(preferences.getForceStealthPreference(), true, "An explicit user selection repairs an invalid preference");
});

test("blocked storage reads and writes propagate rather than pretending to persist", async () => {
    const preferences = await harness(new Map(), {
        getItem() { throw new Error("Storage access denied"); },
        setItem() { throw new Error("Storage quota exceeded"); }
    });
    assert.throws(() => preferences.getForceStealthPreference(), /Storage access denied/);
    assert.throws(() => preferences.setForceStealthPreference(true), /Storage quota exceeded/);
});

test("Blazor restores the preference before joining, saves toggle changes, and displays storage errors", async () => {
    const markup = await readFile(path.join(__dirname, "..", "Components", "VoiceChannel.razor"), "utf8");
    assert.match(markup, /@bind="_forceStealth" @bind:after="ForceStealthChanged" disabled="@\(_joined \|\| _busy \|\| !_stealthPreferenceLoaded\)"/);
    assert.match(markup, /OnAfterRenderAsync[\s\S]*?await EnsureStealthPreference\(\);/);
    const join = markup.slice(markup.indexOf("private async Task Join()"), markup.indexOf("private async Task<IJSObjectReference> InitializeWebRtc"));
    assert.ok(join.indexOf("await EnsureStealthPreference();") >= 0);
    assert.ok(join.indexOf("await EnsureStealthPreference();") < join.indexOf("_voiceCapabilities.ForceStealth = _forceStealth || _stealthForVisit"));
    assert.match(markup, /InvokeAsync<bool>\("getForceStealthPreference"\)/);
    assert.match(markup, /InvokeVoidAsync\("setForceStealthPreference", _forceStealth\)/);
    assert.equal((markup.match(/"import", CallAssetsPath \+ "media-defaults\.js"/g) || []).length, 3,
        "Preference and quality interop must use the matching versioned module, not a cached old module");
    assert.doesNotMatch(markup, /"import", "\.\/js\/media-defaults\.js"/);
    assert.match(markup, /role="alert">@_stealthPreferenceError/);
    assert.match(markup, /Logger\.LogWarning\(exception, "Unable to save the Stealth audio preference"\)/);
});
