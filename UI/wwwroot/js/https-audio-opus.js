export const opusSampleRate = 48000;
export const opusFrameSamples = 1920;
export const opusFrameDuration = 40000;
export const opusDecoderConfig = { codec: "opus", sampleRate: opusSampleRate, numberOfChannels: 1 };
export const opusEncoderConfig = {
    ...opusDecoderConfig, bitrate: 24000,
    opus: { format: "opus", frameDuration: opusFrameDuration, application: "voip", signal: "voice" }
};
let nativeSupport;

function probeNativeOpus() {
    return new Promise((resolve, reject) => {
        let encoder;
        let decoder;
        let finished = false;
        const finish = (supported, error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (encoder && encoder.state !== "closed") encoder.close();
            if (decoder && decoder.state !== "closed") decoder.close();
            if (error && error.name !== "NotSupportedError" && error.name !== "OperationError") reject(error);
            else resolve(supported);
        };
        const timer = setTimeout(() => finish(false), 3000);
        try {
            encoder = new AudioEncoder({
                async output(chunk, metadata) {
                    if (finished) return;
                    try {
                        const config = metadata?.decoderConfig ?? opusDecoderConfig;
                        if (!(await AudioDecoder.isConfigSupported(config)).supported) { finish(false); return; }
                        if (finished) return;
                        decoder = new AudioDecoder({
                            output(audio) {
                                const valid = audio.numberOfFrames > 0 && audio.sampleRate === opusSampleRate;
                                audio.close();
                                finish(valid);
                            },
                            error: error => finish(false, error)
                        });
                        decoder.configure(config);
                        decoder.decode(chunk);
                    } catch (error) { finish(false, error); }
                },
                error: error => finish(false, error)
            });
            encoder.configure(opusEncoderConfig);
            const audio = new AudioData({
                format: "f32", sampleRate: opusSampleRate, numberOfChannels: 1,
                numberOfFrames: opusFrameSamples, timestamp: 0, data: new Float32Array(opusFrameSamples)
            });
            try { encoder.encode(audio); }
            finally { audio.close(); }
        } catch (error) { finish(false, error); }
    });
}

export function packOpusChunk(chunk, description = new Uint8Array()) {
    if (description.length > 256) throw new Error("Native Opus description is too large");
    const packet = new Uint8Array(2 + description.length + chunk.byteLength);
    new DataView(packet.buffer).setUint16(0, description.length);
    packet.set(description, 2);
    chunk.copyTo(packet.subarray(2 + description.length));
    return packet;
}

export function unpackOpusPacket(packet) {
    if (packet.length < 3) throw new Error("Invalid native Opus packet");
    const length = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(0);
    if (length > 256 || packet.length <= 2 + length) throw new Error("Invalid native Opus description");
    return { description: packet.slice(2, 2 + length), data: packet.subarray(2 + length) };
}

export async function getCapabilities() {
    const supportsHttpsAudio = typeof AudioContext === "function" &&
        typeof AudioWorkletNode === "function" && !!globalThis.crypto?.subtle;
    let supportsOpus = false;
    if (supportsHttpsAudio && typeof AudioEncoder === "function" && typeof AudioDecoder === "function" &&
        typeof AudioData === "function" && typeof EncodedAudioChunk === "function") {
        try {
            const [encoder, decoder] = await Promise.all([
                AudioEncoder.isConfigSupported(opusEncoderConfig),
                AudioDecoder.isConfigSupported(opusDecoderConfig)
            ]);
            supportsOpus = encoder.supported && decoder.supported &&
                encoder.config?.opus?.frameDuration === opusFrameDuration;
            if (supportsOpus) {
                nativeSupport ??= probeNativeOpus();
                supportsOpus = await nativeSupport;
            }
        } catch (error) {
            if (error.name !== "NotSupportedError") throw error;
        }
    }
    return {
        supportsHttpsAudio, supportsOpus,
        supportsWebRtc: typeof RTCPeerConnection === "function" && typeof RTCRtpScriptTransform === "function"
    };
}
