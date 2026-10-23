let dotNetReference;
let worker;
let context;
let processor;
let sink;
let enabled = false;
let sessionId = 0;
let busy = false;
let samples = [];
let sampleCount = 0;
const sources = new Map();
const sampleRate = 16000;
const windowSamples = sampleRate * 6;

export function isEnabled() {
    return enabled;
}

export async function start(reference, model, getStreams) {
    if (enabled) return true;
    dotNetReference = reference;
    enabled = true;
    const startingSession = ++sessionId;

    try {
        worker = new Worker(
            new URL("./transcription-worker.js", import.meta.url),
            { type: "module" });
        worker.onmessage = event => {
            if (sessionId === startingSession) handleWorkerMessage(event);
        };
        worker.onerror = event => {
            if (sessionId !== startingSession) return;
            notifyStatus(`Transcription stopped: ${event.message || "worker error"}`, true);
            stop();
        };
        worker.postMessage({ type: "initialize", model });

        const AudioContextType = window.AudioContext || window.webkitAudioContext;
        const startingContext = context = new AudioContextType();
        await startingContext.resume();
        if (!enabled || context !== startingContext) return false;

        processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = collectAudio;
        sink = context.createGain();
        sink.gain.value = 0;
        processor.connect(sink);
        sink.connect(context.destination);

        for (const [id, stream] of getStreams()) connectStream(id, stream);
        notifyStatus("Preparing on-device transcription model...", false);
        return true;
    } catch (error) {
        if (sessionId === startingSession) stop();
        throw error;
    }
}

export function connectStream(id, stream) {
    if (!enabled || !context || !processor ||
        sources.has(id) || stream.getAudioTracks().length === 0) return;

    const source = context.createMediaStreamSource(stream);
    source.connect(processor);
    sources.set(id, source);
}

export function disconnectStream(id) {
    sources.get(id)?.disconnect();
    sources.delete(id);
}

function collectAudio(event) {
    if (!enabled) return;

    const audio = resampleAudio(
        event.inputBuffer.getChannelData(0),
        event.inputBuffer.sampleRate,
        sampleRate);
    samples.push(audio);
    sampleCount += audio.length;
    if (!busy && sampleCount >= windowSamples) sendWindow();

    const maximumBufferedSamples = windowSamples * 2;
    while (sampleCount > maximumBufferedSamples && samples.length > 1) {
        sampleCount -= samples.shift().length;
    }
}

function sendWindow() {
    if (!worker || busy || sampleCount === 0) return;

    const audio = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of samples) {
        audio.set(chunk, offset);
        offset += chunk.length;
    }
    samples = [];
    sampleCount = 0;
    const rootMeanSquare = Math.sqrt(
        audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
    if (rootMeanSquare < 0.005) return;

    busy = true;
    worker.postMessage({ type: "transcribe", audio }, [audio.buffer]);
}

function resampleAudio(input, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) return new Float32Array(input);

    const ratio = inputSampleRate / outputSampleRate;
    const output = new Float32Array(Math.floor(input.length / ratio));
    for (let index = 0; index < output.length; index++) {
        const inputIndex = index * ratio;
        const lowerIndex = Math.floor(inputIndex);
        const upperIndex = Math.min(lowerIndex + 1, input.length - 1);
        const weight = inputIndex - lowerIndex;
        output[index] = input[lowerIndex] * (1 - weight) + input[upperIndex] * weight;
    }
    return output;
}

function handleWorkerMessage(event) {
    if (!enabled) return;

    const message = event.data;
    if (message?.type === "result") {
        busy = false;
        if (message.text) {
            dotNetReference?.invokeMethodAsync("TranscriptionTextReceived", message.text).catch(() => {});
        }
        if (sampleCount >= windowSamples) sendWindow();
    } else if (message?.type === "status") {
        notifyStatus(message.message, false);
    } else if (message?.type === "error") {
        notifyStatus(`Transcription stopped: ${message.message}`, true);
        stop();
    }
}

function notifyStatus(message, failed) {
    dotNetReference?.invokeMethodAsync("TranscriptionStatusChanged", message, failed).catch(() => {});
}

export function stop() {
    sessionId++;
    enabled = false;
    busy = false;
    samples = [];
    sampleCount = 0;
    for (const source of sources.values()) source.disconnect();
    sources.clear();
    if (processor) {
        processor.onaudioprocess = null;
        processor.disconnect();
    }
    sink?.disconnect();
    context?.close().catch(error => console.warn("Unable to close transcription audio context", error));
    worker?.terminate();
    processor = undefined;
    sink = undefined;
    context = undefined;
    worker = undefined;
    dotNetReference = undefined;
}
