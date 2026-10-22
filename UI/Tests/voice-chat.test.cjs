const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { pathToFileURL } = require("node:url");

async function createHarness(options = {}) {
    const imports = [];
    const workers = [];
    const contexts = [];
    const streams = [];
    const callbacks = [];
    const connections = [];
    let adaptQuality;
    function createElement() {
        return {
            children: [],
            appendChild(child) { this.children.push(child); },
            setAttribute() {},
            addEventListener() {},
            remove() { this.removed = true; }
        };
    }
    const reference = {
        invokeMethodAsync(...args) {
            callbacks.push(args);
            return Promise.resolve();
        }
    };
    const scope = vm.createContext({
        URL, console, TextEncoder, atob, btoa, crypto: webcrypto,
        setInterval(callback) { adaptQuality = callback; return 1; },
        clearInterval() {},
        document: { addEventListener() {}, removeEventListener() {}, createElement },
        navigator: {
            deviceMemory: 8, hardwareConcurrency: 8,
            mediaDevices: { getSupportedConstraints: () => ({}) },
            ...options.navigator
        },
        window: {
            RTCRtpScriptTransform: class {},
            Worker: class {},
            AudioContext: class {
                constructor() {
                    this.nodes = [];
                    this.sources = [];
                    contexts.push(this);
                }
                resume() {
                    return options.resume ? options.resume() : Promise.resolve();
                }
                close() {
                    this.closed = true;
                    return Promise.resolve();
                }
                createNode() {
                    const node = {
                        gain: {},
                        connect() {},
                        disconnect() { this.disconnected = true; }
                    };
                    this.nodes.push(node);
                    return node;
                }
                createScriptProcessor() { return this.createNode(); }
                createGain() { return this.createNode(); }
                createMediaStreamSource(stream) {
                    this.sources.push(stream);
                    return this.createNode();
                }
            },
            location: { hostname: "localhost" }
        },
        Worker: class {
            constructor(url) {
                this.url = url.href;
                this.messages = [];
                workers.push(this);
            }
            postMessage(message) { this.messages.push(message); }
            terminate() { this.terminated = true; }
        },
        MediaStream: class {
            constructor() {
                this.tracks = [];
                streams.push(this);
            }
            getTracks() { return this.tracks; }
            getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
            getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
            addTrack(track) { this.tracks.push(track); }
            removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
        },
        RTCRtpScriptTransform: class {
            constructor(worker, options) { this.options = options; }
        },
        RTCPeerConnection: class {
            constructor() {
                this.transceivers = [];
                connections.push(this);
            }
            addTrack(track) {
                const sender = {
                    track,
                    getParameters: () => ({}),
                    setParameters(parameters) {
                        this.parameters = parameters;
                        return Promise.resolve();
                    }
                };
                this.transceivers.push({ sender, receiver: {} });
                return sender;
            }
            getTransceivers() { return this.transceivers; }
            getSenders() { return this.transceivers.map(item => item.sender); }
            createOffer() { return Promise.resolve({ type: "offer", sdp: "test" }); }
            setLocalDescription(description) {
                this.localDescription = description;
                return Promise.resolve();
            }
            close() { this.closed = true; }
        }
    });
    const modules = new Map();
    function load(filename) {
        if (!modules.has(filename)) modules.set(filename, loadModule(filename));
        return modules.get(filename);
    }
    async function loadModule(filename) {
        const module = new vm.SourceTextModule(await readFile(filename, "utf8"), {
            context: scope,
            initializeImportMeta(meta) { meta.url = pathToFileURL(filename).href; },
            async importModuleDynamically(specifier) {
                imports.push(specifier);
                if (options.beforeImport) await options.beforeImport();
                return load(path.resolve(path.dirname(filename), specifier));
            }
        });
        await module.link(specifier => {
            assert.equal(specifier, "./media-defaults.js");
            return load(path.resolve(path.dirname(filename), specifier));
        });
        await module.evaluate();
        return module;
    }
    const module = await load(path.resolve(__dirname, "..", "wwwroot", "js", "voice-chat.js"));
    const voice = module.namespace;
    async function join(withAudio = false, quality = "auto") {
        await voice.initialize(
            reference, createElement(), null, { username: "expiry:local", host: "localhost" },
            Buffer.alloc(32, 1).toString("base64"), quality, quality);
        if (withAudio) {
            streams[0].addTrack({
                kind: "audio",
                readyState: "live",
                stop() { this.readyState = "ended"; },
                applyConstraints() { return Promise.resolve(); }
            });
        }
    }
    const defaults = (await load(path.resolve(
        __dirname, "..", "wwwroot", "js", "media-defaults.js"))).namespace;
    return {
        voice, defaults, imports, workers, contexts, streams, callbacks, connections, join,
        adaptQuality: () => adaptQuality()
    };
}

test("loading and joining voice never load transcription code or audio processing", async () => {
    const h = await createHarness();
    assert.equal(h.voice.supportsLiveTranscription(), true);
    assert.equal(h.voice.getRecommendedTranscriptionModel(), "base");
    await h.join();
    await h.voice.connectToParticipants([]);
    assert.equal(await h.voice.setTranscriptionEnabled(false), false);
    h.voice.leave();
    assert.deepEqual(h.imports, []);
    assert.equal(h.contexts.length, 0);
    assert.equal(h.workers.length, 1);
    assert.match(h.workers[0].url, /voice-crypto-worker/);
});

test("starting without connected audio fails without loading transcription", async () => {
    const h = await createHarness();
    await h.join();
    await assert.rejects(h.voice.setTranscriptionEnabled(true), /Connect to another participant/);
    assert.deepEqual(h.imports, []);
    assert.equal(h.contexts.length, 0);
    h.voice.leave();
});

test("explicit start loads only the selected model and stop releases resources", async () => {
    const h = await createHarness();
    await h.join(true);
    assert.equal(await h.voice.setTranscriptionEnabled(true, "base-en"), true);
    assert.deepEqual(h.imports, ["./voice-transcription.js"]);
    const worker = h.workers[1];
    assert.match(worker.url, /transcription-worker/);
    assert.equal(worker.messages[0].model, "base-en");
    assert.equal(h.contexts[0].sources[0], h.streams[0]);

    const processor = h.contexts[0].nodes[0];
    processor.onaudioprocess({
        inputBuffer: {
            sampleRate: 16000,
            getChannelData: () => new Float32Array(96000).fill(0.1)
        }
    });
    assert.equal(worker.messages[1].type, "transcribe");
    assert.equal(worker.messages[1].audio.length, 96000);
    worker.onmessage({ data: { type: "result", text: "Test transcript" } });
    assert.ok(h.callbacks.some(([method, text]) =>
        method === "TranscriptionTextReceived" && text === "Test transcript"));

    assert.equal(await h.voice.setTranscriptionEnabled(false), false);
    assert.equal(worker.terminated, true);
    assert.equal(h.contexts[0].closed, true);
    assert.equal(processor.onaudioprocess, null);
    assert.ok(h.contexts[0].nodes.every(node => node.disconnected));
    assert.equal(await h.voice.setTranscriptionEnabled(true), true);
    assert.equal(h.workers[2].messages[0].model, "base");
    h.voice.leave();
    assert.equal(h.workers[2].terminated, true);
});

test("leaving during the lazy import prevents worker and audio graph creation", async () => {
    let releaseImport;
    let importStarted;
    const started = new Promise(resolve => { importStarted = resolve; });
    const pendingImport = new Promise(resolve => { releaseImport = resolve; });
    const h = await createHarness({
        beforeImport() { importStarted(); return pendingImport; }
    });
    await h.join(true);
    const starting = h.voice.setTranscriptionEnabled(true);
    await started;
    h.voice.leave();
    releaseImport();
    assert.equal(await starting, false);
    assert.equal(h.workers.length, 1);
    assert.equal(h.contexts.length, 0);
});

test("stopping while the audio context resumes cannot restart transcription", async () => {
    let releaseResume;
    let resumeStarted;
    const started = new Promise(resolve => { resumeStarted = resolve; });
    const pendingResume = new Promise(resolve => { releaseResume = resolve; });
    const h = await createHarness({
        resume() { resumeStarted(); return pendingResume; }
    });
    await h.join(true);
    const starting = h.voice.setTranscriptionEnabled(true);
    await started;
    await h.voice.setTranscriptionEnabled(false);
    releaseResume();
    assert.equal(await starting, false);
    assert.equal(h.contexts[0].nodes.length, 0);
    assert.equal(h.contexts[0].closed, true);
    assert.equal(h.workers[1].terminated, true);
    h.voice.leave();
});

test("audio initialization failures release resources and propagate to the caller", async () => {
    const h = await createHarness({
        resume: () => Promise.reject(new Error("Audio initialization failed"))
    });
    await h.join(true);
    await assert.rejects(h.voice.setTranscriptionEnabled(true), /Audio initialization failed/);
    assert.equal(h.contexts[0].closed, true);
    assert.equal(h.workers[1].terminated, true);
    h.voice.leave();
});

test("worker errors stop transcription and notify the UI", async () => {
    const h = await createHarness();
    await h.join(true);
    await h.voice.setTranscriptionEnabled(true);
    h.workers[1].onmessage({ data: { type: "error", message: "Model download failed" } });
    assert.ok(h.callbacks.some(([method, message, failed]) =>
        method === "TranscriptionStatusChanged" && message.includes("Model download failed") && failed));
    assert.equal(h.workers[1].terminated, true);
    assert.equal(h.contexts[0].closed, true);
    assert.equal(await h.voice.setTranscriptionEnabled(true, "tiny"), true);
    h.voice.leave();
});

for (const model of ["tiny", "base", "small", "tiny-en", "base-en", "small-en"]) {
    test(`manual ${model} model remains selectable`, async () => {
        const h = await createHarness();
        await h.join(true);
        await h.voice.setTranscriptionEnabled(true, model);
        assert.equal(h.workers[1].messages[0].model, model);
        h.voice.leave();
    });
}

for (const [navigator, model] of [
    [{ deviceMemory: 2, hardwareConcurrency: 16 }, "tiny"],
    [{ deviceMemory: 8, hardwareConcurrency: 4 }, "tiny"],
    [{ deviceMemory: 8, hardwareConcurrency: 8 }, "base"],
    [{ deviceMemory: 16, hardwareConcurrency: 16 }, "small"],
    [{ deviceMemory: 16, hardwareConcurrency: 16, userAgentData: { mobile: true } }, "tiny"],
    [{ deviceMemory: undefined, hardwareConcurrency: undefined }, "tiny"]
]) {
    test(`Auto model recommendation: ${JSON.stringify(navigator)} -> ${model}`, async () => {
        const h = await createHarness({ navigator });
        await h.join(true);
        assert.equal(h.voice.getRecommendedTranscriptionModel(), model);
        await h.voice.setTranscriptionEnabled(true);
        assert.equal(h.workers[1].messages[0].model, model);
        h.voice.leave();
    });
}

test("remote audio connects before and after transcription starts; last departure stops it", async () => {
    const h = await createHarness();
    await h.join(true);
    await h.voice.connectToParticipants([{ connectionId: "remote-1", name: "First" }]);
    const emitAudio = connection => {
        const receiver = {};
        connection.ontrack({
            receiver, track: { kind: "audio", readyState: "live" }
        });
        assert.equal(receiver.transform.options.operation, "decrypt");
    };
    emitAudio(h.connections[0]);
    assert.deepEqual(h.imports, []);
    assert.equal(h.connections[0].getSenders()[0].transform.options.operation, "encrypt");
    h.voice.setMuted(true);
    assert.equal(h.streams[0].getAudioTracks()[0].enabled, false);
    h.voice.setMuted(false);
    assert.equal(h.streams[0].getAudioTracks()[0].enabled, true);
    await h.voice.setTranscriptionEnabled(true);
    assert.equal(h.contexts[0].sources.length, 2);
    assert.equal(h.contexts[0].sources[1], h.streams[1]);

    await h.voice.connectToParticipants([{ connectionId: "remote-2", name: "Second" }]);
    emitAudio(h.connections[1]);
    assert.equal(h.contexts[0].sources.length, 3);
    h.voice.removeParticipant("remote-1");
    assert.equal(h.contexts[0].nodes[3].disconnected, true);
    assert.notEqual(h.workers[1].terminated, true);
    h.voice.removeParticipant("remote-2");
    assert.equal(h.workers[1].terminated, true);
    assert.equal(h.contexts[0].closed, true);
    assert.equal(h.streams[0].getAudioTracks().length, 0);
    assert.ok(h.callbacks.some(([method]) => method === "TranscriptionStopped"));
    h.voice.leave();
});

test("48 kHz input is resampled to 16 kHz and silence does not trigger inference", async () => {
    const h = await createHarness();
    await h.join(true);
    await h.voice.setTranscriptionEnabled(true);
    const collect = audio => h.contexts[0].nodes[0].onaudioprocess({
        inputBuffer: { sampleRate: 48000, getChannelData: () => audio }
    });
    collect(new Float32Array(288000));
    assert.equal(h.workers[1].messages.length, 1);
    collect(new Float32Array(288000).fill(0.25));
    assert.equal(h.workers[1].messages[1].audio.length, 96000);
    assert.equal(h.workers[1].messages[1].audio[0], 0.25);
    h.voice.leave();
});

test("a failed lazy import is reported and can be retried", async () => {
    let first = true;
    const h = await createHarness({
        beforeImport() {
            if (first) {
                first = false;
                throw new Error("Module download failed");
            }
        }
    });
    await h.join(true);
    await assert.rejects(h.voice.setTranscriptionEnabled(true), /Module download failed/);
    assert.equal(h.workers.length, 1);
    assert.equal(await h.voice.setTranscriptionEnabled(true), true);
    h.voice.leave();
});

test("a cancelled startup failure cannot stop a newer transcription session", async () => {
    let rejectResume;
    let resumeStarted;
    let first = true;
    const started = new Promise(resolve => { resumeStarted = resolve; });
    const pendingResume = new Promise((resolve, reject) => { rejectResume = reject; });
    const h = await createHarness({
        resume() {
            if (!first) return Promise.resolve();
            first = false;
            resumeStarted();
            return pendingResume;
        }
    });
    await h.join(true);
    const starting = h.voice.setTranscriptionEnabled(true);
    await started;
    await h.voice.setTranscriptionEnabled(false);
    await h.voice.setTranscriptionEnabled(true);
    const failure = assert.rejects(starting, /Cancelled context/);
    rejectResume(new Error("Cancelled context"));
    await failure;
    assert.notEqual(h.workers[2].terminated, true);
    assert.notEqual(h.contexts[1].closed, true);
    h.voice.leave();
});

test("events from a terminated worker cannot affect a restarted session", async () => {
    const h = await createHarness();
    await h.join(true);
    await h.voice.setTranscriptionEnabled(true);
    const previousWorker = h.workers[1];
    await h.voice.setTranscriptionEnabled(false);
    await h.voice.setTranscriptionEnabled(true);
    previousWorker.onmessage({ data: { type: "result", text: "Stale transcript" } });
    previousWorker.onmessage({ data: { type: "error", message: "Stale error" } });
    previousWorker.onerror({ message: "Stale runtime error" });
    assert.ok(!h.callbacks.some(([method, text]) =>
        method === "TranscriptionTextReceived" && text === "Stale transcript"));
    assert.notEqual(h.workers[2].terminated, true);
    h.workers[2].onmessage({ data: { type: "result", text: "Current transcript" } });
    assert.ok(h.callbacks.some(([method, text]) =>
        method === "TranscriptionTextReceived" && text === "Current transcript"));
    h.voice.leave();
});

test("the worker retains all six quantized on-device models and lazy runtime loading", async () => {
    const source = await readFile(path.resolve(
        __dirname, "..", "wwwroot", "js", "transcription-worker.js"), "utf8");
    for (const model of ["tiny", "base", "small", "tiny-en", "base-en", "small-en"]) {
        const imports = [];
        const messages = [];
        const pipelines = [];
        const inference = [];
        const env = {};
        const self = { postMessage(message) { messages.push(message); } };
        const scope = vm.createContext({ self });
        const runtime = new vm.SyntheticModule(["env", "pipeline"], function () {
            this.setExport("env", env);
            this.setExport("pipeline", async (...args) => {
                pipelines.push(args);
                return async (audio, options) => {
                    inference.push({ audio, options });
                    return { text: " Transcript " };
                };
            });

        }, { context: scope });
        const worker = new vm.SourceTextModule(source, {
            context: scope,
            async importModuleDynamically(specifier) {
                imports.push(specifier);
                await runtime.link(() => { throw new Error("Unexpected runtime dependency"); });
                await runtime.evaluate();
                return runtime;
            }
        });
        await worker.link(() => { throw new Error("Unexpected eager worker dependency"); });
        await worker.evaluate();
        assert.deepEqual(imports, []);
        await self.onmessage({ data: { type: "initialize", model } });
        assert.equal(imports.length, 1);
        assert.match(imports[0], /@huggingface\/transformers@3\.7\.2$/);
        const modelName = model.replace("-en", ".en");
        assert.equal(pipelines[0][0], "automatic-speech-recognition");
        assert.equal(pipelines[0][1], `onnx-community/whisper-${modelName}`);
        assert.equal(pipelines[0][2].device, "wasm");
        assert.equal(pipelines[0][2].dtype, "q8");
        assert.equal(env.allowLocalModels, false);
        assert.equal(env.useBrowserCache, true);
        const audio = new Float32Array(16000);
        await self.onmessage({ data: { type: "transcribe", audio } });
        assert.equal(inference[0].audio, audio);
        assert.equal(inference[0].options.chunk_length_s, 8);
        assert.equal(inference[0].options.stride_length_s, 1);
        assert.equal(messages.at(-1).text, "Transcript");
        assert.equal(pipelines.length, 1);
    }
});

for (const [device, navigator, quality] of [
    ["Android", { userAgent: "Mozilla/5.0 (Linux; Android 14)" }, "low"],
    ["iPhone", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" }, "low"],
    ["iPad", { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0)" }, "low"],
    ["desktop-mode iPad", { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }, "low"],
    ["client hints mobile", { userAgentData: { mobile: true } }, "low"],
    ["Windows desktop", { userAgent: "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints: 0 }, "auto"],
    ["touchscreen Windows laptop", { userAgent: "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints: 10 }, "auto"],
    ["Mac desktop", { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 }, "auto"]
]) {
    test(`${device} defaults to ${quality} without loading transcription`, async () => {
        const h = await createHarness({ navigator });
        assert.equal(h.defaults.getDefaultMediaQuality(), quality);
        assert.deepEqual(h.imports, []);
        assert.equal(h.contexts.length, 0);
        await h.join(true, quality);
        assert.ok(h.callbacks.some(([method, value]) =>
            method === "AudioQualityAdapted" && value === (quality === "auto" ? "standard" : "low")));
        assert.ok(h.callbacks.some(([method, value]) =>
            method === "VideoQualityAdapted" && value === (quality === "auto" ? "standard" : "low")));
        h.voice.leave();
    });
}

test("mobile Low caps actual senders and preserves manual quality overrides", async () => {
    const h = await createHarness({ navigator: { userAgent: "iPhone" } });
    await h.join(true, h.defaults.getDefaultMediaQuality());
    h.streams[0].addTrack({ kind: "video", readyState: "live", stop() {} });
    await h.voice.connectToParticipants([{ connectionId: "remote", name: "Remote" }]);
    const [audio, video] = h.connections[0].getSenders();
    assert.equal(audio.parameters.encodings[0].maxBitrate, 16000);
    assert.equal(video.parameters.encodings[0].maxBitrate, 250000);
    assert.equal(video.parameters.encodings[0].maxFramerate, 15);
    for (let tick = 0; tick < 6; tick++) await h.adaptQuality();
    assert.equal(audio.parameters.encodings[0].maxBitrate, 16000);
    assert.equal(video.parameters.encodings[0].maxBitrate, 250000);
    assert.equal(await h.voice.setAudioQuality("high"), "high");
    assert.equal(await h.voice.setVideoQuality("high"), "high");
    assert.equal(audio.parameters.encodings[0].maxBitrate, 64000);
    assert.equal(video.parameters.encodings[0].maxBitrate, 1500000);
    assert.equal(await h.voice.setAudioQuality("auto"), "standard");
    assert.equal(await h.voice.setVideoQuality("auto"), "standard");
    assert.equal(audio.parameters.encodings[0].maxBitrate, 32000);
    assert.equal(video.parameters.encodings[0].maxBitrate, 700000);
    assert.deepEqual(h.imports, []);
    h.voice.leave();
});
