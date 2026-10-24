export const audioSampleRate = 8000;
export const audioFrameSamples = 320;

export function encodeMuLaw(value) {
    let sample = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
    const sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    sample = Math.min(sample, 32635) + 132;
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && !(sample & mask); mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function decodeMuLaw(value) {
    const code = ~value & 0xff;
    const magnitude = (((code & 0x0f) << 3) + 132) << ((code & 0x70) >> 4);
    return ((code & 0x80) ? 132 - magnitude : magnitude - 132) / 32768;
}
