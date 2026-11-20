const path = require('path');
const sherpa = require('sherpa-onnx-node');

const file = process.argv[2] || path.join(__dirname, '..', 'models', 'test_zh.wav');
const dir = path.join(__dirname, '..', 'models');

const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: path.join(dir, 'model.int8.onnx'), language: 'zh', useInverseTextNormalization: 1 },
    tokens: path.join(dir, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
});

const wave = sherpa.readWave(file);
const s = wave.samples;
let peak = 0;
for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]));
const win = 8000;
const out = [];
for (let i = 0; i + win <= s.length; i += win) {
  let sum = 0;
  for (let j = 0; j < win; j++) sum += s[i + j] * s[i + j];
  out.push(Math.sqrt(sum / win).toFixed(4));
}
console.log('文件:', file);
console.log('样点:', s.length, '@', wave.sampleRate, '峰值:', peak.toFixed(4));
console.log('每 0.5s RMS:', out.join(' '));

const stream = recognizer.createStream();
stream.acceptWaveform({ samples: s, sampleRate: wave.sampleRate });
recognizer.decode(stream);
const r = recognizer.getResult(stream);
console.log('识别:', JSON.stringify(r.text));
