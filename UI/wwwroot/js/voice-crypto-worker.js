const clearHeaderLengths = {
    key: 10,
    delta: 3,
    audio: 1
};
const frameMetadataLength = 9;

self.onrtctransform = event => {
    const { operation, key, senderId, mediaKind, contextId } = event.transformer.options;
    const cryptoKey = importKey(key);
    const counterPrefix = createCounterPrefix(senderId, mediaKind, contextId);
    let frameCounter = operation === "encrypt" ? createInitialFrameCounter() : 0n;
    let hasVp8PayloadDescriptor = null;

    event.transformer.readable
        .pipeThrough(new TransformStream({
            async transform(frame, controller) {
                const input = new Uint8Array(frame.data);
                let clearHeaderLength = clearHeaderLengths.audio;
                if (operation === "encrypt" && mediaKind === "video") {
                    const vp8Header = getVp8ClearHeader(input, frame.type, hasVp8PayloadDescriptor);
                    clearHeaderLength = vp8Header.length;
                    hasVp8PayloadDescriptor = vp8Header.hasPayloadDescriptor;
                }
                const output = operation === "encrypt"
                    ? await encryptFrame(input, clearHeaderLength, counterPrefix, cryptoKey, frameCounter++)
                    : await decryptFrame(input, counterPrefix, cryptoKey);
                if (!output) return;

                frame.data = output.buffer;
                controller.enqueue(frame);
            }
        }))
        .pipeTo(event.transformer.writable);
};

function getVp8ClearHeader(frame, frameType, hasPayloadDescriptor) {
    if (frame.byteLength === 0) return { length: 0, hasPayloadDescriptor };

    if (hasPayloadDescriptor === null) {
        if (hasVp8KeyFrameHeader(frame, 0)) hasPayloadDescriptor = false;
        else {
            const candidateLength = getVp8PayloadDescriptorLength(frame);
            if (candidateLength > 0 && hasVp8KeyFrameHeader(frame, candidateLength)) {
                hasPayloadDescriptor = true;
            }
        }
    }

    const descriptorLength = hasPayloadDescriptor === true
        ? getVp8PayloadDescriptorLength(frame)
        : 0;
    const headerLength = frameType === "key" ||
        hasVp8KeyFrameHeader(frame, descriptorLength) ||
        (frameType !== "delta" && (frame[descriptorLength] & 0x01) === 0)
        ? clearHeaderLengths.key
        : clearHeaderLengths.delta;

    return {
        length: Math.min(descriptorLength + headerLength, frame.byteLength),
        hasPayloadDescriptor
    };
}

function hasVp8KeyFrameHeader(frame, offset) {
    return offset + 5 < frame.byteLength &&
        (frame[offset] & 0x01) === 0 &&
        frame[offset + 3] === 0x9d &&
        frame[offset + 4] === 0x01 &&
        frame[offset + 5] === 0x2a;
}

function getVp8PayloadDescriptorLength(frame) {
    if (frame.byteLength === 0 || (frame[0] & 0x5f) !== 0x10) return 0;

    let offset = 1;
    if ((frame[0] & 0x80) === 0) return offset;
    if (offset >= frame.byteLength) return 0;

    const extension = frame[offset++];
    if ((extension & 0x80) !== 0) {
        if (offset >= frame.byteLength) return 0;
        offset += (frame[offset] & 0x80) !== 0 ? 2 : 1;
    }
    if ((extension & 0x40) !== 0) offset++;
    if ((extension & 0x30) !== 0) offset++;
    return offset <= frame.byteLength ? offset : 0;
}

function createInitialFrameCounter() {
    return crypto.getRandomValues(new BigUint64Array(1))[0];
}

async function encryptFrame(input, clearHeaderLength, counterPrefix, cryptoKey, frameCounter) {
    const transformed = await transformPayload(
        input.slice(clearHeaderLength),
        counterPrefix,
        cryptoKey,
        frameCounter);
    const output = new Uint8Array(input.byteLength + frameMetadataLength);
    output.set(input.slice(0, clearHeaderLength));
    output.set(transformed, clearHeaderLength);
    output[input.byteLength] = clearHeaderLength;
    new DataView(output.buffer).setBigUint64(input.byteLength + 1, frameCounter);
    return output;
}

async function decryptFrame(input, counterPrefix, cryptoKey) {
    if (input.byteLength < frameMetadataLength) return null;

    const encryptedLength = input.byteLength - frameMetadataLength;
    const clearHeaderLength = input[encryptedLength];
    if (clearHeaderLength > encryptedLength) return null;
    const frameCounter = new DataView(
        input.buffer,
        input.byteOffset + encryptedLength + 1,
        8).getBigUint64(0);
    const transformed = await transformPayload(
        input.slice(clearHeaderLength, encryptedLength),
        counterPrefix,
        cryptoKey,
        frameCounter);
    const output = new Uint8Array(encryptedLength);
    output.set(input.slice(0, clearHeaderLength));
    output.set(transformed, clearHeaderLength);
    return output;
}

async function transformPayload(payload, counterPrefix, cryptoKey, frameCounter) {
    const transformed = await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: await createCounter(counterPrefix, frameCounter), length: 64 },
        await cryptoKey,
        payload);
    return new Uint8Array(transformed);
}

function importKey(base64Key) {
    const bytes = Uint8Array.from(atob(base64Key), character => character.charCodeAt(0));
    return crypto.subtle.importKey("raw", bytes, "AES-CTR", false, ["encrypt"]);
}

async function createCounterPrefix(senderId, mediaKind, contextId) {
    const prefix = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${senderId}:${mediaKind ?? "audio"}:${contextId}`));
    return new Uint8Array(prefix).slice(0, 8);
}

async function createCounter(prefixPromise, frameCounter) {
    const counter = new Uint8Array(16);
    counter.set(await prefixPromise);
    new DataView(counter.buffer).setBigUint64(8, frameCounter);
    return counter;
}