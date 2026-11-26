// ---- 全局音量（v103，真人测试：投屏到电视声音太小）----
// 所有页面的音效都从这里过：先放大 MM_SFX_GAIN 倍，再经过一个压限器，防止大声时破音；背景音乐（<audio>）的音量统一乘 MM_MUSIC_GAIN（最多到 1）。
// 各关原来的音量比例都不变，只是整体变响。
(function () {
  const SFX_GAIN = 2.2, MUSIC_GAIN = 1.7;
  window.MM_SFX_GAIN = SFX_GAIN; window.MM_MUSIC_GAIN = MUSIC_GAIN;
  if (window.AudioNode && window.AudioDestinationNode) {
    const orig = AudioNode.prototype.connect, masters = new WeakMap();
    const master = ctx => { let m = masters.get(ctx); if (m) return m;
      const g = ctx.createGain(), c = ctx.createDynamicsCompressor(); g.gain.value = SFX_GAIN;
      c.threshold.value = -10; c.knee.value = 6; c.ratio.value = 8; c.attack.value = 0.003; c.release.value = 0.18;
      orig.call(g, c); orig.call(c, ctx.destination); masters.set(ctx, g); return g; };
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (dest instanceof AudioDestinationNode && this.context === dest.context) return orig.call(this, master(this.context), ...rest);
      return orig.call(this, dest, ...rest);
    };
  }
  const d = window.HTMLMediaElement && Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (d && d.set) Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true,
    get() { return d.get.call(this) / MUSIC_GAIN; }, set(v) { d.set.call(this, Math.max(0, Math.min(1, v * MUSIC_GAIN))); } });
})();
// 慢慢谷共享存档：纪念品、今日运动时长、强度档位、是否学过动作。所有页面共用（同一来源的 localStorage）。
(function () {
  const KEY = 'manman.valley.v1';
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const blank = () => ({ tier: 'standard', tutorialDone: false, puffs: 0, apples: 0, feathers: 0, letters: 0, drops: 0, bread: 0,
    visits: { level1: 0, lake: 0, guide: 0 }, done: { level1: 0, lake: 0, guide: 0 }, creatures: 0, day: today(), daySec: 0, totalSec: 0, lastLevel: '' });
  let D = blank(), ok = true;
  // always re-read before changing anything: the shell and the framed page each hold a copy
  const fresh = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); D = v ? Object.assign(blank(), v) : blank(); } catch (e) { ok = false; } if (D.day !== today()) { D.day = today(); D.daySec = 0; D.todayDone = []; } };
  fresh();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(D)); return true; } catch (e) { ok = false; return false; } };
  let pending = 0;
  const logEv = (ev, lv, extra) => { const L = D.log || (D.log = []); L.push(Object.assign({ t: Date.now(), ev, lv, tier: D.tier, daySec: Math.round(D.daySec) }, extra || {})); if (L.length > 400) L.splice(0, L.length - 400); };
  const TIERS = {
    gentle: { name: '轻松', note: '动作幅度小，用抬双臂代替跳，节奏慢一些', amplitude: 'small', lowImpact: true },
    standard: { name: '标准', note: '成年人日常活动', amplitude: 'medium', lowImpact: false },
    lively: { name: '活力', note: '更快、蹲得更多、举得更久，适合想出汗的人', amplitude: 'medium', lowImpact: false },
  };
  window.VALLEY = {
    get data() { return D; }, get tier() { return D.tier; }, reload: fresh, TIERS, get storageOk() { return ok; },
    setTier(t) { if (TIERS[t]) { fresh(); D.tier = t; save(); try { parent.VALLEY_SHELL && parent.VALLEY_SHELL.applyTier(); } catch (e) {} } },
    setTutorialDone(v) { fresh(); D.tutorialDone = v; save(); },
    // seconds of actual movement-play, flushed every few seconds
    addActive(sec) { pending += sec; if (pending >= 3) { fresh(); D.daySec += pending; D.totalSec += pending; pending = 0; save(); } },
    flush() { if (pending > 0) { fresh(); D.daySec += pending; D.totalSec += pending; pending = 0; save(); } },
    finish(level, gains) { this.flush(); fresh(); D.moonDue = true; D.feelAsk = level; (D.todayDone = D.todayDone || []).push(level); logEv('finish', level); D.done[level] = (D.done[level] || 0) + 1; for (const k in gains) D[k] = (D[k] || 0) + gains[k]; D.lastLevel = level; save(); },
    mark(k, v) { fresh(); D[k] = v; save(); },
    visit(level) { fresh(); D.visits[level] = (D.visits[level] || 0) + 1; logEv('start', level); save(); },
    // local play log (never leaves the device): start / finish / feel, for later analysis. 'start' with no 'finish' = left midway
    log(ev, level, extra) { fresh(); logEv(ev, level, extra); save(); },
    get today() { return D.day; },
    // go to another page; inside the shell the camera keeps running
    moonDone() { fresh(); D.moonDue = false; (D.todayDone = D.todayDone || []).push('moon'); logEv('finish', 'moon'); save(); },
    go(page) { this.flush();  try { if (window.parent !== window && parent.VALLEY_SHELL) { parent.VALLEY_SHELL.load(page); return; } } catch (e) {} location.href = page + '.html'; },
  };
  addEventListener('pagehide', () => window.VALLEY.flush());
  addEventListener('keydown', e => { if (e.key === '`' && !e.repeat) { try { parent !== window && parent.VALLEY_SHELL && parent.VALLEY_SHELL.togglePanel(); } catch (x) {} } });   // v150：调试栏改用 ` 键（D 是举右手）
})();
// 电视字号下限：游戏在 2–3 米外看，画布上小于 22px 的字统一往上抬一些（13→17.5，16→19），大字不变。
(function () {
  try {
    const P = CanvasRenderingContext2D.prototype, d = Object.getOwnPropertyDescriptor(P, 'font');
    Object.defineProperty(P, 'font', { configurable: true, get() { return d.get.call(this); },
      set(v) { d.set.call(this, String(v).replace(/(\d+(?:\.\d+)?)px/, (m, n) => { n = +n; return (n < 22 ? n + (22 - n) * 0.5 : n) + 'px'; })); } });
  } catch (e) {}
})();
