const nonceLength = 12;
const tagLength = 128;

self.onrtctransform = event => {
    const { operation, key } = event.transformer.options;
    const cryptoKey = importKey(key);
    const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
    let counter = 0;

    event.transformer.readable
        .pipeThrough(new TransformStream({
            async transform(frame, controller) {
                if (operation === "encrypt") {
                    const nonce = new Uint8Array(nonceLength);
                    nonce.set(noncePrefix);
                    new DataView(nonce.buffer).setUint32(8, counter++);

                    const ciphertext = await crypto.subtle.encrypt(
                        { name: "AES-GCM", iv: nonce, tagLength },
                        await cryptoKey,
                        frame.data);
                    const output = new Uint8Array(nonceLength + ciphertext.byteLength);
                    output.set(nonce);
                    output.set(new Uint8Array(ciphertext), nonceLength);
                    frame.data = output.buffer;
                    controller.enqueue(frame);
                    return;
                }

                const input = new Uint8Array(frame.data);
                if (input.byteLength <= nonceLength + tagLength / 8) return;

                try {
                    frame.data = await crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: input.slice(0, nonceLength), tagLength },
                        await cryptoKey,
                        input.slice(nonceLength));
                    controller.enqueue(frame);
                } catch {
                    // Authentication failure means the peer used a different room password.
                }
            }
        }))
        .pipeTo(event.transformer.writable);
};

function importKey(base64Key) {
    const bytes = Uint8Array.from(atob(base64Key), character => character.charCodeAt(0));
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}