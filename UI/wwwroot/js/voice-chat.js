let dotNetReference;
let remoteAudioContainer;
let localStream;
let peerConfiguration;
let encryptionWorker;
let voiceKey;
const peers = new Map();

export async function initialize(reference, container, turnCredentials, passwordDerivedKey) {
    if (!("RTCRtpScriptTransform" in window)) {
        throw new Error("This browser does not support password-encrypted WebRTC audio");
    }

    dotNetReference = reference;
    remoteAudioContainer = container;
    voiceKey = passwordDerivedKey;
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
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        video: false
    });
}

export async function connectToParticipants(connectionIds) {
    for (const connectionId of connectionIds) {
        const peer = createPeer(connectionId);
        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        await dotNetReference.invokeMethodAsync(
            "SendVoiceOffer",
            connectionId,
            JSON.stringify(peer.connection.localDescription));
    }
}

export async function receiveOffer(senderConnectionId, offerJson) {
    const peer = createPeer(senderConnectionId);
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
    const peer = createPeer(senderConnectionId);
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

    return JSON.stringify({
        capturedAt: new Date().toISOString(),
        mediaEncryption: {
            passwordEncryption: voiceKey ? "AES-256-GCM" : "disabled",
            webRtcTransportEncryption: "DTLS-SRTP"
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

export function leave() {
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
    encryptionWorker?.terminate();
    encryptionWorker = undefined;
}

function createPeer(connectionId) {
    const existing = peers.get(connectionId);
    if (existing) return existing;

    const connection = new RTCPeerConnection(peerConfiguration);
    for (const track of localStream.getTracks()) {
        const sender = connection.addTrack(track, localStream);
        sender.transform = new RTCRtpScriptTransform(
            encryptionWorker,
            { operation: "encrypt", key: voiceKey });
    }

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    remoteAudioContainer.appendChild(audio);

    const peer = { connection, audio, pendingCandidates: [] };
    peers.set(connectionId, peer);

    connection.ontrack = event => {
        event.receiver.transform = new RTCRtpScriptTransform(
            encryptionWorker,
            { operation: "decrypt", key: voiceKey });
        audio.srcObject = event.streams[0];
    };

    connection.onicecandidate = event => {
        if (!event.candidate) return;
        dotNetReference.invokeMethodAsync(
            "SendVoiceIceCandidate",
            connectionId,
            JSON.stringify(event.candidate));
    };

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