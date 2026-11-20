'use strict';
/**
 * 本地语音识别服务（离线，无需联网、无需 API Key）。
 * 模型：SenseVoice-Small（中英日韩粤），中文准确率高，CPU 上约 15x 实时速度。
 */
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

class AsrService {
  constructor(modelDir) {
    this.modelDir = modelDir;
    this.worker = null;
    this.ready = false;
    this.loadMs = 0;
    this.error = null;
    this.seq = 0;
    this.pending = new Map();
    this.queue = []; // 就绪前的待处理请求
    this._readyResolvers = [];
  }

  modelExists() {
    return (
      fs.existsSync(path.join(this.modelDir, 'model.int8.onnx')) &&
      fs.existsSync(path.join(this.modelDir, 'tokens.txt'))
    );
  }

  start() {
    if (this.worker) return this.waitReady();
    if (!this.modelExists()) {
      this.error = '未找到语音模型文件（models/model.int8.onnx）';
      return Promise.reject(new Error(this.error));
    }
    this.worker = new Worker(path.join(__dirname, 'asr-worker.js'), {
      workerData: { modelDir: this.modelDir },
    });

    this.worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        this.ready = true;
        this.loadMs = msg.loadMs;
        this._readyResolvers.forEach((r) => r());
        this._readyResolvers = [];
        this.queue.splice(0).forEach((fn) => fn());
      } else if (msg.type === 'error') {
        this.error = msg.message;
        this._readyResolvers.forEach((r) => r());
        this._readyResolvers = [];
      } else if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p(msg);
        }
      }
    });

    this.worker.on('error', (e) => {
      this.error = e.message;
    });

    return this.waitReady();
  }

  waitReady() {
    if (this.ready || this.error) return Promise.resolve();
    return new Promise((resolve) => this._readyResolvers.push(resolve));
  }

  /** @param {Float32Array} samples @param {number} sampleRate */
  transcribe(samples, sampleRate) {
    if (!this.worker) return Promise.reject(new Error('ASR 未启动'));
    if (this.error) return Promise.reject(new Error(this.error));

    const run = () => {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, (msg) => {
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg);
        });
        this.worker.postMessage(
          { type: 'transcribe', id, samples: samples.buffer, sampleRate },
          [samples.buffer]
        );
      });
    };

    if (!this.ready) return new Promise((res) => this.queue.push(res)).then(run);
    return run();
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
  }
}

module.exports = AsrService;
