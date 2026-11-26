// Main-thread camera adapter for the 慢慢跑酷 motion check.
// Loads MediaPipe Tasks Vision + the Pose Landmarker Lite model from the official CDNs on first use
// (needs internet the first time; the browser caches them afterwards). No frames are recorded or uploaded.
import { MotionCore } from './core.js';
import { amplitudeConfig } from './amplitude.js';

const VER = '0.10.32';
const SDKS = [`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/vision_bundle.mjs`, `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/+esm`];
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/wasm`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export const TUNE_KEYS = { squat: ['squatOn', 'squatOff'], step: ['stepOn', 'armSwingOn', 'bobOn'], lean: ['sideOn', 'sideOff'], arms: ['armsOn'], reach: ['reachOn'] };
export function loadTune() { try { return Object.assign({ squat: 1, step: 1, lean: 1, arms: 1, reach: 1 }, JSON.parse(localStorage.getItem('mm_tune') || '{}')); } catch (e) { return { squat: 1, step: 1, lean: 1, arms: 1, reach: 1 }; } }
function saveTune(t) { try { localStorage.setItem('mm_tune', JSON.stringify(t)); } catch (e) {} }
function applyTune(c) { const t = loadTune(); for (const k in TUNE_KEYS) for (const f of TUNE_KEYS[k]) c[f] *= t[k]; return c; }

export class CameraLite {
  constructor({ onEvents, onStatus, onFrame, amplitude = 'medium', lowImpact = false } = {}) {
    this.onEvents = onEvents || (() => {}); this.onStatus = onStatus || (() => {}); this.onFrame = onFrame || (() => {});
    this.amplitude = amplitude; this.lowImpact = lowImpact;
    this.core = new MotionCore(this._config());
    this.active = false; this.stream = null; this.landmarker = null; this.video = null;
    this.metrics = { inferMs: 0, fps: 0, delegate: '' }; this._frames = []; this._lastVideoTime = -1;
  }
  _config() { return applyTune(amplitudeConfig(this.amplitude, { lowImpact: this.lowImpact })); }
  // 实测时现场调灵敏度：每类动作一个倍数（<1 更容易触发），存在本机，换关也保留
  setTune(t) { saveTune(t); this.core.configure(applyTune(this._baseConfig())); }
  _baseConfig() { return amplitudeConfig(this.amplitude, { lowImpact: this.lowImpact }); }
  setAmplitude(a) { this.amplitude = a; this.core = new MotionCore(this._config()); this._status('calibrating', '幅度已更换，请站好重新校准'); }
  setLowImpact(v) { this.lowImpact = v; this.core.configure({ lowImpact: v }); }
  recalibrate() { this.core.reset(); this._status('calibrating', '请全身入镜，自然站稳约 1.5 秒'); }
  _status(status, message) { this.onStatus({ status, message, ...this.core.snapshot(), status2: status }); }

  async start(video) {
    if (this.active) return;
    this.video = video;
    this._status('loading', '正在请求摄像头权限……');
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    video.srcObject = this.stream; video.muted = true; video.playsInline = true; await video.play();
    this._status('loading', '正在载入姿态识别模型（第一次需要联网，约几秒）……');
    try { await this._load(); } catch (e) { this.stop(); throw e; }
    this.active = true; this.recalibrate(); this._loop();
  }
  async _load() {
    if (!this.landmarker) {
      let mod = null, lastErr = null;
      for (const url of SDKS) { try { mod = await import(url); break; } catch (e) { lastErr = e; } }
      if (!mod) throw lastErr;
      const { FilesetResolver, PoseLandmarker } = mod;
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numPoses: 2,
        minPoseDetectionConfidence: 0.6, minPosePresenceConfidence: 0.6, minTrackingConfidence: 0.6, outputSegmentationMasks: false,
      });
      try { this.landmarker = await make('GPU'); this.metrics.delegate = 'GPU'; }
      catch (e) { this.landmarker = await make('CPU'); this.metrics.delegate = 'CPU'; }
    }
  }
  _loop() {
    if (!this.active) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this._lastVideoTime) {
      this._lastVideoTime = v.currentTime;
      const t = performance.now();
      let lm = null;
      try { const r = this.landmarker.detectForVideo(v, t); lm = this._pick(r.landmarks || [], t); }
      catch (e) { this._status('error', '识别出错：' + e.message); }
      const t1 = performance.now();
      this.metrics.inferMs = this.metrics.inferMs * 0.8 + (t1 - t) * 0.2;
      this._frames.push(t1); while (this._frames.length && t1 - this._frames[0] > 1000) this._frames.shift();
      this.metrics.fps = this._frames.length;
      const events = this.core.process(lm, t);
      const snap = this.core.snapshot();
      if (events.length) this.onEvents(events, snap, t1);
      this.onFrame(lm, snap, this.metrics);
    }
    requestAnimationFrame(() => this._loop());
  }
  // Player lock: when several people are in view, keep following the same one.
  // The first player is the person nearest the camera (biggest torso); after that we follow whoever is closest
  // to where the player just was. Only if the player has been gone for 2 s do we pick someone new.
  _pick(list, t) {
    if (!list.length) return null;
    const info = p => { const hx = (p[23].x + p[24].x) / 2, hy = (p[23].y + p[24].y) / 2, sx = (p[11].x + p[12].x) / 2, sy = (p[11].y + p[12].y) / 2; return { x: (hx + sx) / 2, y: (hy + sy) / 2, size: Math.hypot(hx - sx, hy - sy) }; };
    const all = list.map(p => ({ p, ...info(p) }));
    let best = null;
    if (this._lock && t - this._lock.t < 2000) {
      let d = Infinity;
      for (const c of all) { const dd = Math.hypot(c.x - this._lock.x, c.y - this._lock.y); if (dd < d) { d = dd; best = c; } }
      if (d > Math.max(0.12, this._lock.size * 0.9)) best = null; // nobody near where the player was: treat as player out of frame
    } else best = all.reduce((a, b) => (b.size > a.size ? b : a));
    if (!best) return null;
    this._lock = { x: best.x, y: best.y, size: best.size, t };
    this.metrics.people = list.length;
    return best.p;
  }
  stop() {
    this.active = false;
    if (this.stream) this.stream.getTracks().forEach(tr => tr.stop());
    this.stream = null; if (this.video) this.video.srcObject = null;
    this._status('stopped', '摄像头已关闭');
  }
}
