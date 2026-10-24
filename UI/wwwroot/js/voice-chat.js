import { getNetworkConnection, isMobileDevice } from "./media-defaults.js";
import { createIceConfiguration } from "./turn-diagnostics.js";
import { createScreenWakeLock, supportsMobileScreenWakeLock } from "./screen-wake-lock.js";

export { supportsMobileScreenWakeLock };

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
let lastConnectionHealth;
let automaticFallback = false;
let fallbackRequested = false;
const screenWakeLock = createScreenWakeLock(() => localStream);
let selectedAudioOutputId = "";
let audioOutputMode = "auto";
let proximitySensor;
let proximitySensorNear;
let transcription;
let transcriptionRequestId = 0;
const peers = new Map();
const liveDataRateSamples = new Map();
const senderVideoBudgets = new WeakMap();
const audioQualityProfiles = {
    "very-low": { sampleRate: 16000, maxBitrate: 12000 },
    low: { sampleRate: 16000, maxBitrate: 16000 },
    standard: { sampleRate: 32000, maxBitrate: 32000 },
    high: { sampleRate: 48000, maxBitrate: 64000 }
};
const videoQualityProfiles = {
    "very-low": { width: 256, height: 144, frameRate: 8, maxBitrate: 100000 },
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
    selectedVideoQuality,
    enableAutomaticFallback = false) {
    if (typeof window.RTCRtpScriptTransform !== "function") {
        throw new Error("This browser does not support password-encrypted WebRTC audio");
    }

    dotNetReference = reference;
    automaticFallback = enableAutomaticFallback;
    fallbackRequested = false;
    lastConnectionHealth = undefined;
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
        new URL("./voice-crypto-worker.js", import.meta.url),
        { type: "module" });

    peerConfiguration = createIceConfiguration(turnCredentials);

    localStream = new MediaStream();
    getNetworkConnection()?.removeEventListener?.("change", handleNetworkConnectionChange);
    getNetworkConnection()?.addEventListener?.("change", handleNetworkConnectionChange);
    startQualityAdaptation();
    notifyAudioQualityChanged();
    notifyVideoQualityChanged();
    notifyConnectionHealth();
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
    if (!message.description?.type || !message.description?.sdp) {
        throw new Error("The media bridge received an invalid session description");
    }
    return {
        description: message.description,
        mediaReadable: Boolean(message.mediaKeyConfirmation) && message.mediaKeyConfirmation === mediaKeyConfirmation
    };
}

function updatePeerMediaReadability(peer, readable) {
    peer.mediaReadable = readable;
    peer.audio.muted = !readable;
    peer.video.hidden = !readable;
    peer.focusButton.hidden = !readable;
    peer.unreadableStatus.hidden = readable;
    encryptionWorker.postMessage({
        type: "media-readability",
        senderId: peer.connectionId,
        contextId: localConnectionId,
        readable
    });
    if (!readable) {
        disconnectTranscriptionStream(peer.connectionId);
        if (focusedVideoTile === peer.tile) setFocusedVideoTile(undefined);
    } else if (peer.audio.srcObject) {
        connectTranscriptionStream(peer.connectionId, peer.audio.srcObject);
    }
    peer.updateVideoVisibility();
}

export async function connectToParticipants(participants) {
    if (participants.length > 0) await ensureLocalAudio();

    for (const participant of participants) {
        const peer = await createPeer(participant.connectionId, participant.name);
        await negotiatePeer(participant.connectionId, peer);
    }
}

export function updateParticipantNames(participants) {
    for (const participant of participants) {
        const peer = peers.get(participant.connectionId);
        if (peer) peer.caption.textContent = participant.name;
    }
}

export async function receiveOffer(senderConnectionId, senderName, offerJson) {
    const offer = parseSessionDescription(offerJson);

    await ensureLocalAudio();

    const peer = await createPeer(senderConnectionId, senderName);
    await ensurePeerAudioSender(peer, senderConnectionId);
    const offerCollision = peer.makingOffer || peer.connection.signalingState !== "stable";
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    updatePeerMediaReadability(peer, offer.mediaReadable);
    if (offerCollision) {
        await peer.connection.setLocalDescription({ type: "rollback" });
    }
    await peer.connection.setRemoteDescription(offer.description);
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

    const answer = parseSessionDescription(answerJson);
    updatePeerMediaReadability(peer, answer.mediaReadable);
    await peer.connection.setRemoteDescription(answer.description);
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

export async function setKeepScreenOn(enabled) {
    return await screenWakeLock.setEnabled(enabled);
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
        if (transcription?.isEnabled()) {
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

    if (transcription?.isEnabled()) {
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
                        await replaceEncryptedVideoTrack(peer, sender, displayTrack);
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
                await replaceEncryptedVideoTrack(peer, sender, restoredCamera);
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
    return Boolean(window.AudioContext || window.webkitAudioContext) && "Worker" in window &&
        !isMobileDevice();
}

function handleNetworkConnectionChange() {
    dotNetReference?.invokeMethodAsync(
        "TranscriptionAvailabilityChanged", supportsLiveTranscription(), getRecommendedTranscriptionModel())
        .catch(error => console.warn("Unable to update transcription availability", error));
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
        if (transcription?.isEnabled()) return true;
        if (!localStream?.getAudioTracks().some(track => track.readyState === "live")) {
            throw new Error("Connect to another participant before starting transcription");
        }
        if (!supportsLiveTranscription()) {
            if (isMobileDevice()) {
                throw new Error("Live transcription is not available on mobile devices");
            }
            throw new Error("Live transcription is not supported by this browser");
        }

        const requestId = ++transcriptionRequestId;
        const module = await import("./voice-transcription.js");
        if (requestId !== transcriptionRequestId) return false;
        transcription = module;
        if (!localStream?.getAudioTracks().some(track => track.readyState === "live")) {
            throw new Error("Connect to another participant before starting transcription");
        }
        if (!supportsLiveTranscription()) {
            throw new Error("The connection no longer supports starting transcription");
        }
        const model = ["tiny", "base", "small", "tiny-en", "base-en", "small-en"].includes(selectedModel)
            ? selectedModel
            : getRecommendedTranscriptionModel();
        return transcription.start(
            dotNetReference,
            model,
            () => {
                const streams = new Map([["local", localStream]]);
                for (const [connectionId, peer] of peers) {
                    if (peer.mediaReadable && peer.audio.srcObject) streams.set(connectionId, peer.audio.srcObject);
                }
                return streams;
            });
    }

    stopTranscription();
    return false;
}

function connectTranscriptionStream(id, stream) {
    transcription?.connectStream(id, stream);
}

function disconnectTranscriptionStream(id) {
    transcription?.disconnectStream(id);
}

function stopTranscription() {
    transcriptionRequestId++;
    transcription?.stop();
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
                videoSenderLimits: peer.connection.getSenders()
                    .filter(sender => sender.track?.kind === "video")
                    .flatMap(sender => sender.getParameters().encodings ?? [])
                    .map(encoding => ({
                        maxBitrate: encoding.maxBitrate,
                        maxFramerate: encoding.maxFramerate,
                        scaleResolutionDownBy: encoding.scaleResolutionDownBy
                    })),
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
            screenWakeLockActive: screenWakeLock.active,
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
        frameWidth: report.frameWidth,
        frameHeight: report.frameHeight,
        framesPerSecond: report.framesPerSecond,
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
    peer.connection.onconnectionstatechange = null;
    peer.connection.close();
    disconnectTranscriptionStream(connectionId);
    peer.audio.remove();
    peer.tile.remove();
    encryptionWorker.postMessage({
        type: "media-readability",
        senderId: connectionId,
        contextId: localConnectionId,
        readable: null
    });
    liveDataRateSamples.delete(connectionId);
    peers.delete(connectionId);
    notifyConnectionHealth();
    stopLocalAudioIfAlone();
}

export function leave() {
    automaticFallback = false;
    fallbackRequested = false;
    setFocusedVideoTile(undefined);
    stopTranscription();
    clearInterval(adaptationTimer);
    adaptationTimer = undefined;
    goodNetworkSamples = 0;
    poorNetworkSamples = 0;
    goodVideoNetworkSamples = 0;
    poorVideoNetworkSamples = 0;
    getNetworkConnection()?.removeEventListener?.("change", handleNetworkConnectionChange);
    screenWakeLock.release();
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
    audio.muted = true;
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
    video.hidden = true;
    video.className = "voice-video voice-video-remote";
    video.setAttribute("aria-label", `${participantName || "Remote participant"} camera`);
    tile.appendChild(video);

    const caption = document.createElement("figcaption");
    caption.textContent = participantName || "Participant";
    tile.appendChild(caption);
    const unreadableStatus = document.createElement("p");
    unreadableStatus.className = "text-muted text-center";
    unreadableStatus.textContent = "Unreadable media - different password";
    unreadableStatus.setAttribute("role", "status");
    unreadableStatus.hidden = true;
    tile.appendChild(unreadableStatus);
    remoteMediaContainer.appendChild(tile);

    const peer = {
        connectionId,
        connection,
        audio,
        video,
        tile,
        caption,
        focusButton,
        unreadableStatus,
        mediaReadable: false,
        updateVideoVisibility() {
            tile.hidden = unreadableStatus.hidden && (!peer.mediaReadable ||
                !video.srcObject?.getVideoTracks().some(track => !track.muted && track.readyState !== "ended"));
            if (tile.hidden && focusedVideoTile === tile) setFocusedVideoTile(undefined);
        },
        pendingCandidates: [],
        makingOffer: false,
        ignoreOffer: false,
        goodVideoBandwidthSamples: 0,
        healthPacketSamples: new Map(),
        createdAt: Date.now(),
        hasReceivedAudio: false,
        polite: localConnectionId.localeCompare(connectionId) > 0
    };
    peers.set(connectionId, peer);
    connection.onconnectionstatechange = () => {
        peer.connectionHealth = undefined;
        peer.healthPacketSamples.clear();
        notifyConnectionHealth();
        if (connection.connectionState === "failed") requestHttpsFallback("WebRTC connection failed");
    };
    notifyConnectionHealth();
    const audioSenders = [];
    const videoSenders = [];
    for (const track of localStream.getTracks()) {
        const sender = addLocalTrack(peer, track, connectionId);
        if (track.kind === "audio") audioSenders.push(sender);
        if (track.kind === "video") videoSenders.push(sender);
    }

    connection.ontrack = event => {
        setReceiverTransform(event.receiver, connectionId, event.track.kind);
        // A recvonly sender must be encrypted before negotiation, not when addTrack later reuses it.
        const transceiver = connection.getTransceivers()
            .find(candidate => candidate.receiver === event.receiver);
        if (transceiver) setSenderTransform(transceiver.sender, connectionId, event.track.kind);
        const mediaElement = event.track.kind === "video" ? video : audio;
        const mediaStream = event.track.kind === "video"
            ? new MediaStream()
            : mediaElement.srcObject ?? new MediaStream();
        if (!mediaStream.getTracks().includes(event.track)) {
            mediaStream.addTrack(event.track);
        }
        mediaElement.srcObject = mediaStream;

        if (event.track.kind === "audio" && peer.mediaReadable) {
            connectTranscriptionStream(connectionId, mediaStream);
        }

        if (event.track.kind === "video") {
            mediaElement.play().catch(error => {
                console.warn("Unable to start remote video playback", error);
            });
            const updateVideoVisibility = () => {
                if (mediaElement.srcObject !== mediaStream) return;
                peer.updateVideoVisibility();
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
    requireMediaEncryption();
    const transform = createSenderTransform(remoteConnectionId, track.kind);
    const sender = peer.connection.addTrack(track, localStream);
    try {
        if (!sender.transform) sender.transform = transform;
        const transceiver = peer.connection.getTransceivers()
            .find(candidate => candidate.sender === sender);
        if (track.kind === "video") {
            preferVp8(transceiver);
        }
        setReceiverTransform(transceiver.receiver, remoteConnectionId, track.kind);
        return sender;
    } catch (error) {
        peer.connection.removeTrack(sender);
        throw error;
    }
}

function setSenderTransform(sender, remoteConnectionId, mediaKind) {
    if (sender.transform) return;
    requireMediaEncryption();
    sender.transform = createSenderTransform(remoteConnectionId, mediaKind);
}

function createSenderTransform(remoteConnectionId, mediaKind) {
    return new RTCRtpScriptTransform(
        encryptionWorker,
        { operation: "encrypt", key: voiceKey, senderId: localConnectionId, mediaKind, contextId: remoteConnectionId });
}

function requireMediaEncryption() {
    if (!voiceKey || !encryptionWorker) {
        throw new Error("Password encryption is not initialized; refusing to send media");
    }
}

function replaceEncryptedVideoTrack(peer, sender, track) {
    try {
        requireMediaEncryption();
        if (!sender.transform) {
            throw new Error("Password encryption is missing from the video sender; refusing to replace its track");
        }
    } catch (error) {
        peer.connection.removeTrack(sender);
        throw error;
    }
    return sender.replaceTrack(track);
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
        {
            operation: "decrypt", key: voiceKey, senderId, mediaKind, contextId: localConnectionId,
            mediaReadable: peers.get(senderId)?.mediaReadable === true
        });
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

function getVideoConstraints(quality = videoQuality) {
    const profile = videoQualityProfiles[quality];
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
    const bitrate = Math.min(profile.maxBitrate, senderVideoBudgets.get(sender) ?? profile.maxBitrate);
    const settings = sender.track?.getSettings?.();
    const captureScale = !sharingScreen && settings?.width && settings?.height
        ? Math.max(1, settings.width / profile.width, settings.height / profile.height)
        : 1;
    if (!parameters.encodings?.length) {
        parameters.encodings = [{}];
    }
    for (const encoding of parameters.encodings) {
        encoding.maxBitrate = bitrate;
        encoding.maxFramerate = Math.min(profile.frameRate, bitrate < 100000 ? 5 : bitrate < 200000 ? 10 : profile.frameRate);
        encoding.scaleResolutionDownBy = sharingScreen ? 1
            : captureScale * Math.min(4, Math.max(1, Math.sqrt(profile.maxBitrate / bitrate)));
    }
    parameters.degradationPreference = "maintain-resolution";
    await sender.setParameters(parameters);
}

function startQualityAdaptation() {
    clearInterval(adaptationTimer);
    adaptationTimer = setInterval(adaptMediaQuality, 5000);
}

async function adaptMediaQuality() {
    if (adaptationInProgress || peers.size === 0) return;

    adaptationInProgress = true;
    try {
        for (const peer of peers.values()) {
            if (Date.now() - peer.createdAt >= 20000 && peer.connection.connectionState !== "connected") {
                requestHttpsFallback("WebRTC could not establish media within 20 seconds");
            }
        }
        const samples = await Promise.all([...peers.values()].map(getNetworkSample));
        notifyConnectionHealth();
        const usableSamples = samples.filter(sample => sample !== null);
        if (usableSamples.length === 0) return;
        await Promise.all(usableSamples.map(adaptPeerVideoBandwidth));

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
            (sample.availableOutgoingBitrate !== undefined && sample.availableOutgoingBitrate >= improvementBitrate));
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
        notifyConnectionHealth();
    } finally {
        adaptationInProgress = false;
    }
}

async function adaptPeerVideoBandwidth(sample) {
    const { peer } = sample;
    if (peers.get(peer.connectionId) !== peer) return;
    const senders = peer.connection.getSenders().filter(sender => sender.track?.kind === "video");
    if (senders.length === 0) return;

    const loss = sample.videoFractionLost ?? sample.fractionLost;
    const poor = loss > 0.06 || sample.roundTripTime > 0.35;
    const healthy = !poor && (loss === undefined || loss <= 0.03) &&
        (sample.roundTripTime === undefined || sample.roundTripTime <= 0.2);
    peer.goodVideoBandwidthSamples = healthy ? peer.goodVideoBandwidthSamples + 1 : 0;
    const recover = peer.goodVideoBandwidthSamples >= 3;
    if (recover) peer.goodVideoBandwidthSamples = 0;

    for (const sender of senders) {
        const maximum = sender.track === screenTrack ? 1500000 : videoQualityProfiles[videoQuality].maxBitrate;
        const previous = Math.min(maximum, senderVideoBudgets.get(sender) ?? maximum);
        const available = Number.isFinite(sample.availableOutgoingBitrate) && sample.availableOutgoingBitrate > 0
            ? Math.max(50000, Math.floor(sample.availableOutgoingBitrate * 0.7 - audioQualityProfiles[audioQuality].maxBitrate))
            : maximum;
        let budget = Math.min(previous, available);
        if (poor) budget = Math.min(budget, Math.max(50000, Math.floor(previous * 0.65)));
        else if (recover) budget = Math.min(maximum, available, Math.ceil(previous * 1.25));
        if (budget < maximum) senderVideoBudgets.set(sender, budget);
        else senderVideoBudgets.delete(sender);
        await applySenderVideoQuality(sender);
    }
}

async function getNetworkSample(peer) {
    peer.connectionHealth = undefined;
    if (peer.connection.connectionState !== "connected") return null;

    const stats = await peer.connection.getStats();
    if (peers.get(peer.connectionId) !== peer || peer.connection.connectionState !== "connected") return null;
    peer.connectionHealth = measureConnectionHealth(peer, stats);
    let selectedPair;
    let remoteInboundAudio;
    let remoteInboundVideo;

    stats.forEach(report => {
        if (report.type === "inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio") &&
            report.packetsReceived > 0) peer.hasReceivedAudio = true;
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
            selectedPair = report;
        } else if (report.type === "remote-inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) {
            remoteInboundAudio = report;
        } else if (report.type === "remote-inbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
            remoteInboundVideo = report;
        }
    });
    if (peer.mediaReadable && !peer.hasReceivedAudio && Date.now() - peer.createdAt >= 20000) {
        requestHttpsFallback("WebRTC connected but no audio packets arrived");
    }

    const sample = {
        roundTripTime: remoteInboundAudio?.roundTripTime ?? remoteInboundVideo?.roundTripTime ?? selectedPair?.currentRoundTripTime,
        fractionLost: remoteInboundAudio?.fractionLost,
        videoFractionLost: remoteInboundVideo?.fractionLost,
        availableOutgoingBitrate: selectedPair?.availableOutgoingBitrate
    };

    return Object.values(sample).some(value => value !== undefined)
        ? { ...sample, peer }
        : null;
}

function requestHttpsFallback(reason) {
    if (!automaticFallback || fallbackRequested || !dotNetReference) return;
    fallbackRequested = true;
    dotNetReference.invokeMethodAsync("WebRtcMediaFailed", reason)
        .catch(error => console.error("Unable to negotiate HTTPS audio fallback", error));
}

function measureConnectionHealth(peer, stats) {
    const { selectedPair } = getSelectedCandidatePair(stats);
    const losses = [];
    const latencies = [];
    const jitters = [];
    let bandwidthLimited = false;
    if (Number.isFinite(selectedPair?.currentRoundTripTime)) latencies.push(selectedPair.currentRoundTripTime);
    stats.forEach(report => {
        if (report.type === "remote-inbound-rtp") {
            if (Number.isFinite(report.fractionLost)) losses.push(Math.max(0, report.fractionLost));
            if (Number.isFinite(report.roundTripTime)) latencies.push(report.roundTripTime);
        }
        if (report.type === "inbound-rtp") {
            if (Number.isFinite(report.jitter)) jitters.push(report.jitter);
            if (Number.isFinite(report.packetsReceived) && Number.isFinite(report.packetsLost)) {
                const previous = peer.healthPacketSamples.get(report.id);
                peer.healthPacketSamples.set(report.id, {
                    received: report.packetsReceived, lost: report.packetsLost
                });
                if (previous && report.packetsReceived >= previous.received && report.packetsLost >= previous.lost) {
                    const received = report.packetsReceived - previous.received;
                    const lost = report.packetsLost - previous.lost;
                    if (received + lost > 0) losses.push(lost / (received + lost));
                }
            }
        }
        if (report.type === "outbound-rtp" && report.qualityLimitationReason === "bandwidth") {
            bandwidthLimited = true;
        }
    });
    const loss = losses.length ? Math.max(...losses) : undefined;
    const latency = latencies.length ? Math.max(...latencies) : undefined;
    const jitter = jitters.length ? Math.max(...jitters) : undefined;
    const senders = peer.connection.getSenders().filter(sender => sender.track?.readyState === "live");
    const requiredBitrate = senders.reduce((total, sender) => total + (sender.track.kind === "audio"
        ? audioQualityProfiles[audioQuality].maxBitrate
        : sender.track === screenTrack ? 1500000 : videoQualityProfiles[videoQuality].maxBitrate), 0);
    const available = Number.isFinite(selectedPair?.availableOutgoingBitrate) && requiredBitrate > 0
        ? selectedPair.availableOutgoingBitrate : undefined;
    const poor = loss > 0.05 || latency > 0.3 || jitter > 0.06 ||
        (available !== undefined && available < requiredBitrate * 0.5);
    const fair = loss > 0.02 || latency > 0.15 || jitter > 0.03 || bandwidthLimited ||
        (available !== undefined && available < requiredBitrate * 1.2);
    const details = [];
    if (loss !== undefined) details.push(`${(loss * 100).toFixed(1)}% packet loss`);
    if (latency !== undefined) details.push(`${Math.round(latency * 1000)} ms round-trip latency`);
    if (jitter !== undefined) details.push(`${Math.round(jitter * 1000)} ms jitter`);
    if (available !== undefined) details.push(`${Math.round(available / 1000)} kbps available / ${Math.round(requiredBitrate / 1000)} kbps required`);
    if (bandwidthLimited) details.push("browser reports bandwidth limitation");
    return {
        level: poor ? "poor" : fair ? "fair" : details.length ? "healthy" : "checking",
        detail: details.length ? details.join("; ") : "Media measurements unavailable"
    };
}

function notifyConnectionHealth() {
    const severity = { healthy: 0, checking: 1, fair: 2, poor: 3 };
    let health = { level: "waiting", detail: "Waiting for another participant" };
    for (const peer of peers.values()) {
        const state = peer.connection.connectionState;
        const current = state === "failed" || state === "disconnected" || state === "closed"
            ? { level: "poor", detail: `Media connection ${state}` }
            : state === "connected" && peer.connectionHealth
                ? peer.connectionHealth
                : { level: "checking", detail: state === "connected" ? "Media measurements unavailable" : "Connecting media" };
        if (health.level === "waiting" || severity[current.level] > severity[health.level]) health = current;
    }
    const notification = `${health.level}:${health.detail}`;
    if (notification === lastConnectionHealth) return;
    lastConnectionHealth = notification;
    dotNetReference?.invokeMethodAsync("ConnectionHealthChanged", health.level, health.detail)
        .catch(error => console.warn("Unable to update call connection health", error));
}

function notifyAudioQualityChanged() {
    dotNetReference?.invokeMethodAsync("AudioQualityAdapted", audioQuality).catch(() => {});
}

export async function setVideoQuality(selectedVideoQuality) {
    const mode = normalizeVideoQualityMode(selectedVideoQuality);
    goodVideoNetworkSamples = 0;
    poorVideoNetworkSamples = 0;
    await setEffectiveVideoQuality(mode === "auto" ? "standard" : mode);
    videoQualityMode = mode;
    return videoQuality;
}

async function setEffectiveVideoQuality(selectedVideoQuality) {
    const normalizedQuality = normalizeVideoQuality(selectedVideoQuality);
    const qualityChanged = videoQuality !== normalizedQuality;
    if (localStream) {
        await Promise.all(localStream.getVideoTracks()
            .filter(track => track === cameraTrack)
            .map(track => track.applyConstraints(getVideoConstraints(normalizedQuality))));
    }
    videoQuality = normalizedQuality;

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
