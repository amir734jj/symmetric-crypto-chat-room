import { encodeSample, decodeSample } from "./vendor/alawmulaw/mulaw.js";

export const audioSampleRate = 8000;
export const audioFrameSamples = 320;

export function encodeMuLaw(value) {
    return encodeSample(Math.max(-32768, Math.min(32767, Math.round(value * 32768)))) & 0xff;
}

export function decodeMuLaw(value) {
    const sample = decodeSample(value);
    return sample === 0 ? 0 : sample / 32768;
}
