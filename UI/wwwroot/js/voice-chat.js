let dotNetReference;
let remoteMediaContainer;
let localVideoElement;
let localStream;
let peerConfiguration;
let encryptionWorker;
let voiceKey;
let localConnectionId;
let audioQuality = "standard";
let audioQualityMode = "auto";
let videoQuality = "standard";
let videoQualityMode = "auto";
let adaptationTimer;
let goodNetworkSamples = 0;
let poorNetworkSamples = 0;
let goodVideoNetworkSamples = 0;
let poorVideoNetworkSamples = 0;
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
const videoQualityProfiles = {
    low: { width: 426, height: 240, frameRate: 15, maxBitrate: 250000 },
    standard: { width: 854, height: 480, frameRate: 24, maxBitrate: 700000 },
    high: { width: 1280, height: 720, frameRate: 30, maxBitrate: 1500000 }
};

export async function initialize(
    reference,
    container,
    localVideo,
    turnCredentials,
    passwordDerivedKey,
    selectedAudioQuality,
    selectedVideoQuality) {
    if (!("RTCRtpScriptTransform" in window)) {
        throw new Error("This browser does not support password-encrypted WebRTC audio");
    }

    dotNetReference = reference;
    remoteMediaContainer = container;
    localVideoElement = localVideo;
    voiceKey = passwordDerivedKey;
    localConnectionId = turnCredentials.username.split(":", 2)[1];
    audioQualityMode = normalizeAudioQualityMode(selectedAudioQuality);
    audioQuality = audioQualityMode === "auto" ? "standard" : audioQualityMode;
    videoQualityMode = normalizeVideoQualityMode(selectedVideoQuality);
    videoQuality = videoQualityMode === "auto" ? "standard" : videoQualityMode;
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
    if ("audioSession" in navigator) {
        setAudioOutputMode("auto");
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    await requestScreenWakeLock();
    startQualityAdaptation();
    notifyAudioQualityChanged();
    notifyVideoQualityChanged();
}

export async function connectToParticipants(connectionIds) {
    for (const connectionId of connectionIds) {
        const peer = await createPeer(connectionId);
        await negotiatePeer(connectionId, peer);
    }
}

export async function receiveOffer(senderConnectionId, offerJson) {
    const peer = await createPeer(senderConnectionId);
    const offer = JSON.parse(offerJson);
    const offerCollision = peer.makingOffer || peer.connection.signalingState !== "stable";
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    if (offerCollision) {
        await peer.connection.setLocalDescription({ type: "rollback" });
    }
    await peer.connection.setRemoteDescription(offer);
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
    if (!peer || peer.connection.signalingState !== "have-local-offer") return;

    await peer.connection.setRemoteDescription(JSON.parse(answerJson));
    await addPendingCandidates(peer);
}

export async function receiveIceCandidate(senderConnectionId, candidateJson) {
    const peer = await createPeer(senderConnectionId);
    if (peer.ignoreOffer) return;
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

export async function setVideoEnabled(enabled) {
    const currentTrack = localStream?.getVideoTracks()
        .find(track => track.readyState === "live");
    if (enabled && currentTrack) return true;

    if (enabled) {
        for (const endedTrack of localStream.getVideoTracks()) {
            localStream.removeTrack(endedTrack);
        }
        const cameraStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: getVideoConstraints()
        });
        const videoTrack = cameraStream.getVideoTracks()[0];
        if (!videoTrack) throw new Error("No camera is available");

        videoTrack.addEventListener("ended", handleLocalVideoEnded, { once: true });
        localStream.addTrack(videoTrack);
        localVideoElement.srcObject = new MediaStream([videoTrack]);
        localVideoElement.hidden = false;

        for (const [connectionId, peer] of peers) {
            const sender = addLocalTrack(peer, videoTrack, connectionId);
            await applySenderVideoQuality(sender);
            await negotiatePeer(connectionId, peer);
        }
        return true;
    }

    if (!currentTrack) return false;
    localStream.removeTrack(currentTrack);
    currentTrack.stop();
    localVideoElement.srcObject = null;
    localVideoElement.hidden = true;

    for (const [connectionId, peer] of peers) {
        const sender = peer.connection.getSenders().find(candidate => candidate.track === currentTrack);
        if (sender) peer.connection.removeTrack(sender);
        await negotiatePeer(connectionId, peer);
    }
    return false;
}

export function supportsAudioOutputSelection() {
    return supportsAudioOutputDevicePicker() || "audioSession" in navigator;
}

export function usesAudioSessionOutputModes() {
    return "audioSession" in navigator;
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

export function setAudioOutputMode(selectedMode) {
    if (!("audioSession" in navigator)) {
        throw new Error("Audio output modes are not supported by this browser");
    }

    const mode = ["auto", "speaker", "earpiece"].includes(selectedMode)
        ? selectedMode
        : "auto";
    stopProximityRouting();
    audioOutputMode = mode;

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
    const videoTrack = localStream?.getVideoTracks()[0];
    const videoSettings = videoTrack?.getSettings();
    const supportedConstraints = navigator.mediaDevices.getSupportedConstraints();

    return JSON.stringify({
        capturedAt: new Date().toISOString(),
        mediaEncryption: {
            passwordEncryption: voiceKey ? "AES-256-CTR" : "disabled",
            webRtcTransportEncryption: "DTLS-SRTP"
        },
        videoEnabled: Boolean(localStream?.getVideoTracks().some(track => track.readyState === "live")),
        videoQualityMode,
        videoQuality,
        videoMaxBitrate: videoQualityProfiles[videoQuality].maxBitrate,
        videoCapture: videoSettings ? {
            width: videoSettings.width,
            height: videoSettings.height,
            frameRate: videoSettings.frameRate,
            facingMode: videoSettings.facingMode
        } : null,
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
    peer.video.remove();
    peers.delete(connectionId);
}

export function leave() {
    clearInterval(adaptationTimer);
    adaptationTimer = undefined;
    goodNetworkSamples = 0;
    poorNetworkSamples = 0;
    goodVideoNetworkSamples = 0;
    poorVideoNetworkSamples = 0;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    releaseScreenWakeLock();
    stopProximityRouting();
    setAudioSessionType("auto");

    for (const connectionId of [...peers.keys()]) {
        removeParticipant(connectionId);
    }

    if (localStream) {
        for (const track of localStream.getTracks()) {
            track.stop();
        }
    }

    localStream = undefined;
    if (localVideoElement) {
        localVideoElement.srcObject = null;
        localVideoElement.hidden = true;
    }
    localVideoElement = undefined;
    remoteMediaContainer = undefined;
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
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    if (selectedAudioOutputId && typeof audio.setSinkId === "function") {
        await audio.setSinkId(selectedAudioOutputId);
    }
    remoteMediaContainer.appendChild(audio);

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.hidden = true;
    video.className = "voice-video voice-video-remote";
    video.setAttribute("aria-label", "Remote participant video");
    remoteMediaContainer.appendChild(video);

    const peer = {
        connection,
        audio,
        video,
        pendingCandidates: [],
        makingOffer: false,
        ignoreOffer: false,
        polite: localConnectionId.localeCompare(connectionId) > 0
    };
    peers.set(connectionId, peer);
    const audioSenders = [];
    const videoSenders = [];
    for (const track of localStream.getTracks()) {
        const sender = addLocalTrack(peer, track, connectionId);
        if (track.kind === "audio") audioSenders.push(sender);
        if (track.kind === "video") videoSenders.push(sender);
    }

    connection.ontrack = event => {
        setReceiverTransform(event.receiver, connectionId, event.track.kind);
        const mediaElement = event.track.kind === "video" ? video : audio;
        const mediaStream = mediaElement.srcObject ?? new MediaStream();
        if (!mediaStream.getTracks().includes(event.track)) {
            mediaStream.addTrack(event.track);
        }
        mediaElement.srcObject = mediaStream;

        if (event.track.kind === "video") {
            const updateVideoVisibility = () => {
                video.hidden = mediaStream.getVideoTracks()
                    .every(track => track.muted || track.readyState === "ended");
            };
            event.track.addEventListener("mute", updateVideoVisibility);
            event.track.addEventListener("unmute", updateVideoVisibility);
            event.track.addEventListener("ended", () => {
                mediaStream.removeTrack(event.track);
                updateVideoVisibility();
            }, { once: true });
            updateVideoVisibility();
        }
    };

    connection.onicecandidate = event => {
        if (!event.candidate) return;
        dotNetReference.invokeMethodAsync(
            "SendVoiceIceCandidate",
            connectionId,
            JSON.stringify(event.candidate));
    };

    await Promise.all([
        ...audioSenders.map(applySenderAudioQuality),
        ...videoSenders.map(applySenderVideoQuality)
    ]);
    return peer;
}

function addLocalTrack(peer, track, remoteConnectionId) {
    const sender = peer.connection.addTrack(track, localStream);
    sender.transform = new RTCRtpScriptTransform(
        encryptionWorker,
        { operation: "encrypt", key: voiceKey, senderId: localConnectionId, mediaKind: track.kind });

    const transceiver = peer.connection.getTransceivers()
        .find(candidate => candidate.sender === sender);
    setReceiverTransform(transceiver.receiver, remoteConnectionId, track.kind);
    return sender;
}

function setReceiverTransform(receiver, senderId, mediaKind) {
    if (receiver.transform) return;
    receiver.transform = new RTCRtpScriptTransform(
        encryptionWorker,
        { operation: "decrypt", key: voiceKey, senderId, mediaKind });
}

async function negotiatePeer(connectionId, peer) {
    try {
        peer.makingOffer = true;
        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        await dotNetReference.invokeMethodAsync(
            "SendVoiceOffer",
            connectionId,
            JSON.stringify(peer.connection.localDescription));
    } finally {
        peer.makingOffer = false;
    }
}

async function handleLocalVideoEnded(event) {
    const endedTrack = event.target;
    localStream?.removeTrack(endedTrack);
    if (localVideoElement) {
        localVideoElement.srcObject = null;
        localVideoElement.hidden = true;
    }

    try {
        for (const [connectionId, peer] of peers) {
            const sender = peer.connection.getSenders().find(candidate => candidate.track === endedTrack);
            if (sender) peer.connection.removeTrack(sender);
            await negotiatePeer(connectionId, peer);
        }
    } catch (error) {
        console.warn("Unable to renegotiate after the camera stopped", error);
    }
    dotNetReference?.invokeMethodAsync("VideoStopped").catch(() => {});
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

function normalizeVideoQuality(value) {
    return value in videoQualityProfiles ? value : "standard";
}

function normalizeVideoQualityMode(value) {
    return value === "auto" ? value : normalizeVideoQuality(value);
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

function getVideoConstraints() {
    const profile = videoQualityProfiles[videoQuality];
    return {
        width: { ideal: profile.width, max: profile.width },
        height: { ideal: profile.height, max: profile.height },
        frameRate: { ideal: profile.frameRate, max: profile.frameRate },
        facingMode: "user"
    };
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

async function applySenderVideoQuality(sender) {
    const profile = videoQualityProfiles[videoQuality];
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) {
        parameters.encodings = [{}];
    }
    for (const encoding of parameters.encodings) {
        encoding.maxBitrate = profile.maxBitrate;
        encoding.maxFramerate = profile.frameRate;
    }
    await sender.setParameters(parameters);
}

function startQualityAdaptation() {
    clearInterval(adaptationTimer);
    adaptationTimer = setInterval(adaptMediaQuality, 5000);
}

async function adaptMediaQuality() {
    if ((audioQualityMode !== "auto" && videoQualityMode !== "auto") ||
        adaptationInProgress || peers.size === 0) return;

    adaptationInProgress = true;
    try {
        const samples = await Promise.all([...peers.values()].map(getNetworkSample));
        const usableSamples = samples.filter(sample => sample !== null);
        if (usableSamples.length === 0) return;

        const audioNetworkIsGood = usableSamples.every(sample =>
            (sample.roundTripTime === undefined || sample.roundTripTime <= 0.15) &&
            (sample.fractionLost === undefined || sample.fractionLost <= 0.02) &&
            (sample.availableOutgoingBitrate === undefined || sample.availableOutgoingBitrate >= 128000));
        const audioNetworkIsPoor = usableSamples.some(sample =>
            (sample.roundTripTime !== undefined && sample.roundTripTime > 0.3) ||
            (sample.fractionLost !== undefined && sample.fractionLost > 0.05) ||
            (sample.availableOutgoingBitrate !== undefined && sample.availableOutgoingBitrate < 80000));

        goodNetworkSamples = audioQualityMode === "auto" && audioNetworkIsGood ? goodNetworkSamples + 1 : 0;
        poorNetworkSamples = audioQualityMode === "auto" && audioNetworkIsPoor ? poorNetworkSamples + 1 : 0;

        if (audioQuality === "standard" && goodNetworkSamples >= 3) {
            goodNetworkSamples = 0;
            await setEffectiveAudioQuality("high");
        } else if (audioQuality === "high" && poorNetworkSamples >= 2) {
            poorNetworkSamples = 0;
            await setEffectiveAudioQuality("standard");
        }

        const videoActive = localStream?.getVideoTracks().some(track => track.readyState === "live");
        const improvementBitrate = videoQuality === "low" ? 800000 : 1500000;
        const degradationBitrate = videoQuality === "high" ? 1000000 : 450000;
        const videoNetworkCanImprove = usableSamples.every(sample =>
            (sample.roundTripTime === undefined || sample.roundTripTime <= 0.2) &&
            ((sample.videoFractionLost ?? sample.fractionLost) === undefined ||
                (sample.videoFractionLost ?? sample.fractionLost) <= 0.03) &&
            (sample.availableOutgoingBitrate === undefined || sample.availableOutgoingBitrate >= improvementBitrate));
        const videoNetworkIsPoor = usableSamples.some(sample =>
            (sample.roundTripTime !== undefined && sample.roundTripTime > 0.35) ||
            (sample.videoFractionLost ?? sample.fractionLost) > 0.06 ||
            (sample.availableOutgoingBitrate !== undefined && sample.availableOutgoingBitrate < degradationBitrate));

        goodVideoNetworkSamples = videoQualityMode === "auto" && videoActive && videoNetworkCanImprove
            ? goodVideoNetworkSamples + 1
            : 0;
        poorVideoNetworkSamples = videoQualityMode === "auto" && videoActive && videoNetworkIsPoor
            ? poorVideoNetworkSamples + 1
            : 0;

        if (videoQuality === "low" && goodVideoNetworkSamples >= 3) {
            goodVideoNetworkSamples = 0;
            await setEffectiveVideoQuality("standard");
        } else if (videoQuality === "standard" && goodVideoNetworkSamples >= 3) {
            goodVideoNetworkSamples = 0;
            await setEffectiveVideoQuality("high");
        } else if (videoQuality === "high" && poorVideoNetworkSamples >= 2) {
            poorVideoNetworkSamples = 0;
            await setEffectiveVideoQuality("standard");
        } else if (videoQuality === "standard" && poorVideoNetworkSamples >= 2) {
            poorVideoNetworkSamples = 0;
            await setEffectiveVideoQuality("low");
        }
    } catch (error) {
        console.warn("Unable to adapt media quality", error);
    } finally {
        adaptationInProgress = false;
    }
}

async function getNetworkSample(peer) {
    if (peer.connection.connectionState !== "connected") return null;

    const stats = await peer.connection.getStats();
    let selectedPair;
    let remoteInboundAudio;
    let remoteInboundVideo;

    stats.forEach(report => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
            selectedPair = report;
        } else if (report.type === "remote-inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) {
            remoteInboundAudio = report;
        } else if (report.type === "remote-inbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
            remoteInboundVideo = report;
        }
    });

    const sample = {
        roundTripTime: remoteInboundAudio?.roundTripTime ?? remoteInboundVideo?.roundTripTime ?? selectedPair?.currentRoundTripTime,
        fractionLost: remoteInboundAudio?.fractionLost,
        videoFractionLost: remoteInboundVideo?.fractionLost,
        availableOutgoingBitrate: selectedPair?.availableOutgoingBitrate
    };

    return Object.values(sample).some(value => value !== undefined) ? sample : null;
}

function notifyAudioQualityChanged() {
    dotNetReference?.invokeMethodAsync("AudioQualityAdapted", audioQuality).catch(() => {});
}

export async function setVideoQuality(selectedVideoQuality) {
    videoQualityMode = normalizeVideoQualityMode(selectedVideoQuality);
    goodVideoNetworkSamples = 0;
    poorVideoNetworkSamples = 0;
    await setEffectiveVideoQuality(videoQualityMode === "auto" ? "standard" : videoQualityMode);
    return videoQuality;
}

async function setEffectiveVideoQuality(selectedVideoQuality) {
    const normalizedQuality = normalizeVideoQuality(selectedVideoQuality);
    const qualityChanged = videoQuality !== normalizedQuality;
    videoQuality = normalizedQuality;

    if (localStream) {
        const constraintResults = await Promise.allSettled(localStream.getVideoTracks()
            .map(track => track.applyConstraints(getVideoConstraints())));
        for (const result of constraintResults) {
            if (result.status === "rejected") {
                console.warn("Unable to change camera capture quality without restarting the track", result.reason);
            }
        }
    }

    const senderResults = await Promise.allSettled([...peers.values()]
        .flatMap(peer => peer.connection.getSenders())
        .filter(sender => sender.track?.kind === "video")
        .map(applySenderVideoQuality));
    const senderFailure = senderResults.find(result => result.status === "rejected");
    if (senderFailure) {
        throw senderFailure.reason;
    }

    if (qualityChanged) {
        notifyVideoQualityChanged();
    }
}

function notifyVideoQualityChanged() {
    dotNetReference?.invokeMethodAsync("VideoQualityAdapted", videoQuality).catch(() => {});
}