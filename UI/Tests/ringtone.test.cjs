const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

async function createHarness() {
    const listeners = new Set();
    const warnings = [];
    const scope = vm.createContext({
        document: {
            addEventListener(event, callback, capture) {
                assert.equal(event, "click");
                assert.equal(capture, true);
                listeners.add(callback);
            },
            removeEventListener(event, callback, capture) {
                assert.equal(event, "click");
                assert.equal(capture, true);
                listeners.delete(callback);
            }
        },
        console: { warn: (...args) => warnings.push(args) }
    });
    const source = await readFile(path.join(__dirname, "..", "wwwroot", "js", "ringtone.js"), "utf8");
    const module = new vm.SourceTextModule(source, { context: scope });
    await module.link(() => { throw new Error("Ringtone playback must not import other modules"); });
    await module.evaluate();
    return {
        ringtone: module.namespace, listeners, warnings,
        click(isAnswerButton) {
            for (const callback of listeners) {
                callback({ target: {
                    closest: () => ({ closest: () => isAnswerButton ? {} : null })
                } });
            }
        }
    };
}

function audioElement(play = () => Promise.resolve()) {
    return {
        paused: true, currentTime: 12, loads: 0,
        play() {
            this.paused = false;
            return play();
        },
        pause() { this.paused = true; },
        load() { this.loads++; this.currentTime = 0; }
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test("stopping targets the original playing element even after the rendered element is replaced", async () => {
    const h = await createHarness();
    const original = audioElement();
    assert.equal(await h.ringtone.playRingtone(original), true);
    const replacement = audioElement();
    h.ringtone.stopRingtone();
    assert.equal(original.paused, true);
    assert.equal(original.currentTime, 0);
    assert.equal(original.loads, 1);
    assert.equal(replacement.loads, 0);
});

test("a delayed play completion cannot restart a stopped ringtone", async () => {
    const h = await createHarness();
    const pending = deferred();
    const audio = audioElement(() => pending.promise);
    const playing = h.ringtone.playRingtone(audio);
    h.ringtone.stopRingtone();
    audio.paused = false;
    pending.resolve();
    assert.equal(await playing, false);
    assert.equal(audio.paused, true);
    assert.equal(audio.currentTime, 0);
    assert.equal(h.warnings.length, 0);
});

test("a stale completion cannot stop a newer ring using the same audio element", async () => {
    const h = await createHarness();
    const pending = deferred();
    let attempts = 0;
    const audio = audioElement(() => attempts++ === 0 ? pending.promise : Promise.resolve());
    const stale = h.ringtone.playRingtone(audio);
    assert.equal(await h.ringtone.playRingtone(audio), true);
    pending.resolve();
    assert.equal(await stale, false);
    assert.equal(audio.paused, false);
    h.ringtone.stopRingtone();
    assert.equal(audio.paused, true);
});

test("answer and decline clicks stop audio synchronously before asynchronous call handling", async () => {
    const h = await createHarness();
    const audio = audioElement();
    await h.ringtone.playRingtone(audio);
    h.click(true);
    assert.equal(audio.paused, true);
    assert.equal(audio.currentTime, 0);
    await h.ringtone.playRingtone(audio);
    h.click(false);
    assert.equal(audio.paused, false);
    h.ringtone.dispose();
});

test("starting another ringtone stops the previously owned element", async () => {
    const h = await createHarness();
    const first = audioElement();
    const second = audioElement();
    await h.ringtone.playRingtone(first);
    await h.ringtone.playRingtone(second);
    assert.equal(first.paused, true);
    assert.equal(second.paused, false);
    assert.equal(h.listeners.size, 1);
    h.ringtone.dispose();
    assert.equal(second.paused, true);
});

test("playback cancellation is expected but real playback errors are logged", async () => {
    const h = await createHarness();
    const pending = deferred();
    const audio = audioElement(() => pending.promise);
    const playing = h.ringtone.playRingtone(audio);
    h.ringtone.stopRingtone();
    pending.reject(new Error("Playback aborted by stopping"));
    assert.equal(await playing, false);
    assert.equal(h.warnings.length, 0);
    const blocked = audioElement(() => Promise.reject(new Error("Autoplay blocked")));
    assert.equal(await h.ringtone.playRingtone(blocked), false);
    assert.equal(blocked.paused, true);
    assert.equal(h.warnings.length, 1);
});

test("disposal cancels pending audio, removes the click handler, and permits a later component to ring", async () => {
    const h = await createHarness();
    const pending = deferred();
    const audio = audioElement(() => pending.promise);
    const playing = h.ringtone.playRingtone(audio);
    h.ringtone.dispose();
    pending.resolve();
    assert.equal(await playing, false);
    assert.equal(audio.paused, true);
    assert.equal(h.listeners.size, 0);
    const next = audioElement();
    assert.equal(await h.ringtone.playRingtone(next), true);
    assert.equal(h.listeners.size, 1);
    h.ringtone.dispose();
});

test("missing ringtone elements fail explicitly", async () => {
    const h = await createHarness();
    await assert.rejects(h.ringtone.playRingtone(null), /audio element is unavailable/);
});
