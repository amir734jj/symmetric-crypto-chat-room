import { audioFrameSamples } from "./https-audio-codec.js";

const headerSize = 25;
export const encryptedAudioFrameSize = headerSize + audioFrameSamples + 16;
export const maximumOpusFrameBytes = 4096;
const context = new TextEncoder().encode("symmetric-crypto-chat-room/https-audio/v1");

export class AudioFrameError extends Error {}

export async function createAudioCipher(base64Key, opus = false, mediaRevision = 0) {
    if (!Number.isSafeInteger(mediaRevision) || mediaRevision < 0) throw new Error("Invalid audio media revision");
    const bytes = Uint8Array.from(atob(base64Key), character => character.charCodeAt(0));
    if (bytes.length !== 32) throw new Error("Stealth audio requires a 256-bit voice key");
    const master = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    const stream = crypto.getRandomValues(new Uint8Array(16));
    const info = mediaRevision === 0 ? context
        : new TextEncoder().encode(`symmetric-crypto-chat-room/https-audio/v1/epoch/${mediaRevision}`);
    const derive = salt => crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info },
        master, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const sendKey = await derive(stream);
    let counter = 0n;

    return {
        async encrypt(samples) {
            if (!(samples instanceof Uint8Array) || (opus
                ? samples.length < 1 || samples.length > maximumOpusFrameBytes
                : samples.length !== audioFrameSamples)) {
                throw new Error("Invalid HTTPS audio sample frame");
            }
            if (counter === 0xffffffffffffffffn) throw new Error("HTTPS audio counter exhausted");
            const header = new Uint8Array(headerSize);
            header[0] = opus ? 2 : 1;
            header.set(stream, 1);
            new DataView(header.buffer).setBigUint64(17, ++counter);
            const iv = new Uint8Array(12);
            iv.set(stream.subarray(0, 4));
            iv.set(header.subarray(17), 4);
            const ciphertext = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv, additionalData: header }, sendKey, samples);
            const packet = new Uint8Array(headerSize + samples.length + 16);
            packet.set(header);
            packet.set(new Uint8Array(ciphertext), headerSize);
            return packet;
        },
        async decrypt(packet, receiver) {
            if (!(packet instanceof Uint8Array) || packet[0] !== (opus ? 2 : 1) ||
                (opus ? packet.length < 42 || packet.length > headerSize + maximumOpusFrameBytes + 16
                    : packet.length !== encryptedAudioFrameSize)) {
                throw new AudioFrameError("Invalid encrypted HTTPS audio frame");
            }
            const streamId = [...packet.subarray(1, 17)].map(value => value.toString(16).padStart(2, "0")).join("");
            if (receiver.streamId && receiver.streamId !== streamId) {
                throw new AudioFrameError("HTTPS audio stream changed without rejoining");
            }
            const sequence = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getBigUint64(17);
            if (sequence === 0n || sequence <= (receiver.counter ?? 0n)) {
                throw new AudioFrameError("Repeated or out-of-order HTTPS audio frame");
            }
            const key = receiver.key ?? await derive(packet.subarray(1, 17));
            const iv = new Uint8Array(12);
            iv.set(packet.subarray(1, 5));
            iv.set(packet.subarray(17, 25), 4);
            const clear = await crypto.subtle.decrypt({
                name: "AES-GCM", iv, additionalData: packet.subarray(0, headerSize)
            }, key, packet.subarray(headerSize));
            receiver.key = key;
            receiver.streamId = streamId;
            receiver.counter = sequence;
            return new Uint8Array(clear);
        }
    };
}
