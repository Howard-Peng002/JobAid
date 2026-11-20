const path = require('path');
const sherpa = require('sherpa-onnx-node');

const dir = path.join(__dirname, '..', 'models');
const t0 = Date.now();

const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: {
      model: path.join(dir, 'model.int8.onnx'),
      language: 'auto',
      useInverseTextNormalization: 1,
    },
    tokens: path.join(dir, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
});
console.log('LOAD OK in', Date.now() - t0, 'ms');

const wave = sherpa.readWave(path.join(dir, 'test_zh.wav'));
console.log('wav:', wave.samples.length, 'samples @', wave.sampleRate);

const t1 = Date.now();
const stream = recognizer.createStream();
stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
recognizer.decode(stream);
const r = recognizer.getResult(stream);
console.log('DECODE in', Date.now() - t1, 'ms');
console.log('TEXT:', JSON.stringify(r.text));
console.log('lang:', r.lang, 'emotion:', r.emotion, 'event:', r.event);
