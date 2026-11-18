import { isObject } from '../miniprogram/core/orders';
import { textOrderLimit } from '../miniprogram/core/text-order';
import { HttpError } from './http-error';

export const voiceMaxBytes = 8 * 1024 * 1024;
export const voiceMaxJsonBytes = 4 * Math.ceil(voiceMaxBytes / 3) + 64;
const sampleRates = [8000, 16000, 22050, 24000, 32000, 44100, 48000];

export type SpeechModel = (wave: Buffer) => Promise<unknown>;

export function decodeWave(value: unknown): Buffer {
  const wave = isObject(value) ? value.wave : undefined;
  if (typeof wave !== 'string' || !wave) throw new HttpError(400, 'invalid_voice', '录音内容缺失，请重新录音。');
  if (wave.length > 4 * Math.ceil(voiceMaxBytes / 3)) {
    throw new HttpError(413, 'body_too_large', '录音文件过大，请分段录音');
  }
  const data = Buffer.from(wave, 'base64');
  if (data.length > voiceMaxBytes) throw new HttpError(413, 'body_too_large', '录音文件过大，请分段录音');
  if (data.toString('base64') !== wave) throw new HttpError(400, 'invalid_voice', '录音编码不完整，请重新录音。');
  return data;
}

export function validateWave(wave: Buffer) {
  const invalid = () => new HttpError(400, 'invalid_voice', '录音格式无法识别，请重新录音或手动输入。');
  if (wave.length < 44 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE' ||
      wave.readUInt32LE(4) + 8 !== wave.length) throw invalid();
  let byteRate = 0;
  let dataSize = 0;
  for (let offset = 12; offset < wave.length;) {
    if (offset + 8 > wave.length) throw invalid();
    const kind = wave.toString('ascii', offset, offset + 4);
    const length = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    offset = start + length + (length % 2);
    if (offset > wave.length) throw invalid();
    if (kind === 'fmt ') {
      if (length < 16 || byteRate) throw invalid();
      const sampleRate = wave.readUInt32LE(start + 4);
      byteRate = wave.readUInt32LE(start + 8);
      if (wave.readUInt16LE(start) !== 1 || wave.readUInt16LE(start + 2) !== 1 || !sampleRates.includes(sampleRate) ||
          byteRate !== sampleRate * 2 || wave.readUInt16LE(start + 12) !== 2 || wave.readUInt16LE(start + 14) !== 16) throw invalid();
    } else if (kind === 'data') {
      if (!byteRate || dataSize || !length || length % 2) throw invalid();
      dataSize = length;
    }
  }
  if (!dataSize || dataSize > byteRate * 120) throw invalid();
}

export function readTranscript(value: unknown) {
  if (!isObject(value) || typeof value.text !== 'string' || value.text.includes('\0') ||
      Buffer.from(value.text).toString() !== value.text) {
    throw new HttpError(502, 'voice_model_failed', '语音转写暂未完成，可用原录音重试。');
  }
  const text = value.text.trim();
  if (!text) throw new HttpError(422, 'voice_empty', '未听清可转写的文字，请重新录音或手动输入。');
  if (text.length > textOrderLimit) throw new HttpError(422, 'voice_too_long', '转写文字过长，请分段录音。');
  return text;
}

export function configuredSpeechModel(env: NodeJS.ProcessEnv): SpeechModel | undefined {
  const key = env.DISPATCH_TEXT_MODEL_KEY?.trim();
  if (!key) return undefined;
  return async wave => {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(wave)], { type: 'audio/wav' }), 'recording.wav');
    try {
      const response = await fetch('https://api.deepseek.com/v1/tools/asr', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
        headers: { Authorization: `Bearer ${key}` }, body: form,
      });
      if (!response.ok) throw new Error('provider_error');
      return await response.json();
    } catch {
      throw new HttpError(502, 'voice_model_failed', '语音转写暂未完成，可用原录音重试。');
    }
  };
}
