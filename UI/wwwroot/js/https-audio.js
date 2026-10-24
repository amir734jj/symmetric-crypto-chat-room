import { AudioFrameError, createAudioCipher } from "./https-audio-crypto.js";
import { getCapabilities, opusSampleRate, opusFrameSamples, opusFrameDuration,
    opusEncoderConfig, opusDecoderConfig, packOpusChunk, unpackOpusPacket } from "./https-audio-opus.js";

export { getCapabilities };

let active;

function notify(session, method, ...args) {
    return active === session
        ? session.reference.invokeMethodAsync(method, ...args)
        : Promise.resolve();
}

async function fail(session, error) {
    if (active !== session || session.failed) return;
    session.failed = true;
    try {
        await notify(session, "HttpsAudioFailed", `${error.message} Leave and rejoin the call to retry.`);
    } finally {
        if (active === session) await leave();
    }
}

function reportFailure(session, error) {
    fail(session, error).catch(failure => console.error("HTTPS audio cleanup failed", failure));
}

export async function initialize(reference, base64Key, opus = false, muted = false, mediaRevision = 0) {
    if (active) throw new Error("HTTPS audio is already active");
    if (typeof AudioWorkletNode !== "function") throw new Error("Stealth audio requires AudioWorklet support");
    const session = {
        reference, opus, mediaRevision, peers: new Set(), receivers: new Map(), muted, queue: [],
        captureTimestamp: 0, minimumCaptureTimestamp: 0,
        sending: false, captureVersion: 0, sent: 0, received: 0, lastReceived: -Infinity,
        lastRateAt: performance.now(), lastSent: 0, lastReceivedBytes: 0
    };
    active = session;
    try {
        if (opus && !(await getCapabilities()).supportsOpus) {
            throw new Error("Native Opus encoder/decoder configuration is not supported in this browser");
        }
        session.cipher = await createAudioCipher(base64Key, opus, mediaRevision);
        if (active !== session) return;
        session.context = new AudioContext({ latencyHint: "interactive", ...(opus ? { sampleRate: opusSampleRate } : {}) });
        await session.context.audioWorklet.addModule(new URL("./https-audio-worklet.js", import.meta.url));
        if (active !== session) return;
        session.node = new AudioWorkletNode(session.context, "https-audio", {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { opus }
        });
        session.node.onprocessorerror = () => reportFailure(session, new Error("Stealth audio processing failed"));
        session.node.connect(session.context.destination);
        session.node.port.postMessage({ type: "muted", muted });
        if (opus) {
            session.encoder = new AudioEncoder({
                output(chunk, metadata) {
                    if (active !== session || session.muted || !session.peers.size ||
                        chunk.timestamp < session.minimumCaptureTimestamp) return;
                    try {
                        if (metadata?.decoderConfig?.description) {
                            session.opusDescription = new Uint8Array(metadata.decoderConfig.description).slice();
                        }
                        enqueueEncoded(session, packOpusChunk(chunk, session.opusDescription));
                    } catch (error) { reportFailure(session, error); }
                },
                error: error => reportFailure(session, error)
            });
            session.encoder.configure(opusEncoderConfig);
        }
        session.node.port.onmessage = ({ data }) => {
            if (active !== session) return;
            if (data.type === "playback-overrun") {
                session.congestedAt = performance.now();
                session.congestionDetail = "Stealth audio playback buffer full; old audio dropped";
                return;
            }
            if (active !== session || data.type !== "capture" || session.muted || !session.peers.size) return;
            if (session.opus) {
                if (session.encoder.encodeQueueSize >= 3) {
                    markCongested(session, "Native Opus encoder busy; audio frames dropped");
                    return;
                }
                try {
                    const audio = new AudioData({
                        format: "f32", sampleRate: opusSampleRate, numberOfFrames: opusFrameSamples,
                        numberOfChannels: 1, timestamp: session.captureTimestamp, data: data.samples
                    });
                    session.captureTimestamp += opusFrameDuration;
                    try { session.encoder.encode(audio); }
                    finally { audio.close(); }
                } catch (error) {
                    reportFailure(session, error);
                }
            } else {
                enqueueEncoded(session, data.samples);
            }
        };
        let resumeTimeout;
        try {
            await Promise.race([
                session.context.resume(),
                new Promise((_, reject) => {
                    resumeTimeout = setTimeout(() => reject(new Error("Audio playback blocked; allow audio and rejoin")), 8000);
                })
            ]);
        } finally {
            clearTimeout(resumeTimeout);
        }
        if (active !== session) return;
        if (session.context.state !== "running") throw new Error("Audio playback is suspended; allow audio and rejoin");
        session.timer = setInterval(() => {
            if (session.sending && performance.now() - session.sendStartedAt > 5000) {
                reportFailure(session, new Error("HTTPS audio upload stalled"));
                return;
            }
            const receiving = performance.now() - session.lastReceived < 2000;
            const congested = session.congestedAt && performance.now() - session.congestedAt < 5000;
            notify(session, "ConnectionHealthChanged",
                congested ? "fair" : receiving ? "healthy" : "waiting",
                congested ? session.congestionDetail
                    : receiving ? "Receiving authenticated HTTPS audio"
                    : "Stealth audio connected; waiting for encrypted audio")
                .catch(error => reportFailure(session, error));
        }, 1000);
    } catch (error) {
        if (active === session) await leave();
        throw error;
    }
}

function markCongested(session, detail) {
    session.congestedAt = performance.now();
    session.congestionDetail = detail;
}

function enqueueEncoded(session, samples) {
    if (session.queue.length >= 3) {
        session.queue.shift();
        markCongested(session, "Stealth audio upload congested; audio frames dropped");
    }
    session.queue.push(samples);
    flush(session).catch(error => reportFailure(session, error));
}

async function flush(session) {
    if (session.sending) return;
    session.sending = true;
    session.sendStartedAt = performance.now();
    try {
        while (active === session && session.queue.length) {
            const packet = await session.cipher.encrypt(session.queue.shift());
            if (active !== session || session.muted || !session.peers.size) continue;
            await notify(session, "SendHttpsAudio", packet, session.mediaRevision);
            session.sent += packet.length;
            session.sendStartedAt = performance.now();
        }
    } finally {
        session.sending = false;
    }
}

function stopCapture(session) {
    session.captureVersion++;
    session.minimumCaptureTimestamp = session.captureTimestamp;
    session.lastReceived = -Infinity;
    session.source?.disconnect();
    session.source = undefined;
    session.stream?.getTracks().forEach(track => track.stop());
    session.stream = undefined;
    session.queue.length = 0;
}

export async function setParticipants(participants) {
    const session = active;
    if (!session) return;
    session.peers = new Set(participants.map(peer => peer.connectionId));
    for (const id of session.receivers.keys()) {
        if (!session.peers.has(id)) {
            const decoder = session.receivers.get(id).decoder;
            if (decoder && decoder.state !== "closed") decoder.close();
            session.receivers.delete(id);
        }
    }
    session.node.port.postMessage({ type: "peers", ids: [...session.peers] });
    if (!session.peers.size) {
        stopCapture(session);
        return;
    }
    if (session.stream || session.capturing) return;
    const version = session.captureVersion;
    session.capturing = true;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
        });
        if (active !== session || session.captureVersion !== version || !session.peers.size) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        session.stream = stream;
        stream.getAudioTracks().forEach(track => {
            track.enabled = !session.muted;
            track.addEventListener("ended", () => {
                if (active === session && session.stream === stream) {
                    reportFailure(session, new Error("Microphone stopped"));
                }
            });
        });
        session.source = session.context.createMediaStreamSource(stream);
        session.source.connect(session.node);
    } finally {
        session.capturing = false;
        if (active === session && session.peers.size && !session.stream && session.captureVersion !== version) {
            await setParticipants([...session.peers].map(connectionId => ({ connectionId })));
        }
    }
}

export function receiveAudio(connectionId, packet) {
    const session = active;
    if (!session || !session.peers.has(connectionId)) return Promise.resolve();
    let receiver = session.receivers.get(connectionId);
    if (!receiver) {
        receiver = { pendingFrames: 0 };
        session.receivers.set(connectionId, receiver);
    }
    if (receiver.pendingFrames >= 5) {
        session.congestedAt = performance.now();
        session.congestionDetail = "Stealth audio receive queue full; audio frames dropped";
        return Promise.resolve();
    }
    receiver.pendingFrames++;
    const operation = (receiver.tail ?? Promise.resolve()).then(() =>
        decryptAndPlay(session, connectionId, packet, receiver));
    receiver.tail = operation.catch(error => reportFailure(session, error));
    return operation.finally(() => { receiver.pendingFrames--; });
}

async function decryptAndPlay(session, connectionId, packet, receiver) {
    if (active !== session || session.failed || !session.peers.has(connectionId) ||
        session.receivers.get(connectionId) !== receiver) return;
    let samples;
    try {
        samples = await session.cipher.decrypt(packet, receiver);
    } catch (error) {
        if (!(error instanceof AudioFrameError) && error.name !== "OperationError") throw error;
        if (!receiver.unreadable && active === session) {
            receiver.unreadable = true;
            await notify(session, "HttpsAudioUnreadable", connectionId, true);
        }
        return;
    }
    if (active !== session || !session.peers.has(connectionId) ||
        session.receivers.get(connectionId) !== receiver) return;
    if (session.opus) {
        const decodedPacket = unpackOpusPacket(samples);
        if (!receiver.decoder) {
            receiver.description = decodedPacket.description;
            receiver.decoder = new AudioDecoder({
                output(audio) {
                    try {
                        if (active !== session || session.receivers.get(connectionId) !== receiver) return;
                        if (audio.sampleRate !== opusSampleRate || audio.numberOfFrames > opusSampleRate * 0.12) {
                            reportFailure(session, new Error("Unexpected decoded Opus audio format"));
                            return;
                        }
                        const pcm = new Float32Array(audio.numberOfFrames);
                        audio.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
                        session.node.port.postMessage({ type: "audio", id: connectionId, samples: pcm }, [pcm.buffer]);
                    } catch (error) {
                        reportFailure(session, error);
                    } finally { audio.close(); }
                },
                error: error => reportFailure(session, error)
            });
            receiver.decoder.configure({
                ...opusDecoderConfig,
                ...(receiver.description.length ? { description: receiver.description } : {})
            });
        } else if (receiver.description.length !== decodedPacket.description.length ||
            receiver.description.some((value, index) => value !== decodedPacket.description[index])) {
            throw new Error("Native Opus stream configuration changed without rejoining");
        }
        if (receiver.decoder.decodeQueueSize >= 5) {
            markCongested(session, "Native Opus decoder busy; audio frames dropped");
            return;
        }
        receiver.decoder.decode(new EncodedAudioChunk({
            type: "key", timestamp: Number(receiver.counter) * opusFrameDuration, data: decodedPacket.data
        }));
    } else {
        session.node.port.postMessage({ type: "audio", id: connectionId, samples }, [samples.buffer]);
    }
    session.received += packet.length;
    session.lastReceived = performance.now();
    if (receiver.unreadable) {
        receiver.unreadable = false;
        await notify(session, "HttpsAudioUnreadable", connectionId, false);
    }
}

export function setMuted(muted) {
    const session = active;
    if (!session) throw new Error("Stealth audio is not active");
    session.muted = muted;
    session.minimumCaptureTimestamp = session.captureTimestamp;
    session.queue.length = 0;
    session.node.port.postMessage({ type: "muted", muted });
    session.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
}

export function getLiveDataRateMbps() {
    const session = active;
    if (!session) return [0, 0];
    const now = performance.now();
    const seconds = Math.max(0.001, (now - session.lastRateAt) / 1000);
    const rates = [(session.sent - session.lastSent) * 8 / seconds / 1000000,
        (session.received - session.lastReceivedBytes) * 8 / seconds / 1000000];
    session.lastRateAt = now;
    session.lastSent = session.sent;
    session.lastReceivedBytes = session.received;
    return rates;
}

export function getConnectionDiagnostics() {
    const session = active;
    return JSON.stringify({
        transport: "SignalR (WebSocket or HTTP fallback)", audioOnly: true, encrypted: Boolean(session?.cipher),
        codec: session?.opus ? "Native Opus, 48 kHz mono, 24 kbps"
            : "Compatibility G.711 mu-law, 8 kHz mono, 64 kbps", peers: session?.peers.size ?? 0,
        bytesSent: session?.sent ?? 0, bytesReceived: session?.received ?? 0,
        pendingFrames: session?.queue.length ?? 0
    }, null, 2);
}

export async function leave() {
    const session = active;
    if (!session) return;
    active = undefined;
    clearInterval(session.timer);
    stopCapture(session);
    if (session.encoder && session.encoder.state !== "closed") session.encoder.close();
    for (const receiver of session.receivers.values()) {
        if (receiver.decoder && receiver.decoder.state !== "closed") receiver.decoder.close();
    }
    if (session.node) {
        session.node.onprocessorerror = null;
        session.node.port.onmessage = null;
        session.node.port.close();
        session.node.disconnect();
    }
    if (session.context && session.context.state !== "closed") await session.context.close();
}
