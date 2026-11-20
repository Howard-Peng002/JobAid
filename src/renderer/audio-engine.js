'use strict';
/**
 * 单路音频采集 + 能量 VAD 自动断句
 * ---------------------------------
 * 把一条 MediaStream 切成「一句话」粒度，每句话回调一次。
 * 断句靠自适应噪声门 + 静音挂起，不需要任何网络服务。
 */

const TARGET_RATE = 16000;

function resampleLinear(input, from, to) {
  if (from === to) return input;
  const ratio = to / from;
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

class VoiceCapture {
  /**
   * @param {object} opt
   * @param {string} opt.channel  'interviewer' | 'me'
   * @param {MediaStream} opt.stream
   * @param {(channel:string, samples:Float32Array, sampleRate:number)=>void} opt.onUtterance
   * @param {(level:number)=>void} [opt.onLevel]
   * @param {(msg:string)=>void} [opt.onError]
   */
  constructor({ channel, stream, onUtterance, onLevel, onError }) {
    this.channel = channel;
    this.stream = stream;
    this.onUtterance = onUtterance;
    this.onLevel = onLevel || (() => {});
    this.onError = onError || (() => {});
    this.stopped = false;

    this.ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
    this.source = this.ctx.createMediaStreamSource(stream);
    this.proc = this.ctx.createScriptProcessor(1024, 1, 1);

    // --- VAD 状态 ---
    this.frameMs = 0; // 根据实际采样率计算
    this.noiseFloor = 0.0025;
    this.preroll = [];
    this.prerollMax = 6; // 约 380ms
    this.speaking = false;
    this.buf = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.voicedRun = 0;

    this.MIN_SPEECH_MS = 320;
    // 说话中间的标点停顿通常在 400~800ms，640ms 会把一句话切成两半，
    // 导致"前半句背景 + 后半句问句"被拆开、判定不到提问。放到 880ms。
    this.SILENCE_END_MS = 620;
    this.MAX_UTTER_MS = 20000;

    this.proc.onaudioprocess = (e) => this._onFrame(e.inputBuffer.getChannelData(0));

    this.source.connect(this.proc);
    // 必须接到 destination 才会被驱动；用 0 增益避免回授啸叫
    this.silent = this.ctx.createGain();
    this.silent.gain.value = 0;
    this.proc.connect(this.silent);
    this.silent.connect(this.ctx.destination);
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  _onFrame(chunkRaw) {
    if (this.stopped) return;
    // 注意：ScriptProcessor 的 inputBuffer 是复用的，必须拷贝一份再留存，
    // 否则所有帧都会指向同一块内存，最终只剩最后一帧的内容。
    const chunk = new Float32Array(chunkRaw);
    const n = chunk.length;
    const rate = this.ctx.sampleRate;
    this.frameMs = (n / rate) * 1000;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / n);

    // 电平：映射到 0~1，便于 UI 显示
    const level = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 60) / 60));
    this.onLevel(level);

    const threshold = Math.max(this.noiseFloor * 3.0, 0.0055);
    const isVoiced = rms > threshold;

    if (!this.speaking) {
      // 噪声底噪自适应（只在不说话时更新）
      this.noiseFloor = this.noiseFloor * 0.97 + rms * 0.03;
      this.preroll.push(chunk);
      if (this.preroll.length > this.prerollMax) this.preroll.shift();

      if (isVoiced) {
        this.voicedRun++;
        if (this.voicedRun >= 2) {
          this.speaking = true;
          this.buf = this.preroll.slice();
          this.preroll = [];
          this.speechMs = this.voicedRun * this.frameMs;
          this.silenceMs = 0;
        }
      } else {
        this.voicedRun = 0;
      }
      return;
    }

    // 说话中
    this.buf.push(chunk);
    if (isVoiced) {
      this.speechMs += this.frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.frameMs;
    }

    const totalMs = this.buf.length * this.frameMs;
    if (this.silenceMs >= this.SILENCE_END_MS || totalMs >= this.MAX_UTTER_MS) {
      this._finish();
    }
  }

  _finish() {
    const segs = this.buf;
    this.buf = [];
    const speechMs = this.speechMs;
    this.speaking = false;
    this.voicedRun = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.preroll = [];

    if (speechMs < this.MIN_SPEECH_MS) return;

    let total = 0;
    segs.forEach((s) => (total += s.length));
    const merged = new Float32Array(total);
    let off = 0;
    segs.forEach((s) => {
      merged.set(s, off);
      off += s.length;
    });

    const out = resampleLinear(merged, this.ctx.sampleRate, TARGET_RATE);
    if (out.length < TARGET_RATE * 0.25) return;
    try {
      this.onUtterance(this.channel, out, TARGET_RATE);
    } catch (e) {
      this.onError(e.message);
    }
  }

  stop() {
    this.stopped = true;
    try {
      this.proc.onaudioprocess = null;
      this.source.disconnect();
      this.proc.disconnect();
      this.silent.disconnect();
      this.ctx.close();
    } catch (_) {}
    try {
      this.stream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
  }
}

window.VoiceCapture = VoiceCapture;
