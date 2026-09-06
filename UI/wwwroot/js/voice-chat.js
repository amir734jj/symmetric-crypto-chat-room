let dotNetReference;
let remoteMediaContainer;
let localVideoElement;
let focusedVideoTile;
let localStream;
let localAudioPromise;
let localAudioRequestId = 0;
let audioMuted = false;
let cameraTrack;
let screenTrack;
let restoreCameraAfterScreenShare = false;
let screenShareStarting = false;
let peerConfiguration;
let encryptionWorker;
let voiceKey;
let mediaKeyConfirmation;
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
let transcriptionWorker;
let transcriptionContext;
let transcriptionProcessor;
let transcriptionSink;
let transcriptionEnabled = false;
let transcriptionBusy = false;
let transcriptionSamples = [];
let transcriptionSampleCount = 0;
const peers = new Map();
const liveDataRateSamples = new Map();
const transcriptionSources = new Map();
const transcriptionSampleRate = 16000;
const transcriptionWindowSamples = transcriptionSampleRate * 6;
const transcriptionModels = new Set([
    "tiny",
    "base",
    "small",
    "tiny-en",
    "base-en",
    "small-en"
]);
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
    mediaKeyConfirmation = await createMediaKeyConfirmation(passwordDerivedKey);
    localConnectionId = turnCredentials.username.split(":", 2)[1];
    audioQualityMode = normalizeAudioQualityMode(selectedAudioQuality);
    audioQuality = audioQualityMode === "auto" ? "standard" : audioQualityMode;
    videoQualityMode = normalizeVideoQualityMode(selectedVideoQuality);
    videoQuality = videoQualityMode === "auto" ? "standard" : videoQualityMode;
    encryptionWorker = new Worker(
        new URL("./voice-crypto-worker.js?version=vp8-payload-descriptor-v2", import.meta.url),
        { type: "module" });

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

    localStream = new MediaStream();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    await requestScreenWakeLock();
    startQualityAdaptation();
    notifyAudioQualityChanged();
    notifyVideoQualityChanged();
}

async function createMediaKeyConfirmation(base64Key) {
    const keyBytes = Uint8Array.from(atob(base64Key), character => character.charCodeAt(0));
    const confirmationKey = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]);
    const signature = await crypto.subtle.sign(
        "HMAC",
        confirmationKey,
        new TextEncoder().encode("symmetric-crypto-chat-room/media-key/v1"));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function serializeSessionDescription(description) {
    return JSON.stringify({ description, mediaKeyConfirmation });
}

function parseSessionDescription(messageJson) {
    const message = JSON.parse(messageJson);
    if (message.error === "mediaKeyMismatch") {
        throw new Error("Cannot join the media bridge because the participants are using different passwords");
    }
    if (!message.mediaKeyConfirmation || message.mediaKeyConfirmation !== mediaKeyConfirmation) {
        throw new Error("Cannot join the media bridge because the participants are using different passwords");
    }
    if (!message.description?.type || !message.description?.sdp) {
        throw new Error("The media bridge received an invalid session description");
    }
    return message.description;
}

export async function connectToParticipants(participants) {
    if (participants.length > 0) await ensureLocalAudio();

    for (const participant of participants) {
        const peer = await createPeer(participant.connectionId, participant.name);
        await negotiatePeer(participant.connectionId, peer);
    }
}

export async function receiveOffer(senderConnectionId, senderName, offerJson) {
    let offer;
    try {
        offer = parseSessionDescription(offerJson);
    } catch (error) {
        await dotNetReference.invokeMethodAsync(
            "SendVoiceAnswer",
            senderConnectionId,
            JSON.stringify({ error: "mediaKeyMismatch" }));
        throw error;
    }

    await ensureLocalAudio();

    const peer = await createPeer(senderConnectionId, senderName);
    await ensurePeerAudioSender(peer, senderConnectionId);
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
        serializeSessionDescription(peer.connection.localDescription));
}

export async function receiveAnswer(senderConnectionId, answerJson) {
    const peer = peers.get(senderConnectionId);
    if (!peer || peer.connection.signalingState !== "have-local-offer") return;

    await peer.connection.setRemoteDescription(parseSessionDescription(answerJson));
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
    audioMuted = muted;
    if (!localStream) return;
    for (const track of localStream.getAudioTracks()) {
        track.enabled = !muted;
    }
}

export function supportsScreenSharing() {
    return typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

async function ensureLocalAudio() {
    if (!localStream) throw new Error("Join the media bridge before connecting audio");
    const liveTrack = localStream.getAudioTracks().find(track => track.readyState === "live");
    if (liveTrack) return liveTrack;
    if (localAudioPromise) return localAudioPromise;

    const targetStream = localStream;
    const requestId = ++localAudioRequestId;
    const pendingAudio = navigator.mediaDevices.getUserMedia({
        audio: getAudioConstraints(),
        video: false
    }).then(stream => {
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) throw new Error("No microphone is available");
        if (localStream !== targetStream || requestId !== localAudioRequestId) {
            stream.getTracks().forEach(track => track.stop());
            throw new Error("The participant left before audio connected");
        }

        audioTrack.enabled = !audioMuted;
        targetStream.addTrack(audioTrack);
        if ("audioSession" in navigator) setAudioOutputMode("auto");
        if (transcriptionEnabled) {
            disconnectTranscriptionStream("local");
            connectTranscriptionStream("local", targetStream);
        }
        return audioTrack;
    }).finally(() => {
        if (localAudioPromise === pendingAudio) localAudioPromise = undefined;
    });
    localAudioPromise = pendingAudio;
    return pendingAudio;
}

function stopLocalAudioIfAlone() {
    if (!localStream || peers.size > 0) return;

    if (transcriptionEnabled) {
        stopTranscription();
        dotNetReference?.invokeMethodAsync(
            "TranscriptionStopped",
            "Transcription stopped because no other participant is connected.").catch(() => {});
    }
    localAudioRequestId++;
    disconnectTranscriptionStream("local");
    for (const track of localStream.getAudioTracks()) {
        localStream.removeTrack(track);
        track.stop();
    }
    stopProximityRouting();
    setAudioSessionType("auto");
}

export async function setVideoEnabled(enabled) {
    if (!localStream || !localVideoElement) {
        throw new Error("Join the media bridge before changing the camera");
    }
    if (screenShareStarting || screenTrack?.readyState === "live") {
        throw new Error("Stop screen sharing before changing the camera");
    }

    const currentTrack = cameraTrack?.readyState === "live" ? cameraTrack : null;
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

        cameraTrack = videoTrack;
        videoTrack.addEventListener("ended", handleLocalVideoEnded, { once: true });
        await showLocalVideo(videoTrack, true);
        localStream.addTrack(videoTrack);

        for (const [connectionId, peer] of peers) {
            const sender = addLocalTrack(peer, videoTrack, connectionId);
            await applySenderVideoQuality(sender);
            await negotiatePeer(connectionId, peer);
        }
        return true;
    }

    if (!currentTrack) return false;
    localStream.removeTrack(currentTrack);
    cameraTrack = undefined;
    currentTrack.stop();
    clearVideoFocusForElement(localVideoElement);
    localVideoElement.srcObject = null;
    localVideoElement.hidden = true;

    for (const [connectionId, peer] of peers) {
        const sender = peer.connection.getSenders().find(candidate => candidate.track === currentTrack);
        if (sender) peer.connection.removeTrack(sender);
        await negotiatePeer(connectionId, peer);
    }
    return false;
}

export async function setScreenSharing(enabled) {
    if (!localStream || !localVideoElement) {
        throw new Error("Join the media bridge before sharing a screen");
    }

    if (enabled) {
        if (screenTrack?.readyState === "live") return true;
        if (screenShareStarting) throw new Error("Screen sharing is already starting");
        if (!supportsScreenSharing()) {
            throw new Error("Screen sharing is not supported by this browser");
        }

        screenShareStarting = true;
        try {
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                audio: false,
                video: { frameRate: { ideal: 15, max: 30 } }
            });
            const displayTrack = displayStream.getVideoTracks()[0];
            if (!displayTrack) throw new Error("No screen was selected");
            if (!localStream || !localVideoElement) {
                displayTrack.stop();
                throw new Error("The media bridge was left before screen sharing started");
            }

            await showLocalVideo(displayTrack, false);
            restoreCameraAfterScreenShare = cameraTrack?.readyState === "live";
            if (restoreCameraAfterScreenShare) localStream.removeTrack(cameraTrack);
            screenTrack = displayTrack;
            localStream.addTrack(displayTrack);
            displayTrack.addEventListener("ended", handleScreenShareEnded, { once: true });

            for (const [connectionId, peer] of peers) {
                try {
                    const sender = peer.connection.getSenders().find(candidate => candidate.track?.kind === "video");
                    if (sender) {
                        await sender.replaceTrack(displayTrack);
                        await applySenderVideoQuality(sender);
                    } else {
                        const newSender = addLocalTrack(peer, displayTrack, connectionId);
                        await applySenderVideoQuality(newSender);
                        await negotiatePeer(connectionId, peer);
                    }
                } catch (error) {
                    console.warn(`Unable to share the screen with peer ${connectionId}`, error);
                }
            }
            return true;
        } finally {
            screenShareStarting = false;
        }
    }

    await stopScreenSharing();
    return false;
}

async function stopScreenSharing(notifyBrowserStop = false) {
    const stoppedTrack = screenTrack;
    if (!stoppedTrack) return;

    screenTrack = undefined;
    localStream?.removeTrack(stoppedTrack);
    if (stoppedTrack.readyState === "live") stoppedTrack.stop();

    const restoredCamera = restoreCameraAfterScreenShare && cameraTrack?.readyState === "live"
        ? cameraTrack
        : null;
    restoreCameraAfterScreenShare = false;
    if (restoredCamera) {
        try {
            await restoredCamera.applyConstraints(getVideoConstraints());
        } catch (error) {
            console.warn("Unable to apply the selected camera quality after screen sharing", error);
        }
        localStream.addTrack(restoredCamera);
        await showLocalVideo(restoredCamera, true);
    } else if (localVideoElement) {
        clearVideoFocusForElement(localVideoElement);
        localVideoElement.srcObject = null;
        localVideoElement.hidden = true;
    }

    for (const [connectionId, peer] of peers) {
        try {
            const sender = peer.connection.getSenders().find(candidate => candidate.track === stoppedTrack);
            if (!sender) continue;

            if (restoredCamera) {
                await sender.replaceTrack(restoredCamera);
                await applySenderVideoQuality(sender);
            } else {
                peer.connection.removeTrack(sender);
                await negotiatePeer(connectionId, peer);
            }
        } catch (error) {
            console.warn(`Unable to restore video for peer ${connectionId}`, error);
        }
    }

    if (notifyBrowserStop) {
        dotNetReference?.invokeMethodAsync("ScreenSharingStopped", Boolean(restoredCamera)).catch(() => {});
    }
}

async function showLocalVideo(videoTrack, mirrored) {
    localVideoElement.autoplay = true;
    localVideoElement.defaultMuted = true;
    localVideoElement.muted = true;
    localVideoElement.playsInline = true;
    localVideoElement.classList.toggle("voice-video-local", mirrored);
    localVideoElement.srcObject = new MediaStream([videoTrack]);
    localVideoElement.hidden = false;

    try {
        await localVideoElement.play();
    } catch (error) {
        clearVideoFocusForElement(localVideoElement);
        localVideoElement.srcObject = null;
        localVideoElement.hidden = true;
        videoTrack.stop();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to start the camera preview: ${message}`);
    }
}

export function toggleVideoFocus(tile) {
    if (!tile || tile.hidden) return;

    setFocusedVideoTile(focusedVideoTile === tile ? undefined : tile);
}

function setFocusedVideoTile(tile) {
    if (focusedVideoTile) {
        focusedVideoTile.classList.remove("voice-video-focused");
        updateFocusButton(focusedVideoTile, false);
    }

    focusedVideoTile = tile;
    if (focusedVideoTile) {
        focusedVideoTile.classList.add("voice-video-focused");
        updateFocusButton(focusedVideoTile, true);
        focusedVideoTile.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
}

function updateFocusButton(tile, focused) {
    const button = tile.querySelector(".voice-video-focus");
    if (!button) return;

    button.title = focused ? "Restore video size" : "Focus video";
    button.setAttribute("aria-label", focused ? "Restore video size" : "Focus video");
    button.setAttribute("aria-pressed", String(focused));
}

function clearVideoFocusForElement(video) {
    const tile = video?.closest(".voice-video-tile");
    if (focusedVideoTile === tile) setFocusedVideoTile(undefined);
}

export function supportsAudioOutputSelection() {
    return supportsAudioOutputDevicePicker() || "audioSession" in navigator;
}

export function usesAudioSessionOutputModes() {
    return "audioSession" in navigator;
}

export function supportsLiveTranscription() {
    return Boolean(window.AudioContext || window.webkitAudioContext) && "Worker" in window;
}

export function getRecommendedTranscriptionModel() {
    const memory = Number(navigator.deviceMemory) || 0;
    const processorCount = Number(navigator.hardwareConcurrency) || 0;
    const mobile = navigator.userAgentData?.mobile === true ||
        window.matchMedia?.("(pointer: coarse)").matches === true;

    if (mobile || (memory > 0 && memory <= 4) || (processorCount > 0 && processorCount <= 4)) {
        return "tiny";
    }
    if (memory >= 8 && processorCount >= 12) return "small";
    if (memory >= 8 && processorCount >= 6) return "base";
    return "tiny";
}

export async function setTranscriptionEnabled(enabled, selectedModel = "auto") {
    if (enabled) {
        if (transcriptionEnabled) return true;
        if (!localStream?.getAudioTracks().some(track => track.readyState === "live")) {
            throw new Error("Connect to another participant before starting transcription");
        }
        if (!supportsLiveTranscription()) {
            throw new Error("Live transcription is not supported by this browser");
        }

        transcriptionEnabled = true;
        transcriptionWorker = new Worker(
            new URL("./transcription-worker.js?version=whisper-model-selector-v2", import.meta.url),
            { type: "module" });
        transcriptionWorker.onmessage = handleTranscriptionWorkerMessage;
        transcriptionWorker.onerror = event => {
            notifyTranscriptionStatus(`Transcription stopped: ${event.message || "worker error"}`, true);
            stopTranscription();
        };
        transcriptionWorker.postMessage({
            type: "initialize",
            model: normalizeTranscriptionModel(selectedModel)
        });

        const AudioContextType = window.AudioContext || window.webkitAudioContext;
        transcriptionContext = new AudioContextType();
        await transcriptionContext.resume();
        transcriptionProcessor = transcriptionContext.createScriptProcessor(4096, 1, 1);
        transcriptionProcessor.onaudioprocess = collectTranscriptionAudio;
        transcriptionSink = transcriptionContext.createGain();
        transcriptionSink.gain.value = 0;
        transcriptionProcessor.connect(transcriptionSink);
        transcriptionSink.connect(transcriptionContext.destination);

        connectTranscriptionStream("local", localStream);
        for (const [connectionId, peer] of peers) {
            if (peer.audio.srcObject) connectTranscriptionStream(connectionId, peer.audio.srcObject);
        }
        notifyTranscriptionStatus("Preparing on-device transcription model...", false);
        return true;
    }

    stopTranscription();
    return false;
}

function connectTranscriptionStream(id, stream) {
    if (!transcriptionEnabled || !transcriptionContext || !transcriptionProcessor ||
        transcriptionSources.has(id) || stream.getAudioTracks().length === 0) return;

    const source = transcriptionContext.createMediaStreamSource(stream);
    source.connect(transcriptionProcessor);
    transcriptionSources.set(id, source);
}

function disconnectTranscriptionStream(id) {
    transcriptionSources.get(id)?.disconnect();
    transcriptionSources.delete(id);
}

function collectTranscriptionAudio(event) {
    if (!transcriptionEnabled) return;

    const samples = resampleAudio(
        event.inputBuffer.getChannelData(0),
        event.inputBuffer.sampleRate,
        transcriptionSampleRate);
    transcriptionSamples.push(samples);
    transcriptionSampleCount += samples.length;
    if (!transcriptionBusy && transcriptionSampleCount >= transcriptionWindowSamples) {
        sendTranscriptionWindow();
    }

    const maximumBufferedSamples = transcriptionWindowSamples * 2;
    while (transcriptionSampleCount > maximumBufferedSamples && transcriptionSamples.length > 1) {
        transcriptionSampleCount -= transcriptionSamples.shift().length;
    }
}

function sendTranscriptionWindow() {
    if (!transcriptionWorker || transcriptionBusy || transcriptionSampleCount === 0) return;

    const audio = new Float32Array(transcriptionSampleCount);
    let offset = 0;
    for (const samples of transcriptionSamples) {
        audio.set(samples, offset);
        offset += samples.length;
    }
    transcriptionSamples = [];
    transcriptionSampleCount = 0;
    const rootMeanSquare = Math.sqrt(
        audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
    if (rootMeanSquare < 0.005) return;

    transcriptionBusy = true;
    transcriptionWorker.postMessage({ type: "transcribe", audio }, [audio.buffer]);
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

function handleTranscriptionWorkerMessage(event) {
    if (!transcriptionEnabled) return;

    const message = event.data;
    if (message?.type === "result") {
        transcriptionBusy = false;
        if (message.text) {
            dotNetReference?.invokeMethodAsync("TranscriptionTextReceived", message.text).catch(() => {});
        }
        if (transcriptionSampleCount >= transcriptionWindowSamples) sendTranscriptionWindow();
    } else if (message?.type === "status") {
        notifyTranscriptionStatus(message.message, false);
    } else if (message?.type === "error") {
        transcriptionBusy = false;
        notifyTranscriptionStatus(`Transcription stopped: ${message.message}`, true);
        stopTranscription();
    }
}

function notifyTranscriptionStatus(message, failed) {
    dotNetReference?.invokeMethodAsync("TranscriptionStatusChanged", message, failed).catch(() => {});
}

function stopTranscription() {
    transcriptionEnabled = false;
    transcriptionBusy = false;
    transcriptionSamples = [];
    transcriptionSampleCount = 0;
    for (const source of transcriptionSources.values()) source.disconnect();
    transcriptionSources.clear();
    if (transcriptionProcessor) {
        transcriptionProcessor.onaudioprocess = null;
        transcriptionProcessor.disconnect();
    }
    transcriptionSink?.disconnect();
    transcriptionContext?.close().catch(() => {});
    transcriptionWorker?.terminate();
    transcriptionProcessor = undefined;
    transcriptionSink = undefined;
    transcriptionContext = undefined;
    transcriptionWorker = undefined;
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
            const initialStats = await peer.connection.getStats();
            const initialPair = getSelectedCandidatePair(initialStats).selectedPair;
            await delay(500);

            const stats = await peer.connection.getStats();
            const { selectedPair, reports } = getSelectedCandidatePair(stats);
            let inboundVideo;
            let outboundVideo;
            stats.forEach(report => {
                const mediaKind = report.kind ?? report.mediaType;
                if (report.type === "inbound-rtp" && mediaKind === "video") inboundVideo = report;
                if (report.type === "outbound-rtp" && mediaKind === "video") outboundVideo = report;
            });

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
                currentDataRateMbps: calculateDataRateMbps(initialPair, selectedPair),
                inboundVideo: sanitizeVideoStats(inboundVideo, reports),
                outboundVideo: sanitizeVideoStats(outboundVideo, reports),
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
        currentDataRateMbps: aggregateDataRates(peerDiagnostics),
        videoEnabled: Boolean(localStream?.getVideoTracks().some(track => track.readyState === "live")),
        screenSharing: Boolean(screenTrack?.readyState === "live"),
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

function sanitizeVideoStats(report, reports) {
    if (!report) return null;

    return {
        codec: reports.get(report.codecId)?.mimeType,
        packetsReceived: report.packetsReceived,
        packetsSent: report.packetsSent,
        packetsLost: report.packetsLost,
        retransmittedPacketsSent: report.retransmittedPacketsSent,
        framesDecoded: report.framesDecoded,
        framesEncoded: report.framesEncoded,
        framesDropped: report.framesDropped,
        keyFramesDecoded: report.keyFramesDecoded,
        keyFramesEncoded: report.keyFramesEncoded,
        nackCount: report.nackCount,
        pliCount: report.pliCount,
        firCount: report.firCount,
        freezeCount: report.freezeCount,
        jitter: report.jitter,
        qualityLimitationReason: report.qualityLimitationReason
    };
}

export async function getLiveDataRateMbps() {
    const rates = await Promise.all([...peers.entries()].map(async ([connectionId, peer]) => {
        const stats = await peer.connection.getStats();
        const currentPair = getSelectedCandidatePair(stats).selectedPair;
        const previousPair = liveDataRateSamples.get(connectionId);
        liveDataRateSamples.set(connectionId, currentPair);
        return calculateDataRateMbps(previousPair, currentPair);
    }));

    const measuredRates = rates.filter(rate => rate !== null);
    if (measuredRates.length === 0) return null;

    const sendMbps = measuredRates.reduce((total, rate) => total + rate.sendMbps, 0);
    const receiveMbps = measuredRates.reduce((total, rate) => total + rate.receiveMbps, 0);
    return [roundMbps(sendMbps), roundMbps(receiveMbps), roundMbps(sendMbps + receiveMbps)];
}

function getSelectedCandidatePair(stats) {
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

    return { selectedPair, reports };
}

function calculateDataRateMbps(initialPair, currentPair) {
    if (!initialPair || !currentPair || initialPair.id !== currentPair.id) return null;
    if (initialPair.bytesSent === undefined || currentPair.bytesSent === undefined ||
        initialPair.bytesReceived === undefined || currentPair.bytesReceived === undefined) return null;

    const elapsedSeconds = (currentPair.timestamp - initialPair.timestamp) / 1000;
    if (elapsedSeconds <= 0 || elapsedSeconds > 2.5) return null;

    const sendMbps = Math.max(0, currentPair.bytesSent - initialPair.bytesSent) * 8 / elapsedSeconds / 1000000;
    const receiveMbps = Math.max(0, currentPair.bytesReceived - initialPair.bytesReceived) * 8 / elapsedSeconds / 1000000;
    return {
        sampledOverMilliseconds: Math.round(elapsedSeconds * 1000),
        sendMbps: roundMbps(sendMbps),
        receiveMbps: roundMbps(receiveMbps),
        totalMbps: roundMbps(sendMbps + receiveMbps)
    };
}

function aggregateDataRates(peerDiagnostics) {
    const measuredRates = peerDiagnostics
        .map(peer => peer.currentDataRateMbps)
        .filter(rate => rate !== null);
    if (measuredRates.length === 0) return null;

    const sendMbps = measuredRates.reduce((total, rate) => total + rate.sendMbps, 0);
    const receiveMbps = measuredRates.reduce((total, rate) => total + rate.receiveMbps, 0);
    return {
        sendMbps: roundMbps(sendMbps),
        receiveMbps: roundMbps(receiveMbps),
        totalMbps: roundMbps(sendMbps + receiveMbps)
    };
}

function roundMbps(value) {
    return Math.round(value * 1000) / 1000;
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function removeParticipant(connectionId) {
    const peer = peers.get(connectionId);
    if (!peer) {
        stopLocalAudioIfAlone();
        return;
    }

    if (focusedVideoTile === peer.tile) setFocusedVideoTile(undefined);
    peer.connection.close();
    disconnectTranscriptionStream(connectionId);
    peer.audio.remove();
    peer.tile.remove();
    liveDataRateSamples.delete(connectionId);
    peers.delete(connectionId);
    stopLocalAudioIfAlone();
}

export function leave() {
    setFocusedVideoTile(undefined);
    stopTranscription();
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
    if (cameraTrack && !localStream?.getTracks().includes(cameraTrack)) cameraTrack.stop();
    if (screenTrack && !localStream?.getTracks().includes(screenTrack)) screenTrack.stop();

    localStream = undefined;
    localAudioPromise = undefined;
    localAudioRequestId++;
    audioMuted = false;
    cameraTrack = undefined;
    screenTrack = undefined;
    restoreCameraAfterScreenShare = false;
    screenShareStarting = false;
    if (localVideoElement) {
        clearVideoFocusForElement(localVideoElement);
        localVideoElement.srcObject = null;
        localVideoElement.hidden = true;
    }
    localVideoElement = undefined;
    remoteMediaContainer = undefined;
    dotNetReference = undefined;
    voiceKey = undefined;
    mediaKeyConfirmation = undefined;
    localConnectionId = undefined;
    selectedAudioOutputId = "";
    audioOutputMode = "auto";
    liveDataRateSamples.clear();
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

async function createPeer(connectionId, participantName) {
    const existing = peers.get(connectionId);
    if (existing) {
        if (participantName) existing.caption.textContent = participantName;
        return existing;
    }

    const connection = new RTCPeerConnection(peerConfiguration);
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    if (selectedAudioOutputId && typeof audio.setSinkId === "function") {
        await audio.setSinkId(selectedAudioOutputId);
    }
    remoteMediaContainer.appendChild(audio);

    const tile = document.createElement("figure");
    tile.className = "voice-video-tile";
    tile.hidden = true;

    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.className = "voice-video-focus";
    focusButton.title = "Focus video";
    focusButton.setAttribute("aria-label", `Focus ${participantName || "participant"} video`);
    focusButton.setAttribute("aria-pressed", "false");
    focusButton.innerHTML = "<span aria-hidden=\"true\">&#x26F6;</span>";
    focusButton.addEventListener("click", () => toggleVideoFocus(tile));
    tile.appendChild(focusButton);

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.className = "voice-video voice-video-remote";
    video.setAttribute("aria-label", `${participantName || "Remote participant"} camera`);
    tile.appendChild(video);

    const caption = document.createElement("figcaption");
    caption.textContent = participantName || "Participant";
    tile.appendChild(caption);
    remoteMediaContainer.appendChild(tile);

    const peer = {
        connection,
        audio,
        video,
        tile,
        caption,
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

        if (event.track.kind === "audio") {
            connectTranscriptionStream(connectionId, mediaStream);
        }

        if (event.track.kind === "video") {
            mediaElement.play().catch(error => {
                console.warn("Unable to start remote video playback", error);
            });
            const updateVideoVisibility = () => {
                tile.hidden = mediaStream.getVideoTracks()
                    .every(track => track.muted || track.readyState === "ended");
                if (tile.hidden && focusedVideoTile === tile) setFocusedVideoTile(undefined);
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
        {
            operation: "encrypt",
            key: voiceKey,
            senderId: localConnectionId,
            mediaKind: track.kind,
            contextId: remoteConnectionId
        });

    const transceiver = peer.connection.getTransceivers()
        .find(candidate => candidate.sender === sender);
    if (track.kind === "video") {
        preferVp8(transceiver);
    }
    setReceiverTransform(transceiver.receiver, remoteConnectionId, track.kind);
    return sender;
}

async function ensurePeerAudioSender(peer, remoteConnectionId) {
    const audioTrack = localStream?.getAudioTracks().find(track => track.readyState === "live");
    if (!audioTrack || peer.connection.getSenders().some(sender => sender.track?.kind === "audio")) return;

    const sender = addLocalTrack(peer, audioTrack, remoteConnectionId);
    await applySenderAudioQuality(sender);
}

function preferVp8(transceiver) {
    if (typeof transceiver?.setCodecPreferences !== "function") return;

    const codecs = RTCRtpSender.getCapabilities("video")?.codecs;
    if (!codecs?.length) return;

    const vp8Codecs = codecs.filter(codec => codec.mimeType.toLowerCase() === "video/vp8");
    if (vp8Codecs.length === 0) return;

    const remainingCodecs = codecs.filter(codec => codec.mimeType.toLowerCase() !== "video/vp8");
    transceiver.setCodecPreferences([...vp8Codecs, ...remainingCodecs]);
}

function setReceiverTransform(receiver, senderId, mediaKind) {
    if (receiver.transform) return;
    receiver.transform = new RTCRtpScriptTransform(
        encryptionWorker,
        { operation: "decrypt", key: voiceKey, senderId, mediaKind, contextId: localConnectionId });
}

async function negotiatePeer(connectionId, peer) {
    try {
        peer.makingOffer = true;
        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        await dotNetReference.invokeMethodAsync(
            "SendVoiceOffer",
            connectionId,
            serializeSessionDescription(peer.connection.localDescription));
    } finally {
        peer.makingOffer = false;
    }
}

async function handleLocalVideoEnded(event) {
    const endedTrack = event.target;
    if (endedTrack === cameraTrack) cameraTrack = undefined;
    if (screenTrack?.readyState === "live") {
        restoreCameraAfterScreenShare = false;
        return;
    }
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

async function handleScreenShareEnded() {
    try {
        await stopScreenSharing(true);
    } catch (error) {
        console.warn("Unable to stop screen sharing", error);
    }
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
    const sharingScreen = sender.track === screenTrack;
    const profile = sharingScreen
        ? { frameRate: 15, maxBitrate: 1500000 }
        : videoQualityProfiles[videoQuality];
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) {
        parameters.encodings = [{}];
    }
    for (const encoding of parameters.encodings) {
        encoding.maxBitrate = profile.maxBitrate;
        encoding.maxFramerate = profile.frameRate;
    }
    parameters.degradationPreference = sharingScreen ? "maintain-resolution" : "balanced";
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
            .filter(track => track === cameraTrack)
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

function normalizeTranscriptionModel(model) {
    if (model === "auto") return getRecommendedTranscriptionModel();
    return transcriptionModels.has(model) ? model : getRecommendedTranscriptionModel();
}