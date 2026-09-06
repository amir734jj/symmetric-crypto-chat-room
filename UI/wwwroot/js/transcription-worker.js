let transcriber;
let transcriberPromise;
let selectedModel;
const models = {
    default: {
        id: "onnx-community/whisper-tiny",
        label: "Whisper Tiny"
    },
    base: {
        id: "onnx-community/whisper-base",
        label: "Whisper Base"
    },
    small: {
        id: "onnx-community/whisper-small",
        label: "Whisper Small"
    }
};

self.onmessage = async event => {
    if (event.data?.type === "initialize") {
        try {
            await getTranscriber(event.data.model);
        } catch (error) {
            reportError(error);
        }
        return;
    }
    if (event.data?.type !== "transcribe") return;

    try {
        const pipeline = await getTranscriber(event.data.model);
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

async function getTranscriber(modelKey) {
    if (transcriber) return transcriber;
    if (transcriberPromise) return transcriberPromise;

    selectedModel = Object.hasOwn(models, modelKey) ? modelKey : "default";
    const model = models[selectedModel];
    self.postMessage({ type: "status", message: `Loading ${model.label} on device...` });
    transcriberPromise = (async () => {
        const { env, pipeline } = await import(
            "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2");
        env.allowLocalModels = false;
        env.useBrowserCache = true;

        transcriber = await pipeline(
            "automatic-speech-recognition",
            model.id,
            { device: "wasm", dtype: "q8" });
        self.postMessage({ type: "status", message: `Live transcription active (${model.label})` });
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
