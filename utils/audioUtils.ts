import { Blob } from '@google/genai';

/**
 * Downsample a Float32Array from the browser's native sample rate to a target
 * rate (16000 Hz for Gemini). Uses linear interpolation.
 *
 * This is critical: browsers often ignore the `sampleRate` option on
 * AudioContext and capture at 44100 or 48000 Hz. Without explicit
 * downsampling, Gemini receives audio at the wrong rate and can't
 * understand speech.
 */
export function downsampleBuffer(
  buffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  if (inputSampleRate === outputSampleRate) return buffer;
  if (inputSampleRate < outputSampleRate) {
    throw new Error('Input sample rate must be >= output sample rate');
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, buffer.length - 1);
    const frac = srcIndex - srcFloor;
    // Linear interpolation between adjacent samples
    result[i] = buffer[srcFloor] * (1 - frac) + buffer[srcCeil] * frac;
  }

  return result;
}

/**
 * Convert a Float32Array to a 16-bit PCM Blob for the Gemini Live API.
 * The data MUST already be at the correct sample rate (use downsampleBuffer first).
 */
export function createPcmBlob(data: Float32Array, sampleRate: number): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  return {
    data: base64EncodeUint8Array(new Uint8Array(int16.buffer)),
    mimeType: `audio/pcm;rate=${sampleRate}`,
  };
}

// Simple base64 encoder for Uint8Array
export function base64EncodeUint8Array(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Decode base64 string to raw bytes
export function base64DecodeToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Convert raw PCM bytes to an AudioBuffer for playback
export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number = 1
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// Convert Int16Array raw bytes to Float32Array (for AudioWorklet playback)
export function pcm16ToFloat32(data: Uint8Array): Float32Array {
  const dataInt16 = new Int16Array(data.buffer);
  const float32 = new Float32Array(dataInt16.length);
  for (let i = 0; i < dataInt16.length; i++) {
    float32[i] = dataInt16[i] / 32768.0;
  }
  return float32;
}