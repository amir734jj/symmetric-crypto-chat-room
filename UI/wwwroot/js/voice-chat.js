let dotNetReference;
let remoteAudioContainer;
let localStream;
let peerConfiguration;
let encryptionWorker;
let voiceKey;
let localConnectionId;
let audioQuality = "standard";
let audioQualityMode = "auto";
let adaptationTimer;
let goodNetworkSamples = 0;
let poorNetworkSamples = 0;
let adaptationInProgress = false;
let screenWakeLock;
let selectedAudioOutputId = "";
let audioOutputMode = "auto";
let proximitySensor;
let proximitySensorNear;
const peers = new Map();
const audioQualityProfiles = {
    low: { sampleRate: 16000, maxBitrate: 16000 },
    standard: { sampleRate: 32000, maxBitrate: 32000 },
    high: { sampleRate: 48000, maxBitrate: 64000 }
};

export async function initialize(reference, container, turnCredentials, passwordDerivedKey, selectedAudioQuality) {
    if (!("RTCRtpScriptTransform" in window)) {
        throw new Error("This browser does not support password-encrypted WebRTC audio");
    }

    dotNetReference = reference;
    remoteAudioContainer = container;
    voiceKey = passwordDerivedKey;
    localConnectionId = turnCredentials.username.split(":", 2)[1];
    audioQualityMode = normalizeAudioQualityMode(selectedAudioQuality);
    audioQuality = audioQualityMode === "auto" ? "standard" : audioQualityMode;
    encryptionWorker = new Worker(new URL("./voice-crypto-worker.js", import.meta.url), { type: "module" });

    const host = turnCredentials.host || window.location.hostname;
    peerConfiguration = {
        iceTransportPolicy: turnCredentials.relayOnly ? "relay" : "all",
        iceServers: [
            { urls: [`stun:${host}:3478`] },
            {
                urls: [
                    `turn:${host}:3478?transport=udp`,
                    `turn:${host}:3478?transport=tcp`
                ],
                username: turnCredentials.username,
                credential: turnCredentials.credential
            }
        ]
    };

    localStream = await navigator.mediaDevices.getUserMedia({
        audio: getAudioConstraints(),
        video: false
    });
    const nativeAudioRouter = getNativeAudioRouter();
    if (typeof nativeAudioRouter?.startCall === "function") {
        await nativeAudioRouter.startCall();
    }
    if (nativeAudioRouter || "audioSession" in navigator) {
        await setAudioOutputMode("auto");
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    await requestScreenWakeLock();
    startQualityAdaptation();
    notifyAudioQualityChanged();
}

export async function connectToParticipants(connectionIds) {
    for (const connectionId of connectionIds) {
        const peer = await createPeer(connectionId);
        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        await dotNetReference.invokeMethodAsync(
            "SendVoiceOffer",
            connectionId,
            JSON.stringify(peer.connection.localDescription));
    }
}

export async function receiveOffer(senderConnectionId, offerJson) {
    const peer = await createPeer(senderConnectionId);
    await peer.connection.setRemoteDescription(JSON.parse(offerJson));
    await addPendingCandidates(peer);

    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    await dotNetReference.invokeMethodAsync(
        "SendVoiceAnswer",
        senderConnectionId,
        JSON.stringify(peer.connection.localDescription));
}

export async function receiveAnswer(senderConnectionId, answerJson) {
    const peer = peers.get(senderConnectionId);
    if (!peer) return;

    await peer.connection.setRemoteDescription(JSON.parse(answerJson));
    await addPendingCandidates(peer);
}

export async function receiveIceCandidate(senderConnectionId, candidateJson) {
    const peer = await createPeer(senderConnectionId);
    const candidate = JSON.parse(candidateJson);

    if (peer.connection.remoteDescription) {
        await peer.connection.addIceCandidate(candidate);
    } else {
        peer.pendingCandidates.push(candidate);
    }
}

export function setMuted(muted) {
    if (!localStream) return;
    for (const track of localStream.getAudioTracks()) {
        track.enabled = !muted;
    }
}

export function supportsAudioOutputSelection() {
    return Boolean(getNativeAudioRouter()) || supportsAudioOutputDevicePicker() || "audioSession" in navigator;
}

export function usesAudioSessionOutputModes() {
    return Boolean(getNativeAudioRouter()) || "audioSession" in navigator;
}

export async function chooseAudioOutput() {
    if (supportsAudioOutputDevicePicker()) {
        const options = selectedAudioOutputId ? { deviceId: selectedAudioOutputId } : undefined;
        const output = await navigator.mediaDevices.selectAudioOutput(options);
        await Promise.all([...peers.values()].map(peer => peer.audio.setSinkId(output.deviceId)));
        selectedAudioOutputId = output.deviceId;
        return output.label || "Selected output";
    }

    throw new Error("Audio output selection is not supported by this browser");
}

export async function setAudioOutputMode(selectedMode) {
    const nativeAudioRouter = getNativeAudioRouter();
    if (!nativeAudioRouter && !("audioSession" in navigator)) {
        throw new Error("Audio output modes are not supported by this browser");
    }

    const mode = ["auto", "speaker", "earpiece"].includes(selectedMode)
        ? selectedMode
        : "auto";
    stopProximityRouting();
    audioOutputMode = mode;

    if (nativeAudioRouter) {
        await nativeAudioRouter.setMode({ mode });
        return mode;
    }

    if (!applyAudioOutputMode(mode)) {
        throw new Error("The browser could not change the audio route");
    }

    if (mode === "auto") {
        startProximityRouting();
    }

    return mode;
}

function supportsAudioOutputDevicePicker() {
    return typeof navigator.mediaDevices.selectAudioOutput === "function" &&
        typeof HTMLMediaElement.prototype.setSinkId === "function";
}

function getNativeAudioRouter() {
    return window.Capacitor?.Plugins?.VoiceAudioRouter;
}

export async function setAudioQuality(selectedAudioQuality) {
    audioQualityMode = normalizeAudioQualityMode(selectedAudioQuality);
    goodNetworkSamples = 0;
    poorNetworkSamples = 0;
    await setEffectiveAudioQuality(audioQualityMode === "auto" ? "standard" : audioQualityMode);
    return audioQuality;
}

async function setEffectiveAudioQuality(selectedAudioQuality) {
    const normalizedQuality = normalizeAudioQuality(selectedAudioQuality);
    const qualityChanged = audioQuality !== normalizedQuality;
    audioQuality = normalizedQuality;

    if (localStream) {
        const constraintResults = await Promise.allSettled(localStream.getAudioTracks()
            .map(track => track.applyConstraints(getAudioConstraints())));
        for (const result of constraintResults) {
            if (result.status === "rejected") {
                console.warn("Unable to change microphone capture quality without restarting the track", result.reason);
            }
        }
    }

    const senderResults = await Promise.allSettled([...peers.values()]
        .flatMap(peer => peer.connection.getSenders())
        .filter(sender => sender.track?.kind === "audio")
        .map(applySenderAudioQuality));
    const senderFailure = senderResults.find(result => result.status === "rejected");
    if (senderFailure) {
        throw senderFailure.reason;
    }

    if (qualityChanged) {
        notifyAudioQualityChanged();
    }
}

export async function getConnectionDiagnostics() {
    const nativeAudioRouter = getNativeAudioRouter();
    let nativeAudioRouting = { supported: false };
    if (nativeAudioRouter) {
        try {
            nativeAudioRouting = await nativeAudioRouter.getCapabilities();
        } catch (error) {
            nativeAudioRouting = { supported: false, error: error.message };
        }
    }

    const peerDiagnostics = await Promise.all(
        [...peers.entries()].map(async ([connectionId, peer]) => {
            const stats = await peer.connection.getStats();
            const reports = new Map();
            let selectedPair;

            stats.forEach(report => reports.set(report.id, report));
            stats.forEach(report => {
                if (report.type === "transport" && report.selectedCandidatePairId) {
                    selectedPair = reports.get(report.selectedCandidatePairId);
                }
            });

            if (!selectedPair) {
                stats.forEach(report => {
                    if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
                        selectedPair = report;
                    }
                });
            }

            const localCandidate = selectedPair
                ? sanitizeCandidate(reports.get(selectedPair.localCandidateId))
                : null;
            const remoteCandidate = selectedPair
                ? sanitizeCandidate(reports.get(selectedPair.remoteCandidateId))
                : null;

            return {
                connectionId,
                connectionState: peer.connection.connectionState,
                iceConnectionState: peer.connection.iceConnectionState,
                signalingState: peer.connection.signalingState,
                usingTurnRelay: localCandidate?.candidateType === "relay",
                selectedCandidatePair: selectedPair ? {
                    state: selectedPair.state,
                    currentRoundTripTime: selectedPair.currentRoundTripTime,
                    availableOutgoingBitrate: selectedPair.availableOutgoingBitrate,
                    bytesSent: selectedPair.bytesSent,
                    bytesReceived: selectedPair.bytesReceived,
                    localCandidate,
                    remoteCandidate
                } : null
            };
        }));

    const audioTrack = localStream?.getAudioTracks()[0];
    const audioSettings = audioTrack?.getSettings();
    const supportedConstraints = navigator.mediaDevices.getSupportedConstraints();

    return JSON.stringify({
        capturedAt: new Date().toISOString(),
        mediaEncryption: {
            passwordEncryption: voiceKey ? "AES-256-CTR" : "disabled",
            webRtcTransportEncryption: "DTLS-SRTP"
        },
        audioQualityMode,
        audioQuality,
        audioMaxBitrate: audioQualityProfiles[audioQuality].maxBitrate,
        audioProcessing: {
            echoCancellation: getConstraintStatus(supportedConstraints, audioSettings, "echoCancellation"),
            noiseSuppression: getConstraintStatus(supportedConstraints, audioSettings, "noiseSuppression"),
            autoGainControl: getConstraintStatus(supportedConstraints, audioSettings, "autoGainControl"),
            voiceIsolation: getConstraintStatus(supportedConstraints, audioSettings, "voiceIsolation")
        },
        mobileCallSupport: {
            nativeAudioRouting,
            screenWakeLockSupported: "wakeLock" in navigator,
            screenWakeLockActive: Boolean(screenWakeLock && !screenWakeLock.released),
            communicationAudioSession: navigator.audioSession?.type ?? "unsupported",
            proximitySensorSupported: "ProximitySensor" in window,
            proximitySensorActive: Boolean(proximitySensor?.activated),
            proximitySensorNear: proximitySensorNear ?? "unknown",
            audioOutputSelectionSupported: supportsAudioOutputSelection(),
            audioOutputMode,
            selectedAudioOutputId: selectedAudioOutputId || "default"
        },
        iceTransportPolicy: peerConfiguration?.iceTransportPolicy,
        configuredIceServers: peerConfiguration?.iceServers.map(server => server.urls),
        peerConnections: peerDiagnostics
    }, null, 2);
}

export function removeParticipant(connectionId) {
    const peer = peers.get(connectionId);
    if (!peer) return;

    peer.connection.close();
    peer.audio.remove();
    peers.delete(connectionId);
}

export async function leave() {
    clearInterval(adaptationTimer);
    adaptationTimer = undefined;
    goodNetworkSamples = 0;
    poorNetworkSamples = 0;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    releaseScreenWakeLock();
    stopProximityRouting();
    setAudioSessionType("auto");
    const nativeAudioRouter = getNativeAudioRouter();
    try {
        await nativeAudioRouter?.reset();
    } catch (error) {
        console.warn("Unable to reset native audio routing", error);
    }
    try {
        if (typeof nativeAudioRouter?.stopCall === "function") {
            await nativeAudioRouter.stopCall();
        }
    } catch (error) {
        console.warn("Unable to stop native background call handling", error);
    }

    for (const connectionId of [...peers.keys()]) {
        removeParticipant(connectionId);
    }

    if (localStream) {
        for (const track of localStream.getTracks()) {
            track.stop();
        }
    }

    localStream = undefined;
    dotNetReference = undefined;
    voiceKey = undefined;
    localConnectionId = undefined;
    selectedAudioOutputId = "";
    audioOutputMode = "auto";
    encryptionWorker?.terminate();
    encryptionWorker = undefined;
}

async function requestScreenWakeLock() {
    if (!("wakeLock" in navigator) || !localStream || document.visibilityState !== "visible" ||
        (screenWakeLock && !screenWakeLock.released)) return;

    try {
        screenWakeLock = await navigator.wakeLock.request("screen");
        screenWakeLock.addEventListener("release", () => {
            screenWakeLock = undefined;
        }, { once: true });
    } catch (error) {
        console.warn("Unable to keep the screen awake during the voice call", error);
    }
}

function releaseScreenWakeLock() {
    const activeWakeLock = screenWakeLock;
    screenWakeLock = undefined;
    activeWakeLock?.release().catch(() => {});
}

function handleVisibilityChange() {
    if (document.visibilityState === "visible" && localStream && !screenWakeLock) {
        requestScreenWakeLock();
    }
}

function setAudioSessionType(type) {
    if (!navigator.audioSession) return false;

    try {
        navigator.audioSession.type = type;
        return navigator.audioSession.type === type;
    } catch (error) {
        console.warn("Unable to configure the mobile audio session", error);
        return false;
    }
}

function applyAudioOutputMode(mode) {
    const sessionType = mode === "speaker"
        ? "playback"
        : mode === "earpiece" ? "play-and-record" : "auto";
    return setAudioSessionType(sessionType);
}

function startProximityRouting() {
    if (!("ProximitySensor" in window) || audioOutputMode !== "auto") return;

    try {
        proximitySensor = new ProximitySensor({ frequency: 5 });
        proximitySensor.onreading = () => {
            if (audioOutputMode !== "auto" || proximitySensor.near === proximitySensorNear) return;

            proximitySensorNear = proximitySensor.near;
            applyAudioOutputMode(proximitySensorNear ? "earpiece" : "speaker");
        };
        proximitySensor.onerror = event => {
            console.warn("Unable to use the proximity sensor for automatic audio routing", event.error);
            stopProximityRouting();
            applyAudioOutputMode("auto");
        };
        proximitySensor.start();
    } catch (error) {
        console.warn("Unable to start proximity-based audio routing", error);
        stopProximityRouting();
        applyAudioOutputMode("auto");
    }
}

function stopProximityRouting() {
    if (proximitySensor) {
        proximitySensor.onreading = null;
        proximitySensor.onerror = null;
        proximitySensor.stop();
    }
    proximitySensor = undefined;
    proximitySensorNear = undefined;
}

async function createPeer(connectionId) {
    const existing = peers.get(connectionId);
    if (existing) return existing;

    const connection = new RTCPeerConnection(peerConfiguration);
    const audioSenders = [];
    for (const track of localStream.getTracks()) {
        const sender = connection.addTrack(track, localStream);
        audioSenders.push(sender);
        sender.transform = new RTCRtpScriptTransform(
            encryptionWorker,
            { operation: "encrypt", key: voiceKey, senderId: localConnectionId });

        const transceiver = connection.getTransceivers()
            .find(candidate => candidate.sender === sender);
        transceiver.receiver.transform = new RTCRtpScriptTransform(
            encryptionWorker,
            { operation: "decrypt", key: voiceKey, senderId: connectionId });
    }

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    if (selectedAudioOutputId && typeof audio.setSinkId === "function") {
        await audio.setSinkId(selectedAudioOutputId);
    }
    remoteAudioContainer.appendChild(audio);

    const peer = { connection, audio, pendingCandidates: [] };
    peers.set(connectionId, peer);

    connection.ontrack = event => {
        audio.srcObject = event.streams[0];
    };

    connection.onicecandidate = event => {
        if (!event.candidate) return;
        dotNetReference.invokeMethodAsync(
            "SendVoiceIceCandidate",
            connectionId,
            JSON.stringify(event.candidate));
    };

    await Promise.all(audioSenders.map(applySenderAudioQuality));
    return peer;
}

async function addPendingCandidates(peer) {
    for (const candidate of peer.pendingCandidates) {
        await peer.connection.addIceCandidate(candidate);
    }
    peer.pendingCandidates.length = 0;
}

function sanitizeCandidate(candidate) {
    if (!candidate) return null;

    return {
        candidateType: candidate.candidateType,
        address: candidate.address,
        port: candidate.port,
        protocol: candidate.protocol,
        relayProtocol: candidate.relayProtocol,
        url: candidate.url,
        networkType: candidate.networkType
    };
}

function normalizeAudioQuality(value) {
    return value in audioQualityProfiles ? value : "standard";
}

function normalizeAudioQualityMode(value) {
    return value === "auto" ? value : normalizeAudioQuality(value);
}

function getAudioConstraints() {
    const constraints = {
        channelCount: 1,
        sampleRate: { ideal: audioQualityProfiles[audioQuality].sampleRate },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true }
    };

    if (navigator.mediaDevices.getSupportedConstraints().voiceIsolation) {
        constraints.voiceIsolation = { ideal: true };
    }

    return constraints;
}

function getConstraintStatus(supportedConstraints, settings, constraintName) {
    return {
        supported: Boolean(supportedConstraints[constraintName]),
        active: settings?.[constraintName] ?? false
    };
}

async function applySenderAudioQuality(sender) {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) {
        parameters.encodings = [{}];
    }
    for (const encoding of parameters.encodings) {
        encoding.maxBitrate = audioQualityProfiles[audioQuality].maxBitrate;
    }
    await sender.setParameters(parameters);
}

function startQualityAdaptation() {
    clearInterval(adaptationTimer);
    adaptationTimer = setInterval(adaptAudioQuality, 5000);
}

async function adaptAudioQuality() {
    if (audioQualityMode !== "auto" || adaptationInProgress || peers.size === 0) return;

    adaptationInProgress = true;
    try {
        const samples = await Promise.all([...peers.values()].map(getNetworkSample));
        const usableSamples = samples.filter(sample => sample !== null);
        if (usableSamples.length === 0) return;

        const networkIsGood = usableSamples.every(sample =>
            (sample.roundTripTime === undefined || sample.roundTripTime <= 0.15) &&
            (sample.fractionLost === undefined || sample.fractionLost <= 0.02) &&
            (sample.availableOutgoingBitrate === undefined || sample.availableOutgoingBitrate >= 128000));
        const networkIsPoor = usableSamples.some(sample =>
            (sample.roundTripTime !== undefined && sample.roundTripTime > 0.3) ||
            (sample.fractionLost !== undefined && sample.fractionLost > 0.05) ||
            (sample.availableOutgoingBitrate !== undefined && sample.availableOutgoingBitrate < 80000));

        goodNetworkSamples = networkIsGood ? goodNetworkSamples + 1 : 0;
        poorNetworkSamples = networkIsPoor ? poorNetworkSamples + 1 : 0;

        if (audioQuality === "standard" && goodNetworkSamples >= 3) {
            goodNetworkSamples = 0;
            await setEffectiveAudioQuality("high");
        } else if (audioQuality === "high" && poorNetworkSamples >= 2) {
            poorNetworkSamples = 0;
            await setEffectiveAudioQuality("standard");
        }
    } catch (error) {
        console.warn("Unable to adapt audio quality", error);
    } finally {
        adaptationInProgress = false;
    }
}

async function getNetworkSample(peer) {
    if (peer.connection.connectionState !== "connected") return null;

    const stats = await peer.connection.getStats();
    let selectedPair;
    let remoteInboundAudio;

    stats.forEach(report => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
            selectedPair = report;
        } else if (report.type === "remote-inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) {
            remoteInboundAudio = report;
        }
    });

    const sample = {
        roundTripTime: remoteInboundAudio?.roundTripTime ?? selectedPair?.currentRoundTripTime,
        fractionLost: remoteInboundAudio?.fractionLost,
        availableOutgoingBitrate: selectedPair?.availableOutgoingBitrate
    };

    return Object.values(sample).some(value => value !== undefined) ? sample : null;
}

function notifyAudioQualityChanged() {
    dotNetReference?.invokeMethodAsync("AudioQualityAdapted", audioQuality).catch(() => {});
}

export async function registerBackgroundCalls(channel, name, password, clientInstanceId) {
    const nativeAudioRouter = getNativeAudioRouter();
    if (typeof nativeAudioRouter?.registerBackground !== "function") return false;

    const result = await nativeAudioRouter.registerBackground({
        serverUrl: new URL("/signalr", window.location.origin).toString(),
        channel,
        name,
        password,
        clientInstanceId
    });
    return result.notificationsEnabled;
}

export async function restoreBackgroundSession() {
    const nativeAudioRouter = getNativeAudioRouter();
    return typeof nativeAudioRouter?.restoreBackgroundSession === "function"
        ? await nativeAudioRouter.restoreBackgroundSession()
        : null;
}

export async function unregisterBackgroundCalls() {
    const nativeAudioRouter = getNativeAudioRouter();
    if (typeof nativeAudioRouter?.unregisterBackground === "function") {
        await nativeAudioRouter.unregisterBackground();
    }
}