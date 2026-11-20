'use strict';
/**
 * ASR 工作线程：在独立线程加载 SenseVoice 模型并做识别，
 * 避免同步推理阻塞主进程（否则悬浮窗的字幕与流式输出会卡顿）。
 */
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

const { modelDir } = workerData;

let recognizer = null;

function build() {
  const sherpa = require('sherpa-onnx-node');
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: path.join(modelDir, 'model.int8.onnx'),
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  });
}

try {
  const t0 = Date.now();
  recognizer = build();
  parentPort.postMessage({ type: 'ready', loadMs: Date.now() - t0 });
} catch (e) {
  parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
}

parentPort.on('message', (msg) => {
  if (msg.type !== 'transcribe') return;
  if (!recognizer) {
    parentPort.postMessage({ type: 'result', id: msg.id, text: '', error: '模型未就绪' });
    return;
  }
  try {
    const samples = new Float32Array(msg.samples);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: msg.sampleRate || 16000 });
    recognizer.decode(stream);
    const r = recognizer.getResult(stream);
    parentPort.postMessage({
      type: 'result',
      id: msg.id,
      text: (r && r.text) || '',
      lang: (r && r.lang) || '',
      emotion: (r && r.emotion) || '',
    });
  } catch (e) {
    parentPort.postMessage({ type: 'result', id: msg.id, text: '', error: e.message });
  }
});
