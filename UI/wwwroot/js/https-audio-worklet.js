import { audioSampleRate, audioFrameSamples, encodeMuLaw, decodeMuLaw } from "./https-audio-codec.js";

class HttpsAudioProcessor extends AudioWorkletProcessor {
    constructor(options = {}) {
        super();
        this.opus = options.processorOptions?.opus === true;
        this.rate = this.opus ? 48000 : audioSampleRate;
        this.frameSamples = this.opus ? 1920 : audioFrameSamples;
        this.capture = this.opus ? new Float32Array(this.frameSamples) : new Uint8Array(this.frameSamples);
        this.captureIndex = 0;
        this.captureSum = 0;
        this.captureCount = 0;
        this.capturePhase = 0;
        this.muted = false;
        this.peers = new Map();
        this.port.onmessage = ({ data }) => {
            if (data.type === "muted") {
                this.muted = data.muted;
                this.captureIndex = 0;
                this.capturePhase = 0;
                this.captureSum = 0;
                this.captureCount = 0;
            } else if (data.type === "peers") {
                for (const id of this.peers.keys()) {
                    if (!data.ids.includes(id)) this.peers.delete(id);
                }
            } else if (data.type === "audio") {
                let peer = this.peers.get(data.id);
                if (!peer) {
                    peer = { buffer: new Float32Array(this.rate * 0.4), read: 0, count: 0, phase: 0, started: false };
                    this.peers.set(data.id, peer);
                }
                const excess = peer.count + data.samples.length - peer.buffer.length;
                if (excess > 0) {
                    peer.read = (peer.read + excess) % peer.buffer.length;
                    peer.count -= excess;
                    this.port.postMessage({ type: "playback-overrun" });
                }
                for (const sample of data.samples) {
                    peer.buffer[(peer.read + peer.count++) % peer.buffer.length] = this.opus ? sample : decodeMuLaw(sample);
                }
                if (peer.count >= this.frameSamples * 2) peer.started = true;
            }
        };
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0][0];
        for (let index = 0; index < output.length; index++) {
            if (input.length && !this.muted) {
                let value = 0;
                for (const channel of input) value += channel[index] / input.length;
                this.captureSum += value;
                this.captureCount++;
                this.capturePhase += this.rate;
                if (this.capturePhase >= sampleRate) {
                    const sample = this.captureSum / this.captureCount;
                    this.capture[this.captureIndex++] = this.opus ? sample : encodeMuLaw(sample);
                    this.captureSum = 0;
                    this.captureCount = 0;
                    this.capturePhase -= sampleRate;
                    if (this.captureIndex === this.frameSamples) {
                        this.port.postMessage({ type: "capture", samples: this.capture }, [this.capture.buffer]);
                        this.capture = this.opus ? new Float32Array(this.frameSamples) : new Uint8Array(this.frameSamples);
                        this.captureIndex = 0;
                    }
                }
            }
            let mixed = 0;
            let playing = 0;
            for (const peer of this.peers.values()) {
                if (!peer.started || peer.count < 2) {
                    peer.started = false;
                    peer.phase = 0;
                    continue;
                }
                const current = peer.buffer[peer.read];
                const next = peer.buffer[(peer.read + 1) % peer.buffer.length];
                mixed += current + (next - current) * peer.phase;
                playing++;
                peer.phase += this.rate / sampleRate;
                while (peer.phase >= 1 && peer.count > 1) {
                    peer.phase--;
                    peer.read = (peer.read + 1) % peer.buffer.length;
                    peer.count--;
                }
            }
            output[index] = Math.max(-1, Math.min(1, mixed / Math.sqrt(playing || 1)));
        }
        return true;
    }
}

registerProcessor("https-audio", HttpsAudioProcessor);
