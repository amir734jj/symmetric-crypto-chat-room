let dotNetReference;
let remoteAudioContainer;
let localStream;
let peerConfiguration;
const peers = new Map();

export async function initialize(reference, container, turnCredentials) {
    dotNetReference = reference;
    remoteAudioContainer = container;

    const host = turnCredentials.host || window.location.hostname;
    peerConfiguration = {
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
}

function createPeer(connectionId) {
    const existing = peers.get(connectionId);
    if (existing) return existing;

    const connection = new RTCPeerConnection(peerConfiguration);
    for (const track of localStream.getTracks()) {
        connection.addTrack(track, localStream);
    }

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
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

    return peer;
}

async function addPendingCandidates(peer) {
    for (const candidate of peer.pendingCandidates) {
        await peer.connection.addIceCandidate(candidate);
    }
    peer.pendingCandidates.length = 0;
}