const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("Call assets have stable content fingerprints, complete dependency copies and versioned links", t => {
    const project = fs.readFileSync(path.join(__dirname, "..", "UI", "UI.csproj"), "utf8");
    const target = project.match(/<Target Name="PrepareVersionedCallAssets"[\s\S]*?<\/Target>/)?.[0];
    assert.ok(target);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-call-assets-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(path.join(__dirname, "..", "UI", "wwwroot", "js"), path.join(root, "wwwroot", "js"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets.proj"), `<Project>${target}</Project>`);

    function build() {
        return JSON.parse(execFileSync("dotnet", [
            "msbuild", "assets.proj", "-nologo", "-verbosity:quiet",
            "-target:PrepareVersionedCallAssets", `-property:IntermediateOutputPath=obj${path.sep}`,
            "-getProperty:_CallAssetVersion", "-getItem:Content"
        ], { cwd: root, encoding: "utf8" }));
    }

    const first = build();
    const version = first.Properties._CallAssetVersion;
    assert.match(version, /^[0-9A-F]{64}$/);
    assert.equal(build().Properties._CallAssetVersion, version, "Unchanged content must keep its asset URLs");
    const links = first.Items.Content.map(item => item.Link.replaceAll("\\", "/"));
    for (const file of [
        "https-audio.js", "https-audio-worklet.js", "https-audio-crypto.js", "https-audio-opus.js",
        "https-audio-codec.js", "vendor/alawmulaw/mulaw.js", "vendor/alawmulaw/LICENSE",
        "voice-chat.js", "voice-crypto-worker.js", "voice-transcription.js", "transcription-worker.js",
        "screen-wake-lock.js", "media-defaults.js"
    ]) {
        const relative = file.split("/").join(path.sep);
        assert.ok(links.includes(`wwwroot/js/call/${version}/${file}`), `Missing versioned asset: ${file}`);
        assert.deepEqual(
            fs.readFileSync(path.join(root, "obj", "call-assets", version, relative)),
            fs.readFileSync(path.join(root, "wwwroot", "js", relative)));
    }
    fs.appendFileSync(path.join(root, "wwwroot", "js", "https-audio-worklet.js"), "\n");
    const workerVersion = build().Properties._CallAssetVersion;
    assert.notEqual(workerVersion, version, "Changing a worklet must invalidate its controller URL too");
    fs.appendFileSync(path.join(root, "wwwroot", "js", "vendor", "alawmulaw", "mulaw.js"), "\n");
    assert.notEqual(build().Properties._CallAssetVersion, workerVersion,
        "Changing a transitive dependency must invalidate the complete graph");
});
