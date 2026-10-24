const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");

const directory = path.join(__dirname, "..", "wwwroot", "js");
const key = Buffer.alloc(32, 7).toString("base64");
function modules(extra = {}) {
    const context = vm.createContext({
        crypto: webcrypto, TextEncoder, Uint8Array, Float32Array, DataView, URL,
        atob, btoa, console, setTimeout, clearTimeout, ...extra
    });
    const cache = new Map();
    async function load(name) {
        if (cache.has(name)) return cache.get(name);
        const module = new vm.SourceTextModule(fs.readFileSync(path.join(directory, name), "utf8"), {
            context, identifier: name,
            initializeImportMeta(meta) { meta.url = `https://localhost/js/${name}`; }
        });
        cache.set(name, module);
        await module.link(specifier => load(path.join(path.dirname(name), specifier)));
        return module;
    }
    return async name => {
        const module = await load(name);
        if (module.status !== "evaluated") await module.evaluate();
        return module.namespace;
    };
}
const waitUntil = async predicate => {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("Timed out waiting for audio operation");
};

test("Stealth frames use authenticated, domain-separated encryption with replay protection", async () => {
    const { createAudioCipher, encryptedAudioFrameSize } = await modules()("https-audio-crypto.js");
    const sender = await createAudioCipher(key);
    const recipient = await createAudioCipher(key);
    const clear = Uint8Array.from({ length: 320 }, (_, index) => index % 256);
    const first = await sender.encrypt(clear);
    const second = await sender.encrypt(clear);
    assert.equal(encryptedAudioFrameSize, 361);
    assert.equal(first.length, 361);
    assert.equal(first[0], 1);
    assert.equal(new DataView(first.buffer).getBigUint64(17), 1n);
    assert.equal(new DataView(second.buffer).getBigUint64(17), 2n);
    assert.notDeepEqual(first.subarray(25, 345), clear);
    assert.notDeepEqual(first, second);
    const receiver = {};
    assert.deepEqual(await recipient.decrypt(first, receiver), clear);
    assert.deepEqual(await recipient.decrypt(second, receiver), clear);
    await assert.rejects(recipient.decrypt(first, receiver), /Repeated/);
    await assert.rejects(recipient.decrypt(second, receiver), /Repeated/);
    const another = await createAudioCipher(key);
    const otherFrame = await another.encrypt(clear);
    assert.notDeepEqual(otherFrame.subarray(1, 17), first.subarray(1, 17));
    await assert.rejects(recipient.decrypt(otherFrame, receiver), /stream changed/);
    for (const position of [0, 1, 16, 17, 24, 25, 360]) {
        const changed = first.slice();
        changed[position] ^= 1;
        const state = {};
        await assert.rejects(recipient.decrypt(changed, state));
        assert.equal(state.counter, undefined, "Unauthenticated frames must not advance replay state");
    }
    await assert.rejects(recipient.decrypt(first.subarray(1), {}), /Invalid/);
    const wrong = await createAudioCipher(Buffer.alloc(32, 9).toString("base64"));
    await assert.rejects(wrong.decrypt(first, {}), { name: "OperationError" });
    const rawKey = await webcrypto.subtle.importKey("raw", Buffer.from(key, "base64"), "AES-GCM", false, ["decrypt"]);
    const iv = new Uint8Array(12);
    iv.set(first.subarray(1, 5));
    iv.set(first.subarray(17, 25), 4);
    await assert.rejects(webcrypto.subtle.decrypt({
        name: "AES-GCM", iv, additionalData: first.subarray(0, 25)
    }, rawKey, first.subarray(25)), { name: "OperationError" });
    await assert.rejects(sender.encrypt(new Uint8Array(319)), /Invalid/);
    await assert.rejects(createAudioCipher(""), /256-bit/);
});

test("G.711 codec matches standard vectors and keeps samples finite and bounded", async () => {
    const codec = await modules()("https-audio-codec.js");
    assert.equal(codec.audioSampleRate, 8000);
    assert.equal(codec.audioFrameSamples, 320);
    assert.equal(codec.encodeMuLaw(0), 0xff);
    assert.equal(codec.encodeMuLaw(1), 0x80);
    assert.equal(codec.encodeMuLaw(-1), 0);
    assert.equal(codec.decodeMuLaw(0xff), 0);
    assert.equal(codec.decodeMuLaw(0x7f), 0);
    assert.equal(codec.decodeMuLaw(0x80), 32124 / 32768);
    assert.equal(codec.decodeMuLaw(0), -32124 / 32768);
    for (let value = -1; value <= 1; value += 0.005) {
        assert.ok(Math.abs(codec.decodeMuLaw(codec.encodeMuLaw(value)) - value) < 0.035);
    }
});

test("Library G.711 remains wire-compatible for every PCM16 sample and every encoded byte", async () => {
    const codec = await modules()("https-audio-codec.js");
    const encoded = Uint8Array.from({ length: 65536 }, (_, index) => codec.encodeMuLaw((index - 32768) / 32768));
    const decoded = Float32Array.from({ length: 256 }, (_, index) => codec.decodeMuLaw(index));
    assert.equal(createHash("sha256").update(encoded).digest("hex"),
        "5ee7cf5f273f842d2234121e4cb0c98d6b20a99ac29026f94e05b36955b195be");
    assert.equal(createHash("sha256").update(new Uint8Array(decoded.buffer)).digest("hex"),
        "34371823a5daca165d7cae3c7afa7ea7683ab9176cc8423deaa23c97199adc7f");
    assert.equal(codec.encodeMuLaw(2), codec.encodeMuLaw(1));
    assert.equal(codec.encodeMuLaw(-2), codec.encodeMuLaw(-1));
});

for (const opus of [false, true]) {
    const rate = opus ? 48000 : 8000;
    test(`Audio worklet uses native ${rate} Hz capture, mutes and bounds playback`, async () => {
        let Processor;
        class Base {
            constructor() {
                this.messages = [];
                this.port = { postMessage: message => this.messages.push(message) };
            }
        }
        const load = modules({
            sampleRate: rate, AudioWorkletProcessor: Base,
            registerProcessor(name, type) { assert.equal(name, "https-audio"); Processor = type; }
        });
        await load("https-audio-worklet.js");
        const processor = new Processor({ processorOptions: { opus } });
        const output = new Float32Array(128);
        for (let index = 0; index < 150; index++) {
            processor.process([[new Float32Array(128).fill(0.25)]], [[output]]);
        }
        const captures = processor.messages.filter(message => message.type === "capture");
        const frameSamples = opus ? 1920 : 320;
        assert.equal(captures.length, Math.floor(150 * 128 / frameSamples));
        assert.ok(captures.every(message => message.samples.length === frameSamples));
        processor.port.onmessage({ data: { type: "muted", muted: true } });
        for (let index = 0; index < 30; index++) processor.process([[new Float32Array(128)]], [[output]]);
        assert.equal(processor.messages.length, captures.length);
        const samples = opus ? new Float32Array(frameSamples).fill(0.98) : new Uint8Array(frameSamples).fill(0x80);
        processor.port.onmessage({ data: { type: "audio", id: "peer", samples } });
        processor.process([[]], [[output]]);
        assert.ok(output.every(value => value === 0), "Playback must wait for its jitter buffer");
        processor.port.onmessage({ data: { type: "audio", id: "peer", samples } });
        processor.process([[]], [[output]]);
        assert.ok(output.some(value => value > 0.9));
        for (let index = 0; index < 12; index++)
            processor.port.onmessage({ data: { type: "audio", id: "peer", samples } });
        assert.equal(processor.peers.get("peer").count, rate * 0.4);
        assert.ok(processor.messages.some(message => message.type === "playback-overrun"));
        processor.port.onmessage({ data: { type: "peers", ids: [] } });
        processor.process([[]], [[output]]);
        assert.equal(processor.peers.size, 0);
        assert.ok(output.every(value => value === 0));
    });
}

test("Worklet rejects a mismatched context instead of silently resampling or mislabeling audio", async () => {
    let Processor;
    await modules({
        sampleRate: 44100, AudioWorkletProcessor: class {},
        registerProcessor(name, type) { Processor = type; }
    })("https-audio-worklet.js");
    assert.throws(() => new Processor(), /8000 Hz AudioContext/);
    assert.throws(() => new Processor({ processorOptions: { opus: true } }), /48000 Hz AudioContext/);
});

function audioHarness(extra = {}) {
    const h = { now: 0, calls: [], contexts: [], requests: [], nodes: [], streams: [] };
    h.makeStream = () => {
        const track = {
            enabled: true, stopped: false, stop() { this.stopped = true; },
            addEventListener(name, callback) { this[name] = callback; }
        };
        const stream = { track, getTracks: () => [track], getAudioTracks: () => [track] };
        h.streams.push(stream);
        return stream;
    };
    class Context {
        constructor(options) {
            this.state = "running";
            this.sampleRate = h.sampleRate ?? options.sampleRate;
            this.destination = {};
            this.audioWorklet = { addModule: async () => { if (h.workletError) throw h.workletError; } };
            h.contexts.push(this);
        }
        async resume() {}
        async close() { this.state = "closed"; }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    }
    class Node {
        constructor() {
            this.messages = [];
            this.port = { postMessage: data => this.messages.push(data), close() {} };
            h.nodes.push(this);
        }
        connect() {}
        disconnect() {}
    }
    h.reference = { async invokeMethodAsync(method, ...args) {
        h.calls.push({ method, args });
        if (method === "SendHttpsAudio" && h.send) await h.send(...args);
    } };
    h.load = modules({
        AudioContext: Context, AudioWorkletNode: Node,
        performance: { now: () => h.now },
        setInterval(callback) { h.tick = callback; return 1; }, clearInterval() { h.tick = undefined; },
        navigator: { mediaDevices: { getUserMedia: async options => {
            h.requests.push(options);
            return h.capture ? h.capture() : h.makeStream();
        } } }, ...extra
    });
    h.captureFrame = () => h.nodes.at(-1).port.onmessage({
        data: { type: "capture", samples: new Uint8Array(320).fill(0xcc) }
    });
    h.sent = () => h.calls.filter(call => call.method === "SendHttpsAudio");
    return h;
}

test("Variable-sized Opus frames authenticate codec, payload and replay counter", async () => {
    const { createAudioCipher } = await modules()("https-audio-crypto.js");
    const cipher = await createAudioCipher(key, true);
    const other = await createAudioCipher(key, true);
    for (const size of [1, 120, 256, 4096]) {
        const clear = new Uint8Array(size).fill(0x5a);
        const packet = await cipher.encrypt(clear);
        assert.equal(packet.length, size + 41);
        assert.equal(packet[0], 2);
        const state = {};
        assert.deepEqual(await other.decrypt(packet, state), clear);
        await assert.rejects(other.decrypt(packet, state), /Repeated/);
        const compatibility = await createAudioCipher(key);
        await assert.rejects(compatibility.decrypt(packet, {}), /Invalid/);
        const tampered = packet.slice();
        tampered[0] = 1;
        await assert.rejects(other.decrypt(tampered, {}), /Invalid/);
    }
    await assert.rejects(cipher.encrypt(new Uint8Array(0)), /Invalid/);
    await assert.rejects(cipher.encrypt(new Uint8Array(4097)), /Invalid/);
    const epochCipher = await createAudioCipher(key, true, 17);
    const epochPacket = await epochCipher.encrypt(new Uint8Array([1, 2, 3]));
    await assert.rejects((await createAudioCipher(key, true, 18)).decrypt(epochPacket, {}), { name: "OperationError" });
    await assert.rejects(createAudioCipher(key, true, -1), /revision/);
});

function wakeHarness({ mobile = true, supported = true, request, logger = console } = {}) {
    const listeners = new Map();
    const locks = [];
    const document = {
        visibilityState: "visible",
        addEventListener: (name, handler) => listeners.set(name, handler),
        removeEventListener: name => listeners.delete(name)
    };
    function newLock() {
        const handlers = new Map();
        const lock = {
            released: false,
            addEventListener: (name, handler) => handlers.set(name, handler),
            async release() { this.released = true; handlers.get("release")?.(); }
        };
        locks.push(lock);
        return lock;
    }
    const h = audioHarness({
        document, console: logger,
        navigator: {
            userAgent: mobile ? "Android" : "Windows NT",
            ...(supported ? { wakeLock: { request: request ?? (async type => {
                assert.equal(type, "screen");
                return newLock();
            }) } } : {})
        }
    });
    return {
        ...h, locks, listeners, newLock,
        async visibilityChanged(value) {
            document.visibilityState = value;
            listeners.get("visibilitychange")?.();
            await new Promise(setImmediate);
        }
    };
}

test("Stealth mobile wake lock works without microphone capture and is reacquired, disabled and released", async () => {
    const h = wakeHarness();
    const audio = await h.load("https-audio.js");
    assert.equal(audio.supportsMobileScreenWakeLock(), true);
    assert.equal(await audio.setKeepScreenOn(true), false, "A wake lock requires an active call");
    assert.equal(h.listeners.size, 0);
    await audio.initialize(h.reference, key);
    assert.equal(await audio.setKeepScreenOn(true), true);
    assert.equal(JSON.parse(audio.getConnectionDiagnostics()).screenWakeLockActive, true);
    assert.equal(h.requests.length, 0, "Waiting alone must not request microphone capture");
    await h.visibilityChanged("hidden");
    await h.locks[0].release();
    await h.visibilityChanged("visible");
    assert.equal(h.locks.length, 2);
    assert.equal(await audio.setKeepScreenOn(false), false);
    assert.equal(h.locks[1].released, true);
    assert.equal(h.listeners.size, 0);
    assert.equal(await audio.setKeepScreenOn(true), true);
    await audio.leave();
    assert.equal(h.locks[2].released, true);
    assert.equal(h.listeners.size, 0);
    assert.equal(JSON.parse(audio.getConnectionDiagnostics()).screenWakeLockActive, false);
});

for (const options of [{ mobile: false }, { supported: false }]) {
    test(`Stealth does not acquire a wake lock when mobile=${options.mobile ?? true}, supported=${options.supported ?? true}`, async () => {
        const h = wakeHarness(options);
        const audio = await h.load("https-audio.js");
        await audio.initialize(h.reference, key);
        assert.equal(audio.supportsMobileScreenWakeLock(), false);
        assert.equal(await audio.setKeepScreenOn(true), false);
        assert.equal(h.locks.length, 0);
        assert.equal(h.listeners.size, 0);
        await audio.leave();
    });
}

for (const action of ["disable", "leave", "rejoin"]) {
    test(`Stealth releases a delayed wake lock after ${action}`, async () => {
        let resolve;
        const pending = new Promise(complete => { resolve = complete; });
        const h = wakeHarness({ request: () => pending });
        const audio = await h.load("https-audio.js");
        await audio.initialize(h.reference, key);
        const starting = audio.setKeepScreenOn(true);
        if (action === "disable") await audio.setKeepScreenOn(false);
        else await audio.leave();
        if (action === "rejoin") await audio.initialize(h.reference, key);
        const lock = h.newLock();
        resolve(lock);
        assert.equal(await starting, false);
        assert.equal(lock.released, true);
        assert.equal(h.listeners.size, 0);
        await audio.leave();
    });
}

test("Stealth wake-lock denial is reported without ending the encrypted call", async () => {
    const warnings = [];
    const h = wakeHarness({
        request: async () => { throw new Error("Permission denied"); },
        logger: { ...console, warn: (...args) => warnings.push(args) }
    });
    const audio = await h.load("https-audio.js");
    await audio.initialize(h.reference, key);
    assert.equal(await audio.setKeepScreenOn(true), false);
    assert.ok(warnings.some(([message]) => message.includes("Unable to keep the screen awake")));
    assert.equal(h.listeners.size, 0);
    const diagnostics = JSON.parse(audio.getConnectionDiagnostics());
    assert.equal(diagnostics.active, true);
    assert.equal(diagnostics.encrypted, true);
    assert.equal(diagnostics.screenWakeLockActive, false);
    await audio.leave();
});

test("Blazor configures wake locks in both transports and routes the toggle to the active audio module", () => {
    const markup = fs.readFileSync(path.join(__dirname, "..", "Components", "VoiceChannel.razor"), "utf8");
    assert.match(markup, /await ConfigureScreenWakeLock\(_module\)/);
    assert.match(markup, /if \(_useHttpsAudio\)[\s\S]*?await ConfigureScreenWakeLock\(module\)/);
    const handler = markup.slice(markup.indexOf("private async Task KeepScreenOnChanged()"), markup.indexOf("private async Task ToggleVideo()"));
    assert.match(handler, /var module = ActiveAudioModule/);
    assert.match(handler, /module\.InvokeAsync<bool>\("setKeepScreenOn", enabled\)/);
    assert.match(handler, /revision != _mediaRevision/);
    assert.match(handler, /request != _wakeLockRequestVersion/);
});

function nativeCodecs(encoderSupported = true, decoderSupported = true) {
    const instances = { encoders: [], decoders: [], audio: [] };
    class Data {
        constructor(config) {
            Object.assign(this, config);
            instances.audio.push(this);
        }
        copyTo(destination) { destination.fill(0.25); }
        close() { this.closed = true; }
    }
    class Encoder {
        static async isConfigSupported(config) { return { supported: encoderSupported, config }; }
        constructor(callbacks) { this.callbacks = callbacks; this.encodeQueueSize = 0; instances.encoders.push(this); }
        configure(config) { this.config = config; this.state = "configured"; }
        encode(audio) {
            this.lastAudio = audio;
            this.callbacks.output({ byteLength: 3, copyTo(bytes) { bytes.set([0xf8, 0xff, 0xfe]); } });
        }
        close() { this.state = "closed"; }
    }
    class Decoder {
        static async isConfigSupported(config) { return { supported: decoderSupported, config }; }
        constructor(callbacks) { this.callbacks = callbacks; this.decodeQueueSize = 0; instances.decoders.push(this); }
        configure(config) { this.config = config; this.state = "configured"; }
        decode(chunk) {
            this.lastChunk = chunk;
            this.callbacks.output(new Data({ numberOfFrames: 1920, sampleRate: 48000 }));
        }
        close() { this.state = "closed"; }
    }
    return { instances, AudioEncoder: Encoder, AudioDecoder: Decoder, AudioData: Data,
        EncodedAudioChunk: class { constructor(config) { Object.assign(this, config); } } };
}

test("Native Opus capability checks require both directions and the exact frame configuration", async () => {
    for (const [encoder, decoder, expected] of [[true, true, true], [true, false, false], [false, true, false]]) {
        const codecs = nativeCodecs(encoder, decoder);
        const h = audioHarness(codecs);
        const audio = await h.load("https-audio.js");
        assert.equal((await audio.getCapabilities()).supportsOpus, expected);
        assert.ok(codecs.instances.encoders.every(encoder => encoder.state === "closed"),
            "Synthetic capability probes must release their codecs");
        assert.equal(h.requests.length, 0);
    }
    const codecs = nativeCodecs();
    codecs.AudioEncoder.isConfigSupported = async config => ({
        supported: true, config: { ...config, opus: { frameDuration: 20000 } }
    });
    const h = audioHarness(codecs);
    assert.equal((await (await h.load("https-audio.js")).getCapabilities()).supportsOpus, false);
    const unavailable = audioHarness();
    assert.equal((await (await unavailable.load("https-audio.js")).getCapabilities()).supportsOpus, false);
});

test("Unsupported native Opus fails closed instead of silently sending a different codec", async () => {
    const h = audioHarness(nativeCodecs(true, false));
    const audio = await h.load("https-audio.js");
    await assert.rejects(audio.initialize(h.reference, key, true), /not supported/);
    assert.equal(h.sent().length, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(JSON.parse(audio.getConnectionDiagnostics()).encrypted, false);
});

test("Native Opus packets preserve decoder metadata and reject malformed descriptions", async () => {
    const { packOpusChunk, unpackOpusPacket } = await modules()("https-audio-opus.js");
    const description = new Uint8Array([79, 112, 117, 115]);
    const chunk = { byteLength: 3, copyTo(destination) { destination.set([1, 2, 3]); } };
    const packet = packOpusChunk(chunk, description);
    const unpacked = unpackOpusPacket(packet);
    assert.deepEqual(unpacked.description, description);
    assert.deepEqual(unpacked.data, new Uint8Array([1, 2, 3]));
    assert.deepEqual(unpackOpusPacket(packOpusChunk(chunk)).description, new Uint8Array());
    assert.throws(() => packOpusChunk(chunk, new Uint8Array(257)), /too large/);
    for (const invalid of [new Uint8Array(2), new Uint8Array([1, 1, 0]), packet.subarray(0, 6)]) {
        assert.throws(() => unpackOpusPacket(invalid), /Invalid native Opus/);
    }
    packet[2] = 0;
    assert.equal(unpacked.description[0], 79, "Decoder metadata must not alias a mutable input packet");
});

test("Native Opus runtime probe rejects advertised but unusable decoders and caches the result", async () => {
    const codecs = nativeCodecs();
    codecs.AudioDecoder.prototype.decode = function () {
        this.callbacks.error(Object.assign(new Error("Unsupported configuration"), { name: "OperationError" }));
    };
    const h = audioHarness(codecs);
    const audio = await h.load("https-audio.js");
    assert.equal((await audio.getCapabilities()).supportsOpus, false);
    assert.equal((await audio.getCapabilities()).supportsOpus, false);
    assert.equal(codecs.instances.encoders.length, 1);
    assert.ok([...codecs.instances.encoders, ...codecs.instances.decoders].every(codec => codec.state === "closed"));
    assert.ok(codecs.instances.audio.every(data => data.closed));
    assert.equal(h.requests.length, 0);
});

test("Native Opus runtime probe times out, releases resources and propagates unexpected failures", async () => {
    const stalled = nativeCodecs();
    stalled.AudioEncoder.prototype.encode = () => {};
    let timeout;
    let cleared = false;
    const h = audioHarness({
        ...stalled,
        setTimeout(callback, delay) { assert.equal(delay, 3000); timeout = callback; return 1; },
        clearTimeout(id) { assert.equal(id, 1); cleared = true; }
    });
    const audio = await h.load("https-audio.js");
    const checking = audio.getCapabilities();
    await waitUntil(() => !!timeout);
    timeout();
    assert.equal((await checking).supportsOpus, false);
    assert.equal(cleared, true);
    assert.equal(stalled.instances.encoders[0].state, "closed");
    assert.equal(stalled.instances.audio[0].closed, true);
    const broken = nativeCodecs();
    broken.AudioDecoder.prototype.decode = function () { this.callbacks.error(new Error("Unexpected decoder failure")); };
    const other = audioHarness(broken);
    await assert.rejects((await other.load("https-audio.js")).getCapabilities(), /Unexpected decoder failure/);
    assert.ok([...broken.instances.encoders, ...broken.instances.decoders].every(codec => codec.state === "closed"));
});

test("Native Opus uses WebCodecs, encrypts only encoded packets, preserves mute and closes codecs", async () => {
    const codecs = nativeCodecs();
    const h = audioHarness(codecs);
    const audio = await h.load("https-audio.js");
    await audio.initialize(h.reference, key, true, true, 17);
    assert.equal(h.contexts[0].sampleRate, 48000, "Web Audio must perform native Opus sample-rate conversion");
    await audio.setParticipants([{ connectionId: "peer" }]);
    assert.equal(h.streams[0].track.enabled, false, "Transitioning must not unmute the microphone");
    audio.setMuted(false);
    h.nodes[0].port.onmessage({ data: { type: "capture", samples: new Float32Array(1920).fill(0.25) } });
    await waitUntil(() => h.sent().length === 1);
    const encoded = codecs.instances.encoders.at(-1);
    assert.equal(encoded.config.codec, "opus");
    assert.equal(encoded.config.bitrate, 24000);
    assert.equal(encoded.config.opus.frameDuration, 40000);
    assert.equal(encoded.lastAudio.closed, true);
    const { createAudioCipher } = await h.load("https-audio-crypto.js");
    assert.equal(h.sent()[0].args[1], 17, "Browser callbacks must carry their original media epoch");
    const remote = await createAudioCipher(key, true, 17);
    const encodedPacket = await remote.decrypt(h.sent()[0].args[0], {});
    const { unpackOpusPacket } = await h.load("https-audio-opus.js");
    assert.deepEqual(unpackOpusPacket(encodedPacket).data, new Uint8Array([0xf8, 0xff, 0xfe]));
    const packet = await remote.encrypt(encodedPacket);
    await audio.receiveAudio("peer", packet);
    const decoded = h.nodes[0].messages.find(message => message.type === "audio");
    assert.equal(decoded.samples.length, 1920);
    assert.equal(decoded.samples[0], 0.25);
    assert.equal(codecs.instances.audio.at(-1).closed, true);
    await audio.setParticipants([]);
    assert.equal(codecs.instances.decoders.at(-1).state, "closed");
    await audio.leave();
    assert.equal(encoded.state, "closed");
});

test("Opus worklet transfers 40 ms PCM frames without handwritten codec conversion", async () => {
    let Processor;
    class Base {
        constructor() { this.messages = []; this.port = { postMessage: data => this.messages.push(data) }; }
    }
    await modules({ sampleRate: 48000, AudioWorkletProcessor: Base,
        registerProcessor(name, type) { Processor = type; } })("https-audio-worklet.js");
    const processor = new Processor({ processorOptions: { opus: true } });
    const output = new Float32Array(128);
    for (let index = 0; index < 15; index++) processor.process([[new Float32Array(128).fill(0.25)]], [[output]]);
    assert.equal(processor.messages.length, 1);
    assert.equal(processor.messages[0].samples.length, 1920);
    assert.ok(processor.messages[0].samples instanceof Float32Array);
    assert.ok(processor.messages[0].samples.every(value => value === 0.25));
    for (let index = 0; index < 2; index++) processor.port.onmessage({
        data: { type: "audio", id: "peer", samples: new Float32Array(1920).fill(0.25) }
    });
    processor.process([[]], [[output]]);
    assert.ok(output.every(value => value === 0.25));
});
test("HTTPS audio captures only with peers, encrypts sends, authenticates playback and cleans up", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    await audio.initialize(h.reference, key);
    assert.equal(h.contexts[0].sampleRate, 8000, "Web Audio must perform native G.711 sample-rate conversion");
    assert.equal(h.requests.length, 0);
    h.tick();
    assert.equal(h.calls.at(-1).args[0], "waiting", "Never report healthy before authenticated audio");
    await audio.setParticipants([{ connectionId: "peer" }]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].video, false);
    h.captureFrame();
    await waitUntil(() => h.sent().length === 1);
    const { createAudioCipher } = await h.load("https-audio-crypto.js");
    const remote = await createAudioCipher(key);
    assert.deepEqual(await remote.decrypt(h.sent()[0].args[0], {}), new Uint8Array(320).fill(0xcc));
    audio.setMuted(true);
    assert.equal(h.streams[0].track.enabled, false);
    h.captureFrame();
    assert.equal(h.sent().length, 1);
    audio.setMuted(false);
    assert.equal(h.streams[0].track.enabled, true);
    await audio.receiveAudio("peer", new Uint8Array(361));
    assert.equal(h.calls.at(-1).method, "HttpsAudioUnreadable");
    assert.equal(h.calls.at(-1).args[1], true);
    const first = await remote.encrypt(new Uint8Array(320).fill(0xdd));
    const second = await remote.encrypt(new Uint8Array(320).fill(0xee));
    await Promise.all([audio.receiveAudio("peer", first), audio.receiveAudio("peer", second)]);
    const playback = h.nodes[0].messages.filter(message => message.type === "audio");
    assert.equal(playback.length, 2);
    assert.equal(playback[0].samples[0], 0xdd);
    assert.equal(playback[1].samples[0], 0xee);
    assert.equal(h.calls.at(-1).args[1], false);
    h.tick();
    assert.equal(h.calls.at(-1).args[0], "waiting", "Authenticated packets alone must not claim working playback");
    h.nodes[0].port.onmessage({ data: {
        type: "stats", capturedSamples: 640, microphonePeak: 0.25,
        playedSamples: 640, playbackPeak: 0.25, bufferedSamples: 0, underruns: 0
    } });
    h.tick();
    assert.equal(h.calls.at(-1).args[0], "healthy");
    await audio.setParticipants([]);
    assert.equal(h.streams[0].track.stopped, true);
    await audio.leave();
    assert.equal(h.contexts[0].state, "closed");
    assert.equal(h.tick, undefined);
});

test("HTTPS audio keeps upload queues bounded and explicitly fails stalled sends", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    let release;
    h.send = () => new Promise(resolve => { release = resolve; });
    await audio.initialize(h.reference, key);
    await audio.setParticipants([{ connectionId: "peer" }]);
    h.captureFrame();
    await waitUntil(() => h.sent().length === 1);
    h.now = 1000;
    for (let index = 0; index < 12; index++) h.captureFrame();
    assert.equal(JSON.parse(audio.getConnectionDiagnostics()).pendingFrames, 3);
    h.tick();
    assert.equal(h.calls.at(-1).args[0], "fair");
    h.now = 6001;
    h.tick();
    await waitUntil(() => h.contexts[0].state === "closed");
    assert.ok(h.calls.some(call => call.method === "HttpsAudioFailed" && call.args[0].includes("stalled")));
    assert.equal(h.streams[0].track.stopped, true);
    release();
});

test("Late microphone permission after leave cannot retain a live track", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    let release;
    h.capture = () => new Promise(resolve => { release = resolve; });
    await audio.initialize(h.reference, key);
    const joining = audio.setParticipants([{ connectionId: "peer" }]);
    await audio.leave();
    const stream = h.makeStream();
    release(stream);
    await joining;
    assert.equal(stream.track.stopped, true);
});

test("A stale microphone denial after rejoining cannot fail the new call", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    let rejectCapture;
    h.capture = () => new Promise((resolve, reject) => { rejectCapture = reject; });
    await audio.initialize(h.reference, key);
    const oldCapture = audio.setParticipants([{ connectionId: "old-peer" }]);
    await audio.leave();
    h.capture = () => h.makeStream();
    await audio.initialize(h.reference, key);
    await audio.setParticipants([{ connectionId: "new-peer" }]);
    rejectCapture(new Error("Late permission denial"));
    await oldCapture;
    assert.equal(h.streams[0].track.stopped, false);
    assert.equal(h.calls.some(call => call.method === "HttpsAudioFailed"), false);
    await audio.leave();
    assert.equal(h.streams[0].track.stopped, true);
});

test("Peers leaving and returning during microphone permission reconcile capture", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    let release;
    h.capture = () => new Promise(resolve => { release = resolve; });
    await audio.initialize(h.reference, key);
    const joining = audio.setParticipants([{ connectionId: "peer" }]);
    await audio.setParticipants([]);
    await audio.setParticipants([{ connectionId: "new-peer" }]);
    const stale = h.makeStream();
    h.capture = () => h.makeStream();
    release(stale);
    await joining;
    assert.equal(stale.track.stopped, true);
    assert.equal(h.requests.length, 2);
    assert.equal(h.streams[1].track.stopped, false);
    await audio.leave();
    assert.equal(h.streams[1].track.stopped, true);
});

test("Worklet failure fails closed and a later initialize can retry", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    h.workletError = new Error("Worklet unavailable");
    await assert.rejects(audio.initialize(h.reference, key), /Worklet unavailable/);
    assert.equal(h.contexts[0].state, "closed");
    assert.equal(h.sent().length, 0);
    h.workletError = undefined;
    await audio.initialize(h.reference, key);
    await audio.leave();
});

test("A browser ignoring the requested sample rate fails explicitly and releases its context", async () => {
    const h = audioHarness();
    h.sampleRate = 44100;
    const audio = await h.load("https-audio.js");
    await assert.rejects(audio.initialize(h.reference, key), /browser-native 8000 Hz audio processing/);
    assert.equal(h.contexts[0].state, "closed");
    assert.equal(h.requests.length, 0);
    assert.equal(h.sent().length, 0);
});

for (const failure of ["microphone", "processor"]) {
    test(`Unexpected ${failure} failure explicitly ends audio and cleans resources`, async () => {
        const h = audioHarness();
        const audio = await h.load("https-audio.js");
        await audio.initialize(h.reference, key);
        await audio.setParticipants([{ connectionId: "peer" }]);
        if (failure === "microphone") h.streams[0].track.ended();
        else h.nodes[0].onprocessorerror();
        await waitUntil(() => h.contexts[0].state === "closed");
        assert.ok(h.calls.some(call => call.method === "HttpsAudioFailed"));
        assert.equal(h.streams[0].track.stopped, true);
        assert.equal(JSON.parse(audio.getConnectionDiagnostics()).encrypted, false);
    });
}

test("Automatic UI defaults to WebRTC and provides a whole-call Stealth override", () => {
    const markup = fs.readFileSync(path.join(__dirname, "..", "Components", "VoiceChannel.razor"), "utf8");
    const advanced = markup.indexOf("Advanced call settings");
    const option = markup.indexOf('id="https-audio-mode"');
    assert.ok(option > advanced);
    assert.match(markup, /Audio over HTTPS \(Stealth mode\)/);
    assert.match(markup, /@bind="_forceStealth" @bind:after="ForceStealthChanged" disabled="@\(_joined \|\| _busy \|\| !_stealthPreferenceLoaded\)"/);
    assert.match(markup, /private bool _forceStealth;/);
    assert.match(markup, /if \(!_useHttpsAudio\)[\s\S]*?OnClick="ToggleVideo"/);
    assert.match(markup, /JoinAutomaticVoice/);
    assert.match(markup, /Automatic is the default/);
    assert.match(markup, /other participants switch automatically/);
    assert.match(markup, /getCapabilities/);
    assert.match(markup, /RequestHttpsAudio\(_mediaRevision\)/);
    assert.match(markup, /mediaRevision != _mediaRevision/);
    const dispose = markup.slice(markup.indexOf("public async ValueTask DisposeAsync()"));
    assert.match(dispose, /if \(_joined && State\.UserInfo != null\)/);
    assert.match(dispose, /finally\s*\{\s*await CleanupBrowserVoice\(\)/);
});

test("HTTPS diagnostics distinguish capture, authentication and playback without exposing secrets", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    await audio.initialize(h.reference, key, false, false, 17);
    assert.match(audio.getConnectionDiagnostics(), /Waiting for another participant/);
    await audio.setParticipants([{ connectionId: "peer" }]);
    h.now = 6000;
    assert.match(audio.getConnectionDiagnostics(), /no capture frames/);
    h.captureFrame();
    await waitUntil(() => JSON.parse(audio.getConnectionDiagnostics()).uploadedFrames === 1);
    let stats = JSON.parse(audio.getConnectionDiagnostics());
    assert.equal(stats.captureFrames, 1);
    assert.equal(stats.encodedFrames, 1);
    assert.equal(stats.bytesSent, 361);
    assert.match(stats.diagnosis.join(" "), /No incoming HTTPS audio/);
    await audio.receiveAudio("peer", new Uint8Array(361));
    stats = JSON.parse(audio.getConnectionDiagnostics());
    assert.equal(stats.incomingFrames, 1);
    assert.equal(stats.rejectedFrames, 1);
    assert.match(stats.diagnosis.join(" "), /unreadable/);
    const { createAudioCipher } = await h.load("https-audio-crypto.js");
    const remote = await createAudioCipher(key, false, 17);
    await audio.receiveAudio("peer", await remote.encrypt(new Uint8Array(320)));
    stats = JSON.parse(audio.getConnectionDiagnostics());
    assert.equal(stats.authenticatedFrames, 1);
    assert.equal(stats.decodedFrames, 1);
    assert.match(stats.diagnosis.join(" "), /playback has not been confirmed/);
    h.nodes[0].port.onmessage({ data: {
        type: "stats", capturedSamples: 320, microphonePeak: 0.25,
        playedSamples: 320, playbackPeak: 0.25, bufferedSamples: 0, underruns: 0
    } });
    assert.match(JSON.parse(audio.getConnectionDiagnostics()).diagnosis.join(" "), /worklet playback are active/);
    h.contexts[0].state = "suspended";
    assert.match(audio.getConnectionDiagnostics(), /Browser audio context is suspended/);
    h.nodes[0].port.onmessage({ data: { type: "playback-overrun" } });
    h.now++;
    h.tick();
    assert.equal(h.calls.at(-1).args[0], "waiting");
    assert.match(h.calls.at(-1).args[1], /Browser audio context is suspended/);
    h.contexts[0].resume = async () => { h.contexts[0].state = "running"; };
    await audio.resumeAudio();
    audio.setMuted(true);
    assert.match(audio.getConnectionDiagnostics(), /Your microphone is muted/);
    assert.ok(!audio.getConnectionDiagnostics().includes(key));
    await audio.leave();
    assert.equal(JSON.parse(audio.getConnectionDiagnostics()).active, false);
    assert.equal(JSON.parse(audio.getConnectionDiagnostics()).uploadedFrames, 1);
    await assert.rejects(audio.resumeAudio(), /Join an HTTPS/);
});

test("Permission and initialization errors remain inspectable after cleanup", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    await audio.initialize(h.reference, key);
    h.capture = async () => { throw Object.assign(new Error("Microphone permission denied"), { name: "NotAllowedError" }); };
    await assert.rejects(audio.setParticipants([{ connectionId: "peer" }]), /permission denied/);
    await audio.leave();
    let stats = JSON.parse(audio.getConnectionDiagnostics());
    assert.equal(stats.lastError.stage, "microphone capture");
    assert.equal(stats.lastError.name, "NotAllowedError");
    assert.match(stats.diagnosis.join(" "), /permission denied/);
    h.workletError = new Error("Worklet download failed");
    await assert.rejects(audio.initialize(h.reference, key), /download failed/);
    stats = JSON.parse(audio.getConnectionDiagnostics());
    assert.equal(stats.lastError.stage, "audio worklet loading");
    assert.equal(stats.active, false);
    assert.match(stats.diagnosis.join(" "), /download failed/);
});

test("An upload failure records the precise failing stage before cleanup", async () => {
    const h = audioHarness();
    const audio = await h.load("https-audio.js");
    h.send = async () => { throw new Error("SignalR connection is closed"); };
    await audio.initialize(h.reference, key);
    await audio.setParticipants([{ connectionId: "peer" }]);
    h.captureFrame();
    await waitUntil(() => h.contexts[0].state === "closed");
    const stats = JSON.parse(audio.getConnectionDiagnostics());
    assert.equal(stats.lastError.stage, "encrypted upload");
    assert.match(stats.lastError.message, /SignalR connection is closed/);
    assert.equal(stats.uploadedFrames, 0);
    assert.equal(stats.active, false);
});

test("Worklet diagnostic snapshots measure real input/output and reset recent peaks", async () => {
    let Processor;
    const load = modules({
        sampleRate: 8000,
        AudioWorkletProcessor: class {
            constructor() { this.messages = []; this.port = { postMessage: data => this.messages.push(data) }; }
        },
        registerProcessor(_name, type) { Processor = type; }
    });
    await load("https-audio-worklet.js");
    const processor = new Processor();
    const output = new Float32Array(128);
    const samples = new Uint8Array(320).fill(0x80);
    processor.port.onmessage({ data: { type: "audio", id: "peer", samples } });
    processor.port.onmessage({ data: { type: "audio", id: "peer", samples } });
    processor.process([[new Float32Array(128).fill(0.25)]], [[output]]);
    processor.port.onmessage({ data: { type: "get-stats" } });
    const stats = processor.messages.at(-1);
    assert.equal(stats.capturedSamples, 128);
    assert.equal(stats.microphonePeak, 0.25);
    assert.equal(stats.playedSamples, 128);
    assert.ok(stats.playbackPeak > 0.9);
    assert.equal(stats.bufferedSamples, 512);
    processor.port.onmessage({ data: { type: "get-stats" } });
    assert.equal(processor.messages.at(-1).microphonePeak, 0);
    assert.equal(processor.messages.at(-1).playbackPeak, 0);
    assert.equal(processor.messages.at(-1).playedSamples, 128);
});

test("Debug mode opens live call diagnostics and preserves the last HTTPS failure", () => {
    const markup = fs.readFileSync(path.join(__dirname, "..", "Components", "VoiceChannel.razor"), "utf8");
    assert.match(markup, /DebugMode && !_debugModeEnabled/);
    assert.match(markup, /_joined \|\| _lastHttpsDiagnostics != null/);
    assert.match(markup, /HTTPS audio diagnostics/);
    assert.match(markup, /OnClick="ResumeHttpsAudio"/);
    assert.match(markup, /_showDebug = DebugMode && _lastHttpsDiagnostics != null/);
    const timer = markup.slice(markup.indexOf("private async Task UpdateCallDuration"));
    assert.match(timer, /getConnectionDiagnostics/);
    assert.match(timer, /Unable to refresh call diagnostics/);
});
