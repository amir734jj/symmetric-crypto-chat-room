let transcriber;
let transcriberPromise;

self.onmessage = async event => {
    if (event.data?.type === "initialize") {
        try {
            await getTranscriber();
        } catch (error) {
            reportError(error);
        }
        return;
    }
    if (event.data?.type !== "transcribe") return;

    try {
        const pipeline = await getTranscriber();
        const result = await pipeline(event.data.audio, {
            chunk_length_s: 8,
            stride_length_s: 1,
            return_timestamps: false
        });
        self.postMessage({ type: "result", text: result.text?.trim() ?? "" });
    } catch (error) {
        reportError(error);
    }
};

async function getTranscriber() {
    if (transcriber) return transcriber;
    if (transcriberPromise) return transcriberPromise;

    self.postMessage({ type: "status", message: "Loading on-device transcription model..." });
    transcriberPromise = (async () => {
        const { env, pipeline } = await import(
            "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2");
        env.allowLocalModels = false;
        env.useBrowserCache = true;

        transcriber = await pipeline(
            "automatic-speech-recognition",
            "onnx-community/whisper-tiny",
            { device: "wasm", dtype: "q8" });
        self.postMessage({ type: "status", message: "Live transcription active" });
        return transcriber;
    })();

    try {
        return await transcriberPromise;
    } finally {
        transcriberPromise = undefined;
    }
}

function reportError(error) {
    self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error)
    });
}
