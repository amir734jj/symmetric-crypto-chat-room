import { AudioFrameError, createAudioCipher } from "./https-audio-crypto.js";
import { audioSampleRate } from "./https-audio-codec.js";
import { getCapabilities, opusSampleRate, opusFrameSamples, opusFrameDuration,
    opusEncoderConfig, opusDecoderConfig, packOpusChunk, unpackOpusPacket } from "./https-audio-opus.js";

export { getCapabilities };

let active;
let lastDiagnostics;

function recordFailure(session, error, stage) {
    session.lastError = { stage, name: error.name, message: error.message };
}

function notify(session, method, ...args) {
    return active === session
        ? session.reference.invokeMethodAsync(method, ...args)
        : Promise.resolve();
}

async function fail(session, error, stage) {
    if (active !== session || session.failed) return;
    recordFailure(session, error, stage);
    session.failed = true;
    try {
        await notify(session, "HttpsAudioFailed", `${stage}: ${error.message} Leave and rejoin the call to retry.`);
    } finally {
        if (active === session) await leave();
    }
}

function reportFailure(session, error, stage = "audio processing") {
    fail(session, error, stage).catch(failure => console.error("HTTPS audio cleanup failed", failure));
}

async function resumeContext(context) {
    let timeout;
    try {
        await Promise.race([
            context.resume(),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error("Audio playback blocked; allow audio and rejoin")), 8000);
            })
        ]);
    } finally {
        clearTimeout(timeout);
    }
    if (context.state !== "running") throw new Error(`Audio playback is ${context.state}; allow audio and rejoin`);
}

export async function initialize(reference, base64Key, opus = false, muted = false, mediaRevision = 0) {
    if (active) throw new Error("HTTPS audio is already active");
    if (typeof AudioWorkletNode !== "function") throw new Error("Stealth audio requires AudioWorklet support");
    const session = {
        reference, opus, mediaRevision, peers: new Set(), receivers: new Map(), muted, queue: [],
        captureTimestamp: 0, minimumCaptureTimestamp: 0,
        sending: false, captureVersion: 0, sent: 0, received: 0, lastReceived: -Infinity,
        lastRateAt: performance.now(), lastSent: 0, lastReceivedBytes: 0,
        startedAt: performance.now(), captureFrames: 0, encodedFrames: 0, uploadedFrames: 0,
        incomingFrames: 0, authenticatedFrames: 0, decodedFrames: 0, rejectedFrames: 0,
        droppedUploadFrames: 0, droppedReceiveFrames: 0, lastCaptureAt: -Infinity,
        lastIncomingAt: -Infinity, lastPlayedAt: -Infinity, stage: "codec capability check"
    };
    active = session;
    lastDiagnostics = undefined;
    try {
        if (opus && !(await getCapabilities()).supportsOpus) {
            throw new Error("Native Opus encoder/decoder configuration is not supported in this browser");
        }
        session.stage = "encryption initialization";
        session.cipher = await createAudioCipher(base64Key, opus, mediaRevision);
        if (active !== session) return;
        const sampleRate = opus ? opusSampleRate : audioSampleRate;
        session.stage = "audio context creation";
        session.context = new AudioContext({ latencyHint: "interactive", sampleRate });
        if (session.context.sampleRate !== sampleRate) {
            throw new Error(`Stealth audio requires browser-native ${sampleRate} Hz audio processing`);
        }
        session.stage = "audio worklet loading";
        await session.context.audioWorklet.addModule(new URL("./https-audio-worklet.js", import.meta.url));
        if (active !== session) return;
        session.node = new AudioWorkletNode(session.context, "https-audio", {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { opus }
        });
        session.node.onprocessorerror = () => reportFailure(session, new Error("Stealth audio processing failed"), "audio worklet");
        session.node.connect(session.context.destination);
        session.node.port.postMessage({ type: "muted", muted });
        if (opus) {
            session.stage = "Opus encoder initialization";
            session.encoder = new AudioEncoder({
                output(chunk, metadata) {
                    if (active !== session || session.muted || !session.peers.size ||
                        chunk.timestamp < session.minimumCaptureTimestamp) return;
                    try {
                        if (metadata?.decoderConfig?.description) {
                            session.opusDescription = new Uint8Array(metadata.decoderConfig.description).slice();
                        }
                        enqueueEncoded(session, packOpusChunk(chunk, session.opusDescription));
                    } catch (error) { reportFailure(session, error, "Opus packet framing"); }
                },
                error: error => reportFailure(session, error, "Opus encoding")
            });
            session.encoder.configure(opusEncoderConfig);
        }
        session.node.port.onmessage = ({ data }) => {
            if (active !== session) return;
            if (data.type === "stats") {
                if (data.playedSamples > (session.workletStats?.playedSamples ?? 0))
                    session.lastPlayedAt = performance.now();
                session.workletStats = data;
                return;
            }
            if (data.type === "playback-overrun") {
                session.congestedAt = performance.now();
                session.congestionDetail = "Stealth audio playback buffer full; old audio dropped";
                return;
            }
            if (active !== session || data.type !== "capture" || session.muted || !session.peers.size) return;
            session.captureFrames++;
            session.lastCaptureAt = performance.now();
            if (session.opus) {
                if (session.encoder.encodeQueueSize >= 3) {
                    session.droppedUploadFrames++;
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
                    reportFailure(session, error, "Opus encoding");
                }
            } else {
                enqueueEncoded(session, data.samples);
            }
        };
        session.stage = "audio playback activation";
        await resumeContext(session.context);
        if (active !== session) return;
        session.stage = "ready";
        session.timer = setInterval(() => {
            session.node.port.postMessage({ type: "get-stats" });
            if (session.sending && performance.now() - session.sendStartedAt > 5000) {
                reportFailure(session, new Error("HTTPS audio upload stalled"), "encrypted upload");
                return;
            }
            const contextRunning = session.context.state === "running";
            const receiving = contextRunning &&
                performance.now() - session.lastReceived < 2000 && performance.now() - session.lastPlayedAt < 2000;
            const congested = session.congestedAt && performance.now() - session.congestedAt < 5000;
            notify(session, "ConnectionHealthChanged",
                !contextRunning ? "waiting" : congested ? "fair" : receiving ? "healthy" : "waiting",
                !contextRunning ? diagnosticMessages(session).join(" ")
                    : congested ? session.congestionDetail
                    : receiving ? "Authenticated HTTPS audio is reaching the playback worklet (speaker audibility is not verified)"
                    : diagnosticMessages(session).join(" "))
                .catch(error => reportFailure(session, error));
        }, 1000);
    } catch (error) {
        recordFailure(session, error, session.stage);
        if (active === session) await leave();
        throw error;
    }
}

function markCongested(session, detail) {
    session.congestedAt = performance.now();
    session.congestionDetail = detail;
}

function enqueueEncoded(session, samples) {
    session.encodedFrames++;
    if (session.queue.length >= 3) {
        session.queue.shift();
        session.droppedUploadFrames++;
        markCongested(session, "Stealth audio upload congested; audio frames dropped");
    }
    session.queue.push(samples);
    flush(session).catch(error => reportFailure(session, error, session.uploadStage ?? "encrypted upload"));
}

async function flush(session) {
    if (session.sending) return;
    session.sending = true;
    session.sendStartedAt = performance.now();
    try {
        while (active === session && session.queue.length) {
            session.uploadStage = "audio encryption";
            const packet = await session.cipher.encrypt(session.queue.shift());
            if (active !== session || session.muted || !session.peers.size) continue;
            session.uploadStage = "encrypted upload";
            await notify(session, "SendHttpsAudio", packet, session.mediaRevision);
            session.uploadStage = "ready";
            session.sent += packet.length;
            session.uploadedFrames++;
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
    session.captureRequestedAt = performance.now();
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
                    reportFailure(session, new Error("Microphone stopped"), "microphone capture");
                }
            });
        });
        session.source = session.context.createMediaStreamSource(stream);
        session.source.connect(session.node);
    } catch (error) {
        if (active !== session || session.captureVersion !== version || !session.peers.size) return;
        recordFailure(session, error, "microphone capture");
        throw error;
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
    session.incomingFrames++;
    session.lastIncomingAt = performance.now();
    let receiver = session.receivers.get(connectionId);
    if (!receiver) {
        receiver = { pendingFrames: 0 };
        session.receivers.set(connectionId, receiver);
    }
    if (receiver.pendingFrames >= 5) {
        session.droppedReceiveFrames++;
        session.congestedAt = performance.now();
        session.congestionDetail = "Stealth audio receive queue full; audio frames dropped";
        return Promise.resolve();
    }
    receiver.pendingFrames++;
    const operation = (receiver.tail ?? Promise.resolve()).then(() =>
        decryptAndPlay(session, connectionId, packet, receiver));
    receiver.tail = operation.catch(error => reportFailure(session, error, "audio decode or playback"));
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
        session.rejectedFrames++;
        receiver.lastError = error.name === "OperationError"
            ? "Authentication failed: the password/key or media epoch differs, or the frame was altered"
            : error.message;
        if (!receiver.unreadable && active === session) {
            receiver.unreadable = true;
            await notify(session, "HttpsAudioUnreadable", connectionId, true);
        }
        return;
    }
    session.authenticatedFrames++;
    receiver.lastError = undefined;
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
                            reportFailure(session, new Error("Unexpected decoded Opus audio format"), "Opus decoding");
                            return;
                        }
                        const pcm = new Float32Array(audio.numberOfFrames);
                        audio.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
                        session.node.port.postMessage({ type: "audio", id: connectionId, samples: pcm }, [pcm.buffer]);
                        session.decodedFrames++;
                    } catch (error) {
                        reportFailure(session, error, "Opus playback transfer");
                    } finally { audio.close(); }
                },
                error: error => reportFailure(session, error, "Opus decoding")
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
            session.droppedReceiveFrames++;
            markCongested(session, "Native Opus decoder busy; audio frames dropped");
            return;
        }
        receiver.decoder.decode(new EncodedAudioChunk({
            type: "key", timestamp: Number(receiver.counter) * opusFrameDuration, data: decodedPacket.data
        }));
    } else {
        session.node.port.postMessage({ type: "audio", id: connectionId, samples }, [samples.buffer]);
        session.decodedFrames++;
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

function diagnosticMessages(session) {
    if (session.lastError) return [`${session.lastError.stage}: ${session.lastError.name}: ${session.lastError.message}`];
    if (!session.peers.size) return ["Waiting for another participant to join the call."];
    if (session.context?.state !== "running")
        return [`Browser audio context is ${session.context?.state ?? "not initialized"}; capture/playback cannot run. Try Resume audio or rejoin.`];
    const messages = [];
    const track = session.stream?.getAudioTracks()[0];
    if (session.capturing) messages.push("Waiting for microphone permission or device initialization.");
    else if (!track) messages.push("No microphone track is attached.");
    else if (session.muted || !track.enabled) messages.push("Your microphone is muted.");
    else if (track.muted) messages.push("The browser reports that the microphone is not delivering audio.");
    else if (performance.now() - (session.captureRequestedAt ?? session.startedAt) > 5000 &&
        performance.now() - session.lastCaptureAt > 5000)
        messages.push("Microphone attached, but no capture frames are reaching the encoder.");
    else if (session.workletStats?.capturedSamples > 0 && session.workletStats.microphonePeak < 0.00001)
        messages.push("Capture is running, but the latest microphone samples are silent.");
    if (session.captureFrames && !session.uploadedFrames)
        messages.push("Audio was captured, but no encrypted upload has completed.");
    const unreadable = [...session.receivers.values()].find(receiver => receiver.lastError);
    if (unreadable) messages.push(`Incoming encrypted audio is unreadable. ${unreadable.lastError}.`);
    if (!session.incomingFrames || performance.now() - session.lastIncomingAt > 5000)
        messages.push("No incoming HTTPS audio frames. This device alone cannot distinguish remote capture/mute problems from relay/network delivery problems.");
    else if (session.authenticatedFrames && !session.decodedFrames)
        messages.push("Incoming frames authenticate, but no decoded audio has reached playback.");
    else if (session.decodedFrames && performance.now() - session.lastPlayedAt > 5000)
        messages.push("Audio decoded, but playback has not been confirmed by the audio worklet.");
    else if (session.workletStats?.playedSamples > 0 && session.workletStats.playbackPeak < 0.00001)
        messages.push("Playback is running, but the latest received audio samples are silent.");
    if (!messages.length)
        messages.push("Capture, authenticated reception and worklet playback are active. Device volume, output routing and speaker audibility cannot be verified by this page.");
    return messages;
}

function diagnostics(session) {
    const track = session.stream?.getAudioTracks()[0];
    return {
        active: active === session, snapshot: active === session ? "live" : "last state before cleanup",
        transport: "SignalR (WebSocket or HTTP fallback)", audioOnly: true,
        encrypted: active === session && Boolean(session.cipher), mediaRevision: session.mediaRevision,
        diagnosis: diagnosticMessages(session), lastError: session.lastError ?? null,
        codec: session.opus ? "Native Opus, 48 kHz mono, 24 kbps" : "Compatibility G.711 mu-law, 8 kHz mono, 64 kbps",
        peers: session.peers.size, audioContext: session.context?.state ?? "not initialized",
        sampleRate: session.context?.sampleRate, muted: session.muted,
        microphone: track ? { enabled: track.enabled, muted: track.muted, readyState: track.readyState } : null,
        captureFrames: session.captureFrames, encodedFrames: session.encodedFrames,
        uploadedFrames: session.uploadedFrames, incomingFrames: session.incomingFrames,
        authenticatedFrames: session.authenticatedFrames, decodedFrames: session.decodedFrames,
        rejectedFrames: session.rejectedFrames, droppedUploadFrames: session.droppedUploadFrames,
        droppedReceiveFrames: session.droppedReceiveFrames,
        bytesSent: session.sent, bytesReceived: session.received, pendingFrames: session.queue.length,
        uploadStage: session.uploadStage ?? "not started", congestion: session.congestionDetail ?? null,
        worklet: session.workletStats ? {
            capturedSamples: session.workletStats.capturedSamples, microphonePeak: session.workletStats.microphonePeak,
            playedSamples: session.workletStats.playedSamples, playbackPeak: session.workletStats.playbackPeak,
            bufferedSamples: session.workletStats.bufferedSamples, underruns: session.workletStats.underruns
        } : null,
        limitations: "Uploaded bytes confirm client dispatch, not server forwarding. Playback samples confirm the audio graph, not audible speakers. No microphone samples, passwords or encryption keys are included."
    };
}

export function getConnectionDiagnostics() {
    return JSON.stringify(active ? diagnostics(active) : lastDiagnostics ??
        { active: false, encrypted: false, diagnosis: ["No HTTPS audio session has started."] }, null, 2);
}

export async function resumeAudio() {
    const session = active;
    if (!session) throw new Error("Join an HTTPS audio call before resuming playback");
    await resumeContext(session.context);
}

export async function leave() {
    const session = active;
    if (!session) return;
    active = undefined;
    lastDiagnostics = diagnostics(session);
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
