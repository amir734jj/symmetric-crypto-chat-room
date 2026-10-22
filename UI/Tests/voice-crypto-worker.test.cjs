const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

async function transformFrames(operation, frames, mediaKind = "video", options = {}) {
    const self = {};
    const warnings = [];
    const scope = vm.createContext({
        self,
        crypto: options.failEncryption ? {
            getRandomValues: values => webcrypto.getRandomValues(values),
            subtle: {
                importKey: (...args) => webcrypto.subtle.importKey(...args),
                digest: (...args) => webcrypto.subtle.digest(...args),
                encrypt: () => Promise.reject(new Error("Encryption failed"))
            }
        } : webcrypto,
        TextEncoder, atob, TransformStream,
        Date: { now: () => options.now ?? 10000 },
        console: {
            warn: (...args) => warnings.push(args),
            error: (...args) => warnings.push(args)
        }
    });
    const source = await readFile(path.resolve(
        __dirname, "..", "wwwroot", "js", "voice-crypto-worker.js"), "utf8");
    vm.runInContext(source, scope);
    const output = [];
    let keyFrameRequests = 0;
    let finish;
    let fail;
    const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const transformer = {
        options: {
            operation, mediaKind, senderId: "sender", contextId: "receiver",
            key: Buffer.alloc(32, 7).toString("base64")
        },
        readable: new ReadableStream({
            start(controller) {
                for (const frame of frames) controller.enqueue({
                    type: frame.type,
                    data: Uint8Array.from(frame.data).buffer
                });
                controller.close();
            }
        }),
        writable: new WritableStream({
            write(frame) {
                output.push({ type: frame.type, data: new Uint8Array(frame.data) });
                options.onOutput?.(frame);
            },
            close: finish,
            abort: fail
        }),
        sendKeyFrameRequest() {
            keyFrameRequests++;
            return options.rejectRequest
                ? Promise.reject(new Error("Keyframe request failed"))
                : Promise.resolve();
        }
    };
    if (options.unsupportedRequest) delete transformer.sendKeyFrameRequest;
    self.onrtctransform({ transformer });
    await completed;
    return { output, keyFrameRequests, warnings };
}

function videoFrame(type, value) {
    const header = type === "key"
        ? [0x10, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0, 0x78, 0]
        : [0x11, 0x22, 0x33];
    return { type, data: Uint8Array.from([...header, ...new Array(64).fill(value)]) };
}

test("encrypted video round-trips key and delta frames without altering the wire format", async () => {
    const frames = [videoFrame("key", 1), videoFrame("delta", 2), videoFrame("delta", 3)];
    const encrypted = await transformFrames("encrypt", frames);
    for (let index = 0; index < frames.length; index++) {
        assert.equal(encrypted.output[index].data.length, frames[index].data.length + 9);
        const headerLength = frames[index].type === "key" ? 10 : 3;
        assert.deepEqual(encrypted.output[index].data.slice(0, headerLength), frames[index].data.slice(0, headerLength));
        assert.notDeepEqual(encrypted.output[index].data.slice(headerLength, -9), frames[index].data.slice(headerLength));
    }
    const decrypted = await transformFrames("decrypt", encrypted.output);
    assert.deepEqual(decrypted.output, frames);
    assert.equal(decrypted.keyFrameRequests, 0);
});

test("missing encrypted video frames request recovery and suppress dependent deltas until a keyframe", async () => {
    const frames = [
        videoFrame("key", 1), videoFrame("delta", 2), videoFrame("delta", 3),
        videoFrame("delta", 4), videoFrame("key", 5), videoFrame("delta", 6)
    ];
    const encrypted = await transformFrames("encrypt", frames);
    const received = encrypted.output.filter((frame, index) => index !== 1);
    const decrypted = await transformFrames("decrypt", received);
    assert.deepEqual(decrypted.output, [frames[0], frames[4], frames[5]]);
    assert.equal(decrypted.keyFrameRequests, 1);
});

test("joining mid-video waits for a decodable keyframe and throttles recovery requests", async () => {
    const frames = [
        videoFrame("delta", 1), videoFrame("delta", 2), videoFrame("delta", 3),
        videoFrame("key", 4), videoFrame("delta", 5)
    ];
    const encrypted = await transformFrames("encrypt", frames);
    const decrypted = await transformFrames("decrypt", encrypted.output);
    assert.deepEqual(decrypted.output, [frames[3], frames[4]]);
    assert.equal(decrypted.keyFrameRequests, 1);
});

test("invalid video metadata triggers recovery instead of forwarding corrupted bytes", async () => {
    const frames = [videoFrame("key", 1), videoFrame("delta", 2), videoFrame("key", 3)];
    const encrypted = await transformFrames("encrypt", frames);
    encrypted.output[1].data = new Uint8Array(3);
    const decrypted = await transformFrames("decrypt", encrypted.output);
    assert.deepEqual(decrypted.output, [frames[0], frames[2]]);
    assert.equal(decrypted.keyFrameRequests, 1);
});

test("lost audio frames do not block subsequent audio or request video keyframes", async () => {
    const frames = [1, 2, 3].map(value => ({
        type: undefined, data: Uint8Array.from([1, value, value, value, value])
    }));
    const encrypted = await transformFrames("encrypt", frames, "audio");
    const decrypted = await transformFrames("decrypt", [encrypted.output[0], encrypted.output[2]], "audio");
    assert.deepEqual(decrypted.output, [frames[0], frames[2]]);
    assert.equal(decrypted.keyFrameRequests, 0);
});

test("keyframe request failures are reported without passing undecodable deltas", async () => {
    const encrypted = await transformFrames("encrypt", [videoFrame("delta", 1), videoFrame("key", 2)]);
    const decrypted = await transformFrames("decrypt", encrypted.output, "video", { rejectRequest: true });
    assert.equal(decrypted.output.length, 1);
    assert.equal(decrypted.output[0].type, "key");
    assert.ok(decrypted.warnings.some(([message]) => message.includes("Unable to request")));
});

test("VP8 payload-descriptor frames retain their clear headers and decrypt identically", async () => {
    const frames = [videoFrame("key", 1), videoFrame("delta", 2)].map(frame => ({
        type: frame.type,
        data: Uint8Array.from([0x90, 0x80, 0x80, 0x01, ...frame.data])
    }));
    const encrypted = await transformFrames("encrypt", frames);
    assert.equal(encrypted.output[0].data.at(-9), 14);
    assert.equal(encrypted.output[1].data.at(-9), 7);
    const decrypted = await transformFrames("decrypt", encrypted.output);
    assert.deepEqual(decrypted.output, frames);
    assert.equal(decrypted.keyFrameRequests, 0);
});

test("unsupported recovery requests keep the pipeline alive and report the limitation", async () => {
    const frames = [videoFrame("delta", 1), videoFrame("key", 2)];
    const encrypted = await transformFrames("encrypt", frames);
    const decrypted = await transformFrames("decrypt", encrypted.output, "video", { unsupportedRequest: true });
    assert.deepEqual(decrypted.output, [frames[1]]);
    assert.ok(decrypted.warnings.some(([message]) => message.includes("this browser cannot request")));
});

for (const mediaKind of ["audio", "video"]) {
    test(`${mediaKind} encryption failure emits no plaintext frames`, async () => {
        const output = [];
        await assert.rejects(transformFrames("encrypt", [videoFrame("key", 1)], mediaKind, {
            failEncryption: true,
            onOutput: frame => output.push(frame)
        }), /Encryption failed/);
        assert.deepEqual(output, []);
    });
}
