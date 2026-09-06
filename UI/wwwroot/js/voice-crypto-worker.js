const clearHeaderLength = 1;

self.onrtctransform = event => {
    const { key, senderId, mediaKind } = event.transformer.options;
    const cryptoKey = importKey(key);
    const counterPrefix = createCounterPrefix(senderId, mediaKind);

    event.transformer.readable
        .pipeThrough(new TransformStream({
            async transform(frame, controller) {
                const input = new Uint8Array(frame.data);
                if (input.byteLength <= clearHeaderLength) {
                    controller.enqueue(frame);
                    return;
                }

                const header = input.slice(0, clearHeaderLength);
                const transformed = await crypto.subtle.encrypt(
                    { name: "AES-CTR", counter: await createCounter(counterPrefix, frame.timestamp), length: 64 },
                    await cryptoKey,
                    input.slice(clearHeaderLength));
                const output = new Uint8Array(input.byteLength);
                output.set(header);
                output.set(new Uint8Array(transformed), clearHeaderLength);
                frame.data = output.buffer;
                controller.enqueue(frame);
            }
        }))
        .pipeTo(event.transformer.writable);
};

function importKey(base64Key) {
    const bytes = Uint8Array.from(atob(base64Key), character => character.charCodeAt(0));
    return crypto.subtle.importKey("raw", bytes, "AES-CTR", false, ["encrypt"]);
}

function createCounterPrefix(senderId, mediaKind) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${senderId}:${mediaKind ?? "audio"}`));
}

async function createCounter(prefix, timestamp) {
    const counter = new Uint8Array(16);
    counter.set(new Uint8Array(await prefix).slice(0, 8));
    new DataView(counter.buffer).setBigUint64(8, BigInt(timestamp));
    return counter;
}