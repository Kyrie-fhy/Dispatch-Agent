import { workspaceRequest } from './workspace';

export class VoicePermissionError extends Error {}
export class VoiceFileError extends Error {}

type Capture = {
  requested: boolean;
  started: boolean;
  stopping: boolean;
  cancelled: boolean;
  onStart: () => void;
  resolve: (path: string) => void;
  reject: (error: Error) => void;
};

let recorder: WechatMiniprogram.RecorderManager | undefined;
let active: Capture | undefined;
const interrupted = '录音已中断，请重新录音。';
const sampleRate = 16000;

function stopCapture(manager: WechatMiniprogram.RecorderManager, capture: Capture) {
  if (capture.stopping) return;
  capture.stopping = true;
  try { manager.stop(); }
  catch {
    active = undefined;
    capture.reject(new Error('无法结束录音，请重新录音。'));
  }
}

function cancelCapture(capture: Capture) {
  if (active !== capture || capture.cancelled) return;
  capture.cancelled = true;
  capture.reject(new Error(interrupted));
  if (capture.started && recorder) stopCapture(recorder, capture);
  if (!capture.requested) active = undefined;
}

function voiceRecorder() {
  if (recorder) return recorder;
  const manager = wx.getRecorderManager();
  manager.onStart(() => {
    if (!active) return;
    active.started = true;
    if (active.cancelled) stopCapture(manager, active);
    else active.onStart();
  });
  manager.onStop(({ tempFilePath, duration }) => {
    const capture = active;
    active = undefined;
    if (!capture || capture.cancelled) return;
    if (!tempFilePath || !(duration > 0)) capture.reject(new Error('录音为空，请重新录音。'));
    else capture.resolve(tempFilePath);
  });
  manager.onError(() => {
    const capture = active;
    active = undefined;
    capture?.reject(new Error('录音未完成，请检查麦克风后重试。'));
  });
  manager.onInterruptionBegin(() => {
    if (active) cancelCapture(active);
  });
  recorder = manager;
  return manager;
}

export function startVoiceRecording(onStart: () => void) {
  const manager = voiceRecorder();
  if (active) throw new Error('上一段录音正在结束，请稍后重试。');
  let capture!: Capture;
  const done = new Promise<string>((resolve, reject) => {
    capture = { requested: false, started: false, stopping: false, cancelled: false, onStart, resolve, reject };
    active = capture;
    wx.authorize({
      scope: 'scope.record',
      success: () => {
        if (active !== capture) return;
        capture.requested = true;
        try {
          manager.start({ duration: 60_000, format: 'PCM', numberOfChannels: 1, sampleRate, encodeBitRate: 48000 });
        } catch {
          active = undefined;
          reject(new Error('无法开始录音，请检查麦克风后重试。'));
        }
      },
      fail: () => {
        if (active !== capture) return;
        active = undefined;
        reject(new VoicePermissionError('请在微信设置中允许使用麦克风，或手动输入。'));
      },
    });
  });
  return {
    done,
    stop: () => { if (active === capture && capture.started && !capture.cancelled) stopCapture(manager, capture); },
    cancel: () => cancelCapture(capture),
  };
}

function waveFromPcm(pcm: ArrayBuffer) {
  const file = new ArrayBuffer(44 + pcm.byteLength);
  const bytes = new Uint8Array(file);
  const header = new DataView(file);
  for (const [offset, label] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']] as const) {
    for (let index = 0; index < label.length; index++) bytes[offset + index] = label.charCodeAt(index);
  }
  header.setUint32(4, file.byteLength - 8, true);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(40, pcm.byteLength, true);
  bytes.set(new Uint8Array(pcm), 44);
  return file;
}

export function readVoiceFile(path: string) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const fail = () => reject(new VoiceFileError('无法读取原录音，请重新录音。'));
    wx.getFileSystemManager().readFile({ filePath: path, fail, success: ({ data }) => {
      if (typeof data === 'string' || !data.byteLength || data.byteLength % 2) fail();
      else resolve(waveFromPcm(data));
    } });
  });
}

export function transcribeVoice(draft: { id: string; revision: number }, bytes: ArrayBuffer, token: string) {
  const wave = wx.arrayBufferToBase64(bytes);
  if (wave.length !== 4 * Math.ceil(bytes.byteLength / 3)) {
    throw new VoiceFileError('录音编码不完整，请重新录音。');
  }
  return workspaceRequest<{ draftId: string; revision: number; text: string }>(
    'POST', `/drafts/${draft.id}/transcription`, token, { wave },
    { 'X-Draft-Revision': String(draft.revision) }, 40_000);
}
