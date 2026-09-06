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

    event.transformer.readable
        .pipeThrough(new TransformStream({
            async transform(frame, controller) {
                const input = new Uint8Array(frame.data);
                const clearHeaderLength = mediaKind === "video"
                    ? clearHeaderLengths[frame.type] ?? clearHeaderLengths.delta
                    : clearHeaderLengths.audio;
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