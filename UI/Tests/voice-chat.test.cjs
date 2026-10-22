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
    const documentListeners = new Map();
    const connectionListeners = new Map();
    const networkConnection = options.navigator?.connection;
    if (networkConnection) {
        networkConnection.addEventListener = (name, callback) => connectionListeners.set(name, callback);
        networkConnection.removeEventListener = name => connectionListeners.delete(name);
    }
    let adaptQuality;
    function createElement() {
        return {
            children: [],
            appendChild(child) { this.children.push(child); },
            classList: { toggle() {} },
            closest() { return null; },
            play() { return Promise.resolve(); },
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
    const documentState = {
        visibilityState: "visible", createElement,
        addEventListener(name, listener) { documentListeners.set(name, listener); },
        removeEventListener(name) { documentListeners.delete(name); }
    };
    const scope = vm.createContext({
        URL, console: options.console ?? console, TextEncoder, atob, btoa, crypto: webcrypto,
        setInterval(callback) { adaptQuality = callback; return 1; },
        clearInterval() {},
        document: documentState,
        navigator: {
            deviceMemory: 8, hardwareConcurrency: 8,
            mediaDevices: { getSupportedConstraints: () => ({}) },
            ...options.navigator
        },
        window: {
            ...(options.transformSupported === false ? {} : { RTCRtpScriptTransform: class {} }),
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
            constructor(tracks = []) {
                this.tracks = [...tracks];
                streams.push(this);
            }
            getTracks() { return this.tracks; }
            getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
            getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
            addTrack(track) { this.tracks.push(track); }
            removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
        },
        RTCRtpScriptTransform: class {
            constructor(worker, transformOptions) {
                if (options.failTransformConstruction) throw new Error("Encryption transform unavailable");
                this.options = transformOptions;
            }
        },
        RTCPeerConnection: class {
            constructor() {
                this.transceivers = [];
                this.connectionState = "connected";
                this.signalingState = "stable";
                this.stats = new Map();
                connections.push(this);
            }
            getStats() { return Promise.resolve(this.stats); }
            addTrack(track) {
                const reusable = this.transceivers.find(item =>
                    !item.sender.track && item.receiver.track.kind === track.kind);
                if (reusable) {
                    reusable.sender.track = track;
                    return reusable.sender;
                }
                return this.addTransceiver(track.kind, track).sender;
            }
            addTransceiver(kind, track = null) {
                const sender = {
                    track,
                    getParameters() { return this.parameters ?? {}; },
                    setParameters(parameters) {
                        this.parameters = parameters;
                        return Promise.resolve();
                    },
                    replaceTrack(replacement) {
                        this.track = replacement;
                        return Promise.resolve();
                    }
                };
                let transform;
                Object.defineProperty(sender, "transform", {
                    get() { return transform; },
                    set(value) {
                        if (options.failTransformAssignment) throw new Error("Encryption transform assignment failed");
                        transform = value;
                    }
                });
                const transceiver = {
                    sender,
                    receiver: { track: { kind, readyState: "live", addEventListener() {} } }
                };
                this.transceivers.push(transceiver);
                return transceiver;
            }
            getTransceivers() { return this.transceivers; }
            getSenders() { return this.transceivers.map(item => item.sender); }
            removeTrack(sender) { sender.track = null; }
            createOffer() { return Promise.resolve({ type: "offer", sdp: "test" }); }
            createAnswer() { return Promise.resolve({ type: "answer", sdp: "test" }); }
            setRemoteDescription(description) {
                this.remoteDescription = description;
                this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
                if (description.sdp === "incoming-video") {
                    const { receiver } = this.addTransceiver("video");
                    this.ontrack({ receiver, track: receiver.track });
                }
                return Promise.resolve();
            }
            setLocalDescription(description) {
                this.localDescription = description;
                this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
                this.negotiatedSenderTransforms = this.transceivers.map(item => item.sender.transform);
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
            assert.match(specifier, /^\.\/media-defaults\.js(?:\?v=[\w-]+)?$/);
            return load(path.resolve(path.dirname(filename), specifier.split("?")[0]));
        });
        await module.evaluate();
        return module;
    }
    const module = await load(path.resolve(__dirname, "..", "wwwroot", "js", "voice-chat.js"));
    const voice = module.namespace;
    const remoteContainer = createElement();
    async function join(withAudio = false, quality = "auto") {
        await voice.initialize(
            reference, remoteContainer, createElement(), { username: "expiry:local", host: "localhost" },
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
        voice, defaults, imports, workers, contexts, streams, callbacks, connections, join, remoteContainer,
        adaptQuality: () => adaptQuality(),
        networkChanged: () => connectionListeners.get("change")?.(),
        connectionListeners, documentListeners,
        async visibilityChanged(state) {
            documentState.visibilityState = state;
            documentListeners.get("visibilitychange")?.();
            await new Promise(setImmediate);
        }
    };
}

test("incoming video prepares the idle sender's encryption before an answer and reuses it when enabling the camera", async () => {
    const camera = {
        kind: "video", readyState: "live", stop() {}, addEventListener() {},
        applyConstraints: () => Promise.resolve()
    };
    const h = await createHarness({
        navigator: { mediaDevices: {
            getSupportedConstraints: () => ({}),
            getUserMedia: async () => ({ getVideoTracks: () => [camera] })
        } }
    });
    await h.join(true);
    await h.voice.connectToParticipants([{ connectionId: "existing", name: "Existing" }]);
    const offer = JSON.parse(h.callbacks.find(([method]) => method === "SendVoiceOffer")[2]);
    offer.description.sdp = "incoming-video";
    await h.voice.receiveOffer("camera-peer", "Camera", JSON.stringify(offer));
    const connection = h.connections[1];
    const sender = connection.getSenders()[1];
    const transform = sender.transform;
    assert.equal(sender.track, null);
    assert.equal(connection.negotiatedSenderTransforms[1], transform);
    assert.equal(transform.options.operation, "encrypt");
    assert.equal(transform.options.mediaKind, "video");
    assert.equal(transform.options.contextId, "camera-peer");
    await h.voice.setVideoEnabled(true);
    assert.equal(connection.getSenders().length, 2);
    assert.equal(sender.track, camera);
    assert.equal(sender.transform, transform);
    await h.voice.setVideoEnabled(false);
    await h.voice.setVideoEnabled(true);
    assert.equal(sender.transform, transform);
    assert.equal(sender.track, camera);
    h.voice.leave();
});

test("a replacement remote video track replaces the displayed stream and old track events cannot hide it", async () => {
    const h = await createHarness();
    await h.join(true);
    await h.voice.connectToParticipants([{ connectionId: "remote", name: "Remote" }]);
    const connection = h.connections[0];
    const previous = connection.addTransceiver("video").receiver;
    const current = connection.addTransceiver("video").receiver;
    const previousEvents = new Map();
    previous.track.addEventListener = (name, callback) => previousEvents.set(name, callback);
    connection.ontrack({ receiver: previous, track: previous.track });
    const tile = h.remoteContainer.children[1];
    const video = tile.children[1];
    const oldStream = video.srcObject;
    connection.ontrack({ receiver: current, track: current.track });
    assert.notEqual(video.srcObject, oldStream);
    assert.deepEqual([...video.srcObject.getVideoTracks()], [current.track]);
    assert.equal(tile.hidden, false);
    previous.track.muted = true;
    previousEvents.get("mute")();
    previousEvents.get("ended")();
    assert.equal(tile.hidden, false);
    assert.deepEqual([...video.srcObject.getVideoTracks()], [current.track]);
    h.voice.leave();
});

test("camera quality changes constrain every recipient's encoded dimensions as well as capture", async () => {
    const constraints = [];
    const camera = {
        kind: "video", readyState: "live", stop() {}, addEventListener() {},
        getSettings: () => ({ width: 1280, height: 720 }),
        applyConstraints: async value => { constraints.push(value); }
    };
    const h = await createHarness({
        navigator: { mediaDevices: {
            getSupportedConstraints: () => ({}),
            getUserMedia: async () => ({ getVideoTracks: () => [camera] })
        } }
    });
    await h.join(true, "high");
    await h.voice.connectToParticipants([
        { connectionId: "first", name: "First" },
        { connectionId: "second", name: "Second" }
    ]);
    await h.voice.setVideoEnabled(true);
    for (const [quality, width, height, bitrate] of [
        ["very-low", 256, 144, 100000], ["high", 1280, 720, 1500000]
    ]) {
        await h.voice.setVideoQuality(quality);
        assert.equal(constraints.at(-1).height.max, height);
        for (const connection of h.connections) {
            const sender = connection.getSenders().find(item => item.track === camera);
            const encoding = sender.parameters.encodings[0];
            assert.ok(1280 / encoding.scaleResolutionDownBy <= width);
            assert.ok(720 / encoding.scaleResolutionDownBy <= height);
            assert.equal(encoding.maxBitrate, bitrate);
            assert.equal(sender.parameters.degradationPreference, "maintain-resolution");
            assert.equal(sender.transform.options.operation, "encrypt");
        }
    }
    camera.applyConstraints = async () => { throw new Error("Camera constraints rejected"); };
    await assert.rejects(h.voice.setVideoQuality("low"), /Camera constraints rejected/);
    assert.equal(h.callbacks.filter(([method]) => method === "VideoQualityAdapted").at(-1)[1], "high");
    h.voice.leave();
});

test("presence updates refresh participant captions without merging matching names", async () => {
    const h = await createHarness();
    await h.join(true);
    await h.voice.connectToParticipants([
        { connectionId: "first", name: "Amir" },
        { connectionId: "second", name: "Amir" }
    ]);
    h.voice.updateParticipantNames([
        { connectionId: "first", name: "Amir (session 1)" },
        { connectionId: "second", name: "Amir (session 2)" }
    ]);
    assert.equal(h.connections.length, 2);
    assert.equal(h.remoteContainer.children[1].children[2].textContent, "Amir (session 1)");
    assert.equal(h.remoteContainer.children[3].children[2].textContent, "Amir (session 2)");
    h.voice.leave();
});

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
    ["Android", { userAgent: "Mozilla/5.0 (Linux; Android 14)" }, "very-low"],
    ["iPhone", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" }, "very-low"],
    ["iPad", { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0)" }, "very-low"],
    ["desktop-mode iPad", { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }, "very-low"],
    ["client hints mobile", { userAgentData: { mobile: true } }, "very-low"],
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
            method === "AudioQualityAdapted" && value === (quality === "auto" ? "standard" : "very-low")));
        assert.ok(h.callbacks.some(([method, value]) =>
            method === "VideoQualityAdapted" && value === (quality === "auto" ? "standard" : "very-low")));
        h.voice.leave();
    });
}

test("mobile Very Low caps actual senders from the start and preserves manual quality overrides", async () => {
    const h = await createHarness({ navigator: { userAgent: "iPhone" } });
    await h.join(true, h.defaults.getDefaultMediaQuality());
    h.streams[0].addTrack({ kind: "video", readyState: "live", stop() {} });
    await h.voice.connectToParticipants([{ connectionId: "remote", name: "Remote" }]);
    const [audio, video] = h.connections[0].getSenders();
    assert.equal(audio.parameters.encodings[0].maxBitrate, 12000);
    assert.equal(video.parameters.encodings[0].maxBitrate, 100000);
    assert.equal(video.parameters.encodings[0].maxFramerate, 8);
    for (let tick = 0; tick < 6; tick++) await h.adaptQuality();
    assert.equal(audio.parameters.encodings[0].maxBitrate, 12000);
    assert.equal(video.parameters.encodings[0].maxBitrate, 100000);
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

for (const [name, connection, allowed] of [
    ["Data Saver", { saveData: true, effectiveType: "4g", downlink: 10 }, false],
    ["slow 2G", { effectiveType: "slow-2g" }, false],
    ["2G", { effectiveType: "2g" }, false],
    ["3G", { effectiveType: "3g", downlink: 2 }, false],
    ["slow 4G", { effectiveType: "4g", downlink: 1.49 }, false],
    ["offline estimate", { downlink: 0 }, false],
    ["threshold 4G", { effectiveType: "4g", downlink: 1.5 }, true],
    ["fast Wi-Fi", { effectiveType: "4g", downlink: 20 }, true],
    ["missing network estimates", {}, true]
]) {
    test(`mobile transcription availability: ${name}`, async () => {
        const h = await createHarness({ navigator: { userAgent: "Android", connection } });
        assert.equal(h.voice.supportsLiveTranscription(), allowed);
        await h.join(true, "low");
        if (!allowed) {
            await assert.rejects(h.voice.setTranscriptionEnabled(true), /low-bandwidth mobile/);
            assert.deepEqual(h.imports, []);
            assert.equal(h.contexts.length, 0);
        }
        h.voice.leave();
    });
}

test("unknown mobile connection API and desktop Data Saver preserve transcription availability", async () => {
    for (const navigator of [
        { userAgent: "iPhone" },
        { userAgent: "Windows NT", connection: { saveData: true, effectiveType: "2g", downlink: 0.1 } }
    ]) {
        const h = await createHarness({ navigator });
        assert.equal(h.voice.supportsLiveTranscription(), true);
    }
});

test("connection changes update transcription availability while keeping an active session stoppable", async () => {
    const connection = { downlink: 10, effectiveType: "4g" };
    const h = await createHarness({ navigator: { userAgent: "Android", connection } });
    await h.join(true, "low");
    await h.voice.setTranscriptionEnabled(true);
    connection.downlink = 0.5;
    h.networkChanged();
    assert.ok(h.callbacks.some(([method, available]) =>
        method === "TranscriptionAvailabilityChanged" && available === false));
    assert.notEqual(h.workers[1].terminated, true);
    assert.equal(await h.voice.setTranscriptionEnabled(false), false);
    assert.equal(h.workers[1].terminated, true);
    connection.downlink = 5;
    h.networkChanged();
    assert.ok(h.callbacks.some(([method, available, recommendedModel]) =>
        method === "TranscriptionAvailabilityChanged" && available === true && recommendedModel === "base"));
    h.voice.leave();
    assert.equal(h.connectionListeners.size, 0);
});

test("a connection becoming slow during the lazy import prevents model and worker downloads", async () => {
    const connection = { downlink: 10 };
    const h = await createHarness({
        navigator: { userAgent: "Android", connection },
        beforeImport() { connection.downlink = 0.5; }
    });
    await h.join(true, "low");
    await assert.rejects(h.voice.setTranscriptionEnabled(true), /no longer supports/);
    assert.equal(h.workers.length, 1);
    assert.equal(h.contexts.length, 0);
    h.voice.leave();
});

test("unsupported encryption prevents joining before any worker or media stream is created", async () => {
    const h = await createHarness({ transformSupported: false });
    await assert.rejects(h.join(), /does not support password-encrypted WebRTC/);
    assert.equal(h.workers.length, 0);
    assert.equal(h.streams.length, 0);
    assert.equal(h.connections.length, 0);
});

test("encryption transform construction failure never attaches a media sender", async () => {
    const h = await createHarness({ failTransformConstruction: true });
    await h.join(true, "very-low");
    await assert.rejects(
        h.voice.connectToParticipants([{ connectionId: "remote", name: "Remote" }]),
        /Encryption transform unavailable/);
    assert.equal(h.connections[0].getSenders().length, 0);
    assert.ok(!h.callbacks.some(([method]) => method === "SendVoiceOffer"));
    h.voice.leave();
});

test("encryption transform assignment failure detaches the track instead of falling back", async () => {
    const h = await createHarness({ failTransformAssignment: true });
    await h.join(true, "very-low");
    await assert.rejects(
        h.voice.connectToParticipants([{ connectionId: "remote", name: "Remote" }]),
        /Encryption transform assignment failed/);
    assert.ok(h.connections[0].getSenders().every(sender => sender.track === null));
    assert.ok(!h.callbacks.some(([method]) => method === "SendVoiceOffer"));
    h.voice.leave();
});

test("a mismatched media password is rejected before capturing audio or negotiating a connection", async () => {
    const h = await createHarness();
    await h.join();
    await assert.rejects(h.voice.receiveOffer("remote", "Remote", JSON.stringify({
        description: { type: "offer", sdp: "test" },
        mediaKeyConfirmation: "different-password"
    })), /different passwords/);
    assert.equal(h.connections.length, 0);
    assert.equal(h.streams[0].getAudioTracks().length, 0);
    assert.ok(h.callbacks.some(([method, , answer]) =>
        method === "SendVoiceAnswer" && JSON.parse(answer).error === "mediaKeyMismatch"));
    h.voice.leave();
});

test("video quality reductions leave every sender's encryption transform intact", async () => {
    const h = await startVideoHarness("very-low");
    const senders = h.connections.flatMap(connection => connection.getSenders());
    const transforms = senders.map(sender => sender.transform);
    h.connections[0].stats = videoNetworkStats(80000, 0.2);
    await h.adaptQuality();
    senders.forEach((sender, index) => {
        assert.equal(sender.transform, transforms[index]);
        assert.equal(sender.transform.options.operation, "encrypt");
    });
    assert.equal(h.connections[0].getSenders()[1].parameters.encodings[0].maxBitrate, 50000);
    h.voice.leave();
});

test("screen sharing and camera restoration preserve the existing video encryption transform", async () => {
    const camera = { kind: "video", readyState: "live", stop() {}, addEventListener() {}, applyConstraints: () => Promise.resolve() };
    const screen = { kind: "video", readyState: "live", stop() {}, addEventListener() {} };
    const h = await createHarness({
        navigator: {
            mediaDevices: {
                getSupportedConstraints: () => ({}),
                getUserMedia: async () => ({ getVideoTracks: () => [camera] }),
                getDisplayMedia: async () => ({ getVideoTracks: () => [screen] })
            }
        }
    });
    await h.join(true, "very-low");
    await h.voice.setVideoEnabled(true);
    await h.voice.connectToParticipants([{ connectionId: "remote", name: "Remote" }]);
    const sender = h.connections[0].getSenders()[1];
    const transform = sender.transform;
    await h.voice.setScreenSharing(true);
    assert.equal(sender.track, screen);
    assert.equal(sender.transform, transform);
    assert.equal(sender.transform.options.operation, "encrypt");
    await h.voice.setScreenSharing(false);
    assert.equal(sender.track, camera);
    assert.equal(sender.transform, transform);
    h.voice.leave();
});

test("mobile wake lock is acquired, reacquired on return, and released on leave", async () => {
    const locks = [];
    const h = await createHarness({
        navigator: {
            userAgent: "Android",
            wakeLock: {
                async request(type) {
                    assert.equal(type, "screen");
                    const listeners = {};
                    const lock = {
                        released: false,
                        addEventListener(name, listener) { listeners[name] = listener; },
                        async release() { this.released = true; listeners.release?.(); }
                    };
                    locks.push(lock);
                    return lock;
                }
            }
        }
    });
    await h.join();
    assert.equal(h.voice.supportsMobileScreenWakeLock(), true);
    assert.equal(await h.voice.setKeepScreenOn(true), true);
    assert.equal(locks.length, 1);
    await h.visibilityChanged("hidden");
    await locks[0].release();
    assert.equal(locks.length, 1);
    await h.visibilityChanged("visible");
    assert.equal(locks.length, 2);
    h.voice.leave();
    assert.equal(locks[1].released, true);
    assert.equal(h.documentListeners.size, 0);
});

test("desktop does not request a mobile wake lock", async () => {
    let requests = 0;
    const h = await createHarness({
        navigator: { userAgent: "Windows NT", wakeLock: { request() { requests++; } } }
    });
    await h.join();
    assert.equal(await h.voice.setKeepScreenOn(true), false);
    assert.equal(requests, 0);
    h.voice.leave();
});

for (const action of ["leaving", "disabling keep-screen-on"]) {
    test(`a wake-lock request finishing after ${action} is released instead of becoming active`, async () => {
        let resolveRequest;
        const request = new Promise(resolve => { resolveRequest = resolve; });
        const lock = {
            released: false,
            addEventListener() {},
            async release() { this.released = true; }
        };
        const h = await createHarness({
            navigator: { userAgent: "Android", wakeLock: { request: () => request } }
        });
        await h.join();
        const starting = h.voice.setKeepScreenOn(true);
        if (action === "leaving") h.voice.leave();
        else assert.equal(await h.voice.setKeepScreenOn(false), false);
        resolveRequest(lock);
        assert.equal(await starting, false);
        assert.equal(lock.released, true);
        h.voice.leave();
    });
}

test("a stale wake-lock denial cannot disable a newer successful request", async () => {
    let rejectRequest;
    const pendingRequest = new Promise((resolve, reject) => { rejectRequest = reject; });
    const warnings = [];
    const locks = [];
    let requests = 0;
    const h = await createHarness({
        console: { ...console, warn: (...args) => warnings.push(args) },
        navigator: {
            userAgent: "Android",
            wakeLock: {
                request() {
                    if (++requests === 1) return pendingRequest;
                    const listeners = {};
                    const lock = {
                        released: false,
                        addEventListener(name, listener) { listeners[name] = listener; },
                        async release() { this.released = true; listeners.release?.(); }
                    };
                    locks.push(lock);
                    return Promise.resolve(lock);
                }
            }
        }
    });
    await h.join();
    const starting = h.voice.setKeepScreenOn(true);
    assert.equal(await h.voice.setKeepScreenOn(false), false);
    assert.equal(await h.voice.setKeepScreenOn(true), true);
    rejectRequest(new Error("Previous request denied"));
    assert.equal(await starting, false);
    assert.ok(warnings.some(([message]) => message.includes("Unable to keep the screen awake")));
    await locks[0].release();
    await h.visibilityChanged("visible");
    assert.equal(requests, 3);
    h.voice.leave();
    assert.equal(locks[1].released, true);
});

test("wake-lock denial is reported and does not enable keep-screen-on", async () => {
    const warnings = [];
    const h = await createHarness({
        console: { ...console, warn: (...args) => warnings.push(args) },
        navigator: {
            userAgent: "Android",
            wakeLock: { request: () => Promise.reject(new Error("Permission denied")) }
        }
    });
    await h.join();
    assert.equal(await h.voice.setKeepScreenOn(true), false);
    assert.ok(warnings.some(([message]) => message.includes("Unable to keep the screen awake")));
    h.voice.leave();
});

async function startVideoHarness(quality = "low") {
    const h = await createHarness();
    await h.join(true, quality);
    h.streams[0].addTrack({ kind: "video", readyState: "live", stop() {} });
    await h.voice.connectToParticipants([
        { connectionId: "slow-peer", name: "Slow" },
        { connectionId: "fast-peer", name: "Fast" }
    ]);
    return h;
}

function videoNetworkStats(bandwidth, loss = 0, roundTripTime = 0.05) {
    return new Map([
        ["pair", {
            type: "candidate-pair", state: "succeeded", nominated: true,
            availableOutgoingBitrate: bandwidth, currentRoundTripTime: roundTripTime
        }],
        ["remote-video", { type: "remote-inbound-rtp", kind: "video", fractionLost: loss }]
    ]);
}

test("fixed Low video reduces bitrate, frame rate and resolution below the preset for a weak receiver", async () => {
    const h = await startVideoHarness();
    h.connections[0].stats = videoNetworkStats(150000);
    h.connections[1].stats = videoNetworkStats(5000000);
    await h.adaptQuality();
    const slow = h.connections[0].getSenders()[1].parameters.encodings[0];
    const fast = h.connections[1].getSenders()[1].parameters.encodings[0];
    assert.equal(slow.maxBitrate, 89000);
    assert.equal(slow.maxFramerate, 5);
    assert.ok(slow.scaleResolutionDownBy > 1);
    assert.equal(fast.maxBitrate, 250000);
    assert.equal(fast.maxFramerate, 15);
    assert.equal(fast.scaleResolutionDownBy, 1);
    assert.equal(h.connections[0].getSenders()[0].parameters.encodings[0].maxBitrate, 16000);
    h.voice.leave();
});

test("remote video loss reduces a manual High preset even without browser bandwidth estimates", async () => {
    const h = await startVideoHarness("high");
    h.connections[0].stats = videoNetworkStats(undefined, 0.2);
    await h.adaptQuality();
    assert.equal(h.connections[0].getSenders()[1].parameters.encodings[0].maxBitrate, 975000);
    assert.equal(h.connections[1].getSenders()[1].parameters.encodings[0].maxBitrate, 1500000);
    for (let tick = 0; tick < 10; tick++) await h.adaptQuality();
    const encoding = h.connections[0].getSenders()[1].parameters.encodings[0];
    assert.equal(encoding.maxBitrate, 50000);
    assert.equal(encoding.maxFramerate, 5);
    h.voice.leave();
});

test("bandwidth recovery is gradual and never exceeds the chosen Low preset", async () => {
    const h = await startVideoHarness();
    h.connections[0].stats = videoNetworkStats(150000);
    await h.adaptQuality();
    h.connections[0].stats = videoNetworkStats(5000000);
    await h.adaptQuality();
    assert.equal(h.connections[0].getSenders()[1].parameters.encodings[0].maxBitrate, 89000);
    await h.adaptQuality();
    assert.equal(h.connections[0].getSenders()[1].parameters.encodings[0].maxBitrate, 111250);
    for (let tick = 0; tick < 30; tick++) await h.adaptQuality();
    const encoding = h.connections[0].getSenders()[1].parameters.encodings[0];
    assert.equal(encoding.maxBitrate, 250000);
    assert.equal(encoding.maxFramerate, 15);
    assert.equal(encoding.scaleResolutionDownBy, 1);
    h.voice.leave();
});

test("healthy links do not retain an artificial cap when manually increasing quality", async () => {
    const h = await startVideoHarness("very-low");
    for (const connection of h.connections) connection.stats = videoNetworkStats(5000000);
    await h.adaptQuality();
    await h.voice.setVideoQuality("high");
    for (const connection of h.connections) {
        const encoding = connection.getSenders()[1].parameters.encodings[0];
        assert.equal(encoding.maxBitrate, 1500000);
        assert.equal(encoding.maxFramerate, 30);
        assert.equal(encoding.scaleResolutionDownBy, 1);
    }
    h.voice.leave();
});

test("manual quality increases preserve a real bandwidth constraint", async () => {
    const h = await startVideoHarness("very-low");
    h.connections[0].stats = videoNetworkStats(80000);
    await h.adaptQuality();
    await h.voice.setVideoQuality("high");
    assert.equal(h.connections[0].getSenders()[1].parameters.encodings[0].maxBitrate, 50000);
    assert.equal(h.connections[1].getSenders()[1].parameters.encodings[0].maxBitrate, 1500000);
    h.voice.leave();
});

test("Auto does not promote video on RTT-only statistics without a bandwidth estimate", async () => {
    const h = await startVideoHarness("auto");
    for (const connection of h.connections) connection.stats = videoNetworkStats(undefined);
    for (let tick = 0; tick < 5; tick++) await h.adaptQuality();
    assert.ok(!h.callbacks.some(([method, quality]) =>
        method === "VideoQualityAdapted" && quality === "high"));
    h.voice.leave();
});

for (const [device, userAgent, quality, bitrate, height, frameRate] of [
    ["mobile", "Android", "very-low", 100000, 144, 8],
    ["desktop", "Windows NT", "auto", 700000, 480, 24]
]) {
    test(`${device} defaults control actual microphone/camera capture and initial sender limits`, async () => {
        const requests = [];
        const track = kind => ({
            kind, readyState: "live", addEventListener() {},
            stop() { this.readyState = "ended"; },
            applyConstraints() { return Promise.resolve(); }
        });
        const audio = track("audio");
        const video = track("video");
        const h = await createHarness({
            navigator: {
                userAgent,
                mediaDevices: {
                    getSupportedConstraints: () => ({}),
                    async getUserMedia(request) {
                        requests.push(request);
                        return {
                            getAudioTracks: () => [audio],
                            getVideoTracks: () => [video]
                        };
                    }
                }
            }
        });
        assert.equal(h.defaults.getDefaultMediaQuality(), quality);
        await h.join(false, h.defaults.getDefaultMediaQuality());
        await h.voice.connectToParticipants([{ connectionId: "remote", name: "Remote" }]);
        await h.voice.setVideoEnabled(true);
        assert.equal(requests[0].audio.sampleRate.ideal, device === "mobile" ? 16000 : 32000);
        assert.equal(requests[0].audio.echoCancellation.ideal, true);
        assert.equal(requests[1].video.height.max, height);
        assert.equal(requests[1].video.width.max, device === "mobile" ? 256 : 854);
        assert.equal(requests[1].video.frameRate.max, frameRate);
        const [audioSender, videoSender] = h.connections[0].getSenders();
        assert.equal(audioSender.parameters.encodings[0].maxBitrate, device === "mobile" ? 12000 : 32000);
        assert.equal(videoSender.parameters.encodings[0].maxBitrate, bitrate);
        assert.equal(videoSender.parameters.encodings[0].maxFramerate, frameRate);
        assert.deepEqual(h.imports, []);
        h.voice.leave();
    });
}
