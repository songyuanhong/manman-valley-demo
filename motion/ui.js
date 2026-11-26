// 体感摸底面板：开摄像头、校准、实时显示识别到的动作，并把动作接到游戏。
import { CameraLite, loadTune } from './camera-lite.js';
import { DEFAULT_CONFIG } from './core.js';

const $ = (id) => document.getElementById(id);
const G = () => { try { const f = document.getElementById('game'); const g = f && f.contentWindow && f.contentWindow.GAME; return g || window.GAME; } catch (e) { return window.GAME; } };
const tierCfg = () => (window.VALLEY && VALLEY.TIERS[VALLEY.tier]) || { amplitude: 'medium', lowImpact: false };
const ACTIONS = [
  ['runStep', '走一步', '原地走路或小跑，手臂自然摆'],
  ['runStop', '停下', '停下来约 1 秒'],
  ['jump', '跳', '双脚一起轻轻离地（踮一下也算）；单脚抬起不算'],
  ['squatStart', '蹲', '微蹲，屁股往下坐一点'],
  ['reach', '举手', '举起一只手到头旁边，另一只手放下'],
  ['waveLeft', '左手挥', '举起左手左右挥动 = 选择往左'],
  ['waveRight', '右手挥', '举起右手左右挥动 = 选择往右'],
  ['armsUp', '双臂上举', '两只手一起举过肩，保持 1 秒 = 开始 / 继续'],
  ['crossStart', '交叉双臂', '小臂在胸前交叉成 X，保持 = 暂停；暂停中再保持 2 秒 = 结束'],
];
const counts = Object.fromEntries(ACTIONS.map(a => [a[0], 0]));
const stepTimes = [];
let cam = null, pausedByCamera = false, motionDrive = false, forceFull = false;

function buildPanel() {
  const rows = ACTIONS.map(([k, name, how]) => `<tr><td><b>${name}</b><div class="how">${how}</div></td><td class="cnt" id="c_${k}">0</td></tr>`).join('');
  $('mpanel').innerHTML = `
    <div class="ttl">体感 <span id="mstate" class="pill">未开启</span><button id="mclose">收起</button></div>
    <div class="row"><button id="mstart">开启摄像头</button><button id="mcal" disabled>重新校准</button><button id="mstop" disabled>关闭</button><button id="mrec">录 12 秒动作</button></div>
    <div class="row small">动作幅度 <select id="mamp"><option value="small">小</option><option value="medium">标准</option><option value="large">大</option></select>
      <label><input type="checkbox" id="mlow"> 低冲击（抬双臂=跳）</label></div>
    <div class="row small" id="mtier"></div>
    <div class="tune" id="mtune"></div>
    <div class="vid"><video id="mvideo" playsinline muted></video><canvas id="mskel" width="320" height="240"></canvas>
      <div id="mcalbar"><div></div></div></div>
    <div id="mmsg" class="msg">站到离屏幕 2–3 米处，全身入镜，再点「开启摄像头」。画面只在本机处理，不录制、不上传。</div>
    <div class="metrics" id="mmet"></div>
    <table class="acts">${rows}</table>
    <div class="feat" id="mfeat"></div>
    <div class="log" id="mlog"></div>
    <div class="tip">自检：每个动作各做 5 次，看右边数字是否正好 +5；做别的动作时它不该跳数字。识别开始后面板会缩成右下角的小画面，按 <b>D</b> 切回完整面板，<b>0</b> 清零计数。</div>`;
  $('mclose').onclick = () => document.body.classList.add('nopanel');
  syncTier(); addEventListener('tierchange', syncTier);
  $('mrec').onclick = recStart;
  $('mstart').onclick = startCam; $('mcal').onclick = () => cam && cam.recalibrate();
  $('mstop').onclick = () => { document.body.classList.remove('staging', 'lostcard'); if (cam) cam.stop(); motionDrive = false; if (G()) { G().input.slow = false; G().gesture.armsUp = G().gesture.cross = false; } setBtns(false); };
  $('mamp').onchange = e => cam && cam.setAmplitude(e.target.value);
  $('mlow').onchange = e => cam && cam.setLowImpact(e.target.checked);
}
function syncTier() {
  const t = tierCfg(); $('mamp').value = t.amplitude; $('mlow').checked = t.lowImpact;
  if (window.VALLEY) $('mtier').textContent = `强度「${t.name}」：已按这个档位设好幅度和低冲击，可以手动改。`;
  if (cam) { cam.setAmplitude(t.amplitude); cam.setLowImpact(t.lowImpact); }
}
function setBtns(on) { $('mstart').disabled = on; $('mcal').disabled = !on; $('mstop').disabled = !on; }
function log(text) { const el = $('mlog'); const d = document.createElement('div'); d.textContent = text; el.prepend(d); while (el.childNodes.length > 8) el.lastChild.remove(); }

async function startCam() {
  forceFull = false; everTracked = false; document.body.classList.add('staging'); drawFelt($('mfelt'), null, true);
  cam = new CameraLite({ amplitude: $('mamp').value, lowImpact: $('mlow').checked, onEvents, onStatus, onFrame });
  setBtns(true);
  try { await cam.start($('mvideo')); }
  catch (e) {
    setBtns(false); document.body.classList.remove('staging');
    const m = e && e.name === 'NotAllowedError' ? '没有拿到摄像头权限。可以在地址栏左侧的摄像头图标里允许，或继续用键盘玩。'
      : '摄像头或模型没能启动：' + (e && e.message || e) + '（第一次需要联网下载模型）。键盘照常可玩。';
    $('mmsg').textContent = m; $('mstate').textContent = '未开启';
  }
}
function onStatus(s) {
  const map = { loading: '载入中', calibrating: '校准中', tracking: '识别中', lost: '看不到你', stopped: '已关闭', error: '出错' };
  $('mstate').textContent = map[s.status] || s.status;
  $('mstate').className = 'pill ' + s.status;
  if (s.message) $('mmsg').textContent = s.message;
}
function onEvents(events, snap, now) {
  const g = G();
  for (const e of events) {
    if (REC.on) REC.events.push({ t: Math.round(performance.now() - REC.t0), type: e.type });
    if (counts[e.type] != null) { counts[e.type]++; $('c_' + e.type).textContent = counts[e.type]; flashCell(e.type); }
    log(`${(now / 1000).toFixed(1)}s  ${label(e.type)}`);
    if (!g) continue;
    if (g.onMotion) g.onMotion(e.type);
    if (e.type === 'jump' && g.S.mode === 'play' && !g.S.paused && g.pressJump) g.pressJump();
    if (e.type === 'squatStart' && g.input) g.input.duck = true;
    if (e.type === 'squatEnd' && g.input) g.input.duck = false;
    if (e.type === 'reach' && g.S.mode === 'play' && g.pressReach) g.pressReach();
    if (e.type === 'runStart') motionDrive = true;
    if (e.type === 'runStep') stepTimes.push(performance.now());
    if (e.type === 'runStep') HL.legs = 6; if (/reach|armsUp|wave|cross/.test(e.type)) HL.arms = 10; if (/squat|jump|lean/.test(e.type)) HL.body = 10;
  }
}
function label(t) { const a = ACTIONS.find(x => x[0] === t); return a ? a[1] : { runStart: '开始跑', squatEnd: '站起', armsDown: '放下双臂', leanLeft: '左倾', leanRight: '右倾', leanCenter: '回正', dodgeLeft: '左闪', dodgeRight: '右闪' }[t] || t; }
function flashCell(k) { const el = $('c_' + k); el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); }

let lastStatus = '';
let lastFrameAt = 0, restarting = false;
// ---- 动作记录：录 12 秒的关节坐标（只有坐标，没有画面），存成文件发给开发者，用真实数据来调识别 ----
const REC = { on: false, t0: 0, frames: [], events: [] };
function recStart() {
  if (REC.on || REC.wait || !cam) { if (!cam) $('mmsg').textContent = '先点「开启摄像头」，再录动作。'; return; }
  const b = $('mrec'), say = t => { document.body.classList.add('recnote'); $('mrecnote').textContent = t; };
  let left = 6 + 12; REC.wait = true; b.disabled = true;
  const iv = setInterval(() => {
    left--;
    if (left > 12) { b.textContent = `${left - 12} 秒后开始`; say(`${left - 12} 秒后开始记录，请回到位置站好`); }
    else if (left === 12) { REC.on = true; REC.t0 = performance.now(); REC.frames = []; REC.events = []; say('开始！像平时那样原地走路'); }
    else if (left > 6) { b.textContent = `正在录… ${left}`; say(`原地走路…… ${left - 6}`); }
    else if (left > 0) { b.textContent = `正在录… ${left}`; say(`现在原地小跑…… ${left}`); }
    else { clearInterval(iv); REC.wait = false; recStop(); }
  }, 1000);
  b.textContent = '6 秒后开始'; say('6 秒后开始记录，请回到位置站好');
}
function recStop() {
  REC.on = false; const b = $('mrec'); b.disabled = false; b.textContent = '录 12 秒动作'; document.body.classList.remove('recnote');
  const data = { v: 61, when: new Date().toISOString(), ua: navigator.userAgent, config: cam ? cam.core.config : null, frames: REC.frames, events: REC.events };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })); a.download = '慢慢谷_动作记录.json'; document.body.appendChild(a); a.click(); a.remove();
  $('mmsg').textContent = '已保存「慢慢谷_动作记录.json」（在下载文件夹里），把它发给 Claude。';
}
function onFrame(lm, snap, met) {
  lastFrameAt = performance.now();
  if (REC.on) { const r3 = v => Math.round(v * 1000) / 1000, f = snap.features || {};
    REC.frames.push({ t: Math.round(performance.now() - REC.t0), st: snap.status, fps: met.fps, ms: Math.round(met.inferMs), run: !!snap.running,
      f: { liftL: f.liftL, liftR: f.liftR, arm: f.armSwing, bob: f.bob, src: f.walkSrc },
      lm: lm ? lm.map(q => [r3(q.x), r3(q.y), r3(q.z || 0), Math.round((q.visibility ?? 1) * 100) / 100]) : null }); }
  const g = G();
  // status messages + pause when the player leaves the frame
  if (snap.status !== lastStatus) {
    lastStatus = snap.status;
    onStatus({ status: snap.status, message: snap.status === 'calibrating' ? '请全身入镜，自然站稳约 1.5 秒' : snap.status === 'tracking' ? '识别中。举起双臂 1 秒开始；原地走路或小跑就往前，停下就慢慢走；交叉双臂暂停。' : snap.status === 'lost' ? '看不到你了，游戏已暂停。回到画面里会继续。' : '' });
    if (g && g.S) {
      if (snap.status === 'lost' && g.S.mode === 'play' && !g.S.paused) { g.S.paused = true; pausedByCamera = true; }
      if (snap.status === 'tracking' && pausedByCamera) { g.S.paused = false; pausedByCamera = false; }
    }
  }
  // while playing, the panel shrinks to a small camera thumbnail so the game fills the TV (D shows the full panel)
  document.body.classList.toggle('compact', !forceFull && (snap.status === 'tracking' || everTracked));
  // stepping drives speed: not stepping = slow walk (after the player has started stepping once)
  if (g && g.input && motionDrive && snap.status === 'tracking' && g.S.mode === 'play') g.input.slow = !snap.running;
  if (g) { const ok = snap.status === 'tracking'; g.gesture.armsUp = ok && snap.armsUp; g.gesture.cross = ok && snap.cross; const f = snap.features || {}, ah = f.armsHeight; g.gesture.armLevel = ok && ah != null ? Math.max(0, Math.min(1, (ah + 0.5) / 1.3)) : 0;
    // continuous signals: squat depth (0..1), sideways lean (-1 left … 1 right), stepping, calibrated
    g.gesture.squatDepth = ok && f.hipDrop != null ? Math.max(0, Math.min(1, (f.hipDrop - 0.08) / 0.34)) : 0;
    g.gesture.lean = ok && f.sideOffset != null ? Math.max(-1, Math.min(1, f.sideOffset / 0.26)) : 0;   // v126 更灵敏
    { const cf = cam ? cam.core.config : DEFAULT_CONFIG;   // 第三关：双臂张开程度 0–1，最近一次挥手掉头用了多少毫秒
      g.gesture.spread = ok ? Math.max(0, Math.min(1, ((f.spread || 0) - cf.spreadMin) / (cf.spreadMax - cf.spreadMin))) : 0;
      g.gesture.swingMs = ok && f.swingMs && performance.now() - (f.swingAt || 0) < 1200 ? f.swingMs : 0; }
    g.gesture.liftL = ok ? f.liftL || 0 : 0; g.gesture.liftR = ok ? f.liftR || 0 : 0;   // 第四关：左右腿各抬起多少（躯干长度为单位），单脚站用
    const now = performance.now(); while (stepTimes.length && now - stepTimes[0] > 2000) stepTimes.shift();
    g.gesture.stepRate = ok ? stepTimes.length / 2 : 0; g.gesture.lm = ok ? lm : null;
    g.gesture.running = ok && snap.running; g.gesture.ready = ok && snap.calibrated; g.gesture.camera = true; }
  $('mcalbar').firstChild.style.width = (snap.calibrated ? 100 : snap.calibrationProgress * 100) + '%';
  $('mcalbar').style.display = snap.calibrated ? 'none' : 'block';
  $('mmet').textContent = `识别 ${met.fps} 帧/秒 · 每帧 ${met.inferMs.toFixed(0)} 毫秒 · ${met.delegate}${snap.running ? ' · 正在走（' + ({legs: '看腿', arms: '看摆臂', bob: '看起伏'}[(snap.features || {}).walkSrc] || '') + '）' : ''}${snap.squat ? ' · 蹲着' : ''}`;
  stageUpdate(lm, snap);
  drawSkeleton(lm);
  drawFeatures(snap.features);
}
// ---- 毛毡小人：把识别到的身体画成圆滚滚的羊毛毡人偶（代替火柴人），和游戏画风一致 ----
const HL = { arms: 0, legs: 0, body: 0 };      // 动作被认到时，对应部位亮一下
const FELT = { base: '#ecdcbf', edge: '#c9ae84', stitch: 'rgba(150,112,72,.7)', on: '#bcd494' };
const REST = { 0: [.5, .2], 11: [.42, .34], 12: [.58, .34], 13: [.38, .48], 14: [.62, .48], 15: [.37, .61], 16: [.63, .61], 23: [.45, .62], 24: [.55, .62], 25: [.45, .78], 26: [.55, .78], 27: [.45, .93], 28: [.55, .93] };
function drawFelt(cvs, lm, ghost) {
  // 小满的毛毡人偶：棕色卷发、鼠尾草绿上衣、奶油色裤子、棕色靴子。细一点的四肢，大一点的头。
  const c = cvs.getContext('2d'), w = cvs.width, h = cvs.height; c.clearRect(0, 0, w, h);
  const P = i => { const p = lm && lm[i] && (lm[i].visibility ?? 1) > 0.35 ? [1 - lm[i].x, lm[i].y] : (lm ? null : REST[i]); return p && [p[0] * w, p[1] * h]; };
  const sh = P(11) && P(12) ? Math.hypot(P(11)[0] - P(12)[0], P(11)[1] - P(12)[1]) : w * 0.16, T = Math.max(8, sh * 0.3);
  const C = { skin: '#f6dcc0', tunic: '#9db577', tunicE: '#7f9a5c', pants: '#f3e8d0', pantsE: '#d3c19e', boot: '#8a5a3c', hair: '#7a4a2c', hairE: '#5f3820', cuff: '#f7efdf', on: '#ffe7a8' };
  c.lineCap = c.lineJoin = 'round'; c.globalAlpha = ghost ? 0.5 : 1;
  const seg = (a, b, th, col, edge) => { const p = P(a), q = P(b); if (!p || !q) return false; for (const [lw, cl] of [[th + 5, edge], [th, col]]) { c.strokeStyle = cl; c.lineWidth = lw; c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke(); } return true; };
  const ball = (i, r, col, edge) => { const p = P(i); if (!p) return; c.fillStyle = col; c.strokeStyle = edge; c.lineWidth = 2.5; c.beginPath(); c.arc(p[0], p[1], r, 0, 6.3); c.fill(); c.stroke(); };
  const glow = k => HL[k] > 0;
  // 腿 + 靴子
  for (const [a, b, d] of [[23, 25, 27], [24, 26, 28]]) { seg(a, b, T, glow('legs') ? C.on : C.pants, C.pantsE); seg(b, d, T * 0.92, glow('legs') ? C.on : C.pants, C.pantsE);
    const f = P(d); if (f) { c.fillStyle = C.boot; c.strokeStyle = '#6b4329'; c.lineWidth = 2.5; c.beginPath(); c.ellipse(f[0], f[1] + T * 0.1, T * 0.85, T * 0.6, 0, 0, 6.3); c.fill(); c.stroke(); } }
  // 上衣：肩到髋的圆角梯形，下摆略宽，奶油色下摆边
  const a = P(11), b = P(12), d = P(23), e = P(24);
  if (a && b && d && e) { const L = a[0] < b[0] ? [a, b, e, d] : [b, a, d, e], k = 0.22, hem = [[L[3][0] - sh * k, L[3][1] + T * 0.5], [L[2][0] + sh * k, L[2][1] + T * 0.5]];
    const path = () => { c.beginPath(); c.moveTo(L[0][0], L[0][1]); c.lineTo(L[1][0], L[1][1]); c.lineTo(hem[1][0], hem[1][1]); c.lineTo(hem[0][0], hem[0][1]); c.closePath(); };
    path(); c.lineWidth = T * 1.5 + 5; c.strokeStyle = C.tunicE; c.stroke(); path(); c.lineWidth = T * 1.5; c.strokeStyle = glow('body') ? '#b9d08f' : C.tunic; c.fillStyle = c.strokeStyle; c.stroke(); c.fill();
    c.strokeStyle = C.cuff; c.lineWidth = T * 0.45; c.beginPath(); c.moveTo(hem[0][0] - T * 0.5, hem[0][1] + T * 0.55); c.lineTo(hem[1][0] + T * 0.5, hem[1][1] + T * 0.55); c.stroke();
    // 斜挎包带
    c.strokeStyle = '#a06a3c'; c.lineWidth = T * 0.28; c.beginPath(); c.moveTo(L[1][0], L[1][1] - T * 0.4); c.lineTo(hem[0][0], hem[0][1]); c.stroke(); c.fillStyle = '#b97b45'; c.strokeStyle = '#8a5a30'; c.lineWidth = 2; c.beginPath(); c.ellipse(hem[0][0] - T * 0.2, hem[0][1] + T * 0.2, T * 0.75, T * 0.6, 0, 0, 6.3); c.fill(); c.stroke(); }
  // 手臂（绿袖子 + 奶油袖口 + 小手）
  for (const [s0, el, wr] of [[11, 13, 15], [12, 14, 16]]) { const col = glow('arms') ? '#b9d08f' : C.tunic; seg(s0, el, T * 0.85, col, C.tunicE); if (seg(el, wr, T * 0.8, col, C.tunicE)) { const p = P(el), q = P(wr), cx = q[0] - (q[0] - p[0]) * 0.12, cy = q[1] - (q[1] - p[1]) * 0.12; c.strokeStyle = C.cuff; c.lineWidth = T * 0.95; c.beginPath(); c.moveTo(cx, cy); c.lineTo(q[0], q[1]); c.stroke(); ball(wr, T * 0.5, glow('arms') ? C.on : C.skin, '#d9b592'); } }
  // 头：大圆脸 + 一圈卷发
  const n = P(0); if (n) { const r = sh * 0.72, cx = n[0], cy = n[1] - r * 0.15;
    c.fillStyle = C.hair; c.strokeStyle = C.hairE; c.lineWidth = 2.5;
    for (let i = 0; i < 9; i++) { const t = Math.PI * (0.92 + i * 0.145), rr = r * (i < 2 || i > 6 ? 0.42 : 0.36), d = r * (i < 2 || i > 6 ? 1.0 : 0.88); c.beginPath(); c.arc(cx + Math.cos(t) * d, cy + Math.sin(t) * d * 0.95 + (i < 2 || i > 6 ? r * 0.35 : 0), rr, 0, 6.3); c.fill(); c.stroke(); }
    c.beginPath(); c.arc(cx, cy - r * 0.12, r * 1.02, Math.PI, 0); c.fill();
    c.fillStyle = C.skin; c.strokeStyle = '#e2c09c'; c.beginPath(); c.arc(cx, cy + r * 0.08, r * 0.86, 0, 6.3); c.fill(); c.stroke();
    c.fillStyle = C.hair; c.beginPath(); c.ellipse(cx, cy - r * 0.62, r * 0.82, r * 0.42, 0, Math.PI, 0); c.fill(); c.beginPath(); c.ellipse(cx - r * 0.3, cy - r * 0.52, r * 0.5, r * 0.3, -0.3, 0, 6.3); c.fill(); c.beginPath(); c.ellipse(cx + r * 0.38, cy - r * 0.5, r * 0.42, r * 0.26, 0.35, 0, 6.3); c.fill();
    c.fillStyle = '#3d2a1e'; for (const dx of [-0.34, 0.34]) { c.beginPath(); c.ellipse(cx + dx * r, cy + r * 0.12, r * 0.075, r * 0.1, 0, 0, 6.3); c.fill(); }
    c.fillStyle = 'rgba(240,140,120,.5)'; for (const dx of [-0.56, 0.56]) { c.beginPath(); c.ellipse(cx + dx * r, cy + r * 0.36, r * 0.17, r * 0.11, 0, 0, 6.3); c.fill(); }
    c.strokeStyle = '#7a4a3a'; c.lineWidth = 2.5; c.beginPath(); c.arc(cx, cy + r * 0.3, r * 0.16, 0.25, Math.PI - 0.25); c.stroke(); }
  c.globalAlpha = 1;
}
function drawSkeleton(lm) {
  for (const k in HL) HL[k] = Math.max(0, HL[k] - 1);
  drawFelt($('mskel'), lm || null, !lm);
  if (document.body.classList.contains('staging')) drawFelt($('mfelt'), lm || null, !lm);
  if (document.body.classList.contains('lostcard')) drawFelt($('mfelt2'), null, true);
}
// ---- 站位界面：开摄像头后全屏显示，校准好就消失；玩的时候走出画面只在角落提示 ----
let everTracked = false;
function stageUpdate(lm, snap) {
  const B = document.body.classList, tracking = snap.status === 'tracking';
  if (tracking) everTracked = true;
  B.toggle('staging', !forceFull && !everTracked); B.toggle('lostcard', !forceFull && everTracked && !tracking);
  if (!B.contains('staging')) return;
  const vis = i => lm && lm[i] && (lm[i].visibility ?? 1) > 0.5, feet = vis(27) && vis(28), top = vis(11) && vis(12);
  let t = '找个位置站好', s = '离屏幕两三步远，让全身都进到画面里。';
  if (lm && !feet) { t = '再往后退一点'; s = '小满还看不到你的脚。往后退一两步，头和脚都要在画面里。'; }
  else if (lm && !top) { t = '往后退一点'; s = '让头和肩膀也进到画面里。'; }
  else if (lm) { t = '很好，站稳别动'; s = '自然站直，手放在身体两边，一两秒就好。'; }
  $('mstageT').textContent = t; $('mstageS').textContent = s; $('mstageB').style.width = (snap.calibrationProgress || 0) * 100 + '%';
}
function drawFeatures(f) {
  const el = $('mfeat'); if (!f) { el.innerHTML = ''; return; }
  const cfg = cam ? cam.core.config : DEFAULT_CONFIG;
  const bar = (name, v, th, max) => { const pct = Math.max(0, Math.min(1, v / max)) * 100, tp = th / max * 100; return `<div class="fb"><span>${name}</span><i><b style="width:${pct}%" class="${v > th ? 'on' : ''}"></b><em style="left:${tp}%"></em></i></div>`; };
  const hand = Math.max(f.leftHand ?? -2, f.rightHand ?? -2);
  el.innerHTML = bar('下蹲深度', f.hipDrop, cfg.squatOn, 0.8) + bar('跳·髋', f.riseHip, cfg.jumpOn, 0.3) + bar('跳·左脚', f.riseL, cfg.jumpOn, 0.3) + bar('跳·右脚', f.riseR, cfg.jumpOn, 0.3)
    + bar('走路·抬脚', Math.max(f.liftL ?? 0, f.liftR ?? 0), cfg.stepOn, 0.2) + bar('走路·摆臂', Math.abs(f.armSwing ?? 0), cfg.armSwingOn, 0.4) + bar('走路·起伏', Math.max(0, f.bob ?? 0), cfg.bobOn, 0.1) + bar('举手高度', hand + 1.2, cfg.reachOn + 1.2, 1.8) + bar('双臂高度', (f.armsHeight ?? -1.2) + 0.5, 0.33, 1.3)
    + bar('双臂张开', f.spread || 0, cfg.spreadMax || 2.4, 3.2) + bar('挥手快慢', f.swingMs && performance.now() - (f.swingAt || 0) < 1500 ? Math.min(1, 300 / f.swingMs) : 0, 0.75, 1);   // 张开越大越长；挥手条越长越快，过线算太快
}
addEventListener('keydown', e => {
  if (e.key === 'd' || e.key === 'D') { forceFull = !forceFull; if (forceFull) document.body.classList.remove('compact', 'staging', 'lostcard', 'nopanel'); }
});
addEventListener('togglepanel', () => { forceFull = !forceFull; document.body.classList.remove('nopanel'); if (forceFull) document.body.classList.remove('compact', 'staging', 'lostcard'); });
addEventListener('keydown', e => { if (e.key === '0') { for (const k in counts) { counts[k] = 0; const el = $('c_' + k); if (el) el.textContent = 0; } } });
buildPanel();
// 灵敏度滑杆：真人实测时哪个动作不灵就当场拉一下，立刻生效，存在这台电脑上
(function () {
  const NAMES = [['squat', '下蹲'], ['step', '原地走'], ['lean', '身体侧倾'], ['arms', '双臂举高'], ['reach', '单手伸出']], el = $('mtune'); if (!el) return;
  const t = loadTune();
  el.innerHTML = '<div class="small" style="margin:6px 0 2px">灵敏度（往左更容易做到，往右要做得更标准）</div>' + NAMES.map(([k, n]) => `<label class="small" style="display:flex;gap:6px;align-items:center"><span style="width:64px">${n}</span><input type="range" min="0.6" max="1.4" step="0.05" value="${t[k]}" data-k="${k}" style="flex:1"><b id="tv_${k}" style="width:34px">${(+t[k]).toFixed(2)}</b></label>`).join('') + '<button id="mtreset" style="margin-top:4px">恢复默认</button>';
  const apply = () => { const v = {}; el.querySelectorAll('input[type=range]').forEach(r => { v[r.dataset.k] = +r.value; $('tv_' + r.dataset.k).textContent = (+r.value).toFixed(2); }); if (cam) cam.setTune(v); else { try { localStorage.setItem('mm_tune', JSON.stringify(v)); } catch (e) {} } };
  el.addEventListener('input', apply);
  $('mtreset').onclick = () => { el.querySelectorAll('input[type=range]').forEach(r => r.value = 1); apply(); };
})();
window.__motionTest = { onEvents, onFrame, counts };

// ---- watchdog (v32): if recognition stops delivering frames, neutralise every signal and restart the camera ----
setInterval(async () => {
  if (!cam || !cam.active || restarting) return;
  const idle = performance.now() - lastFrameAt, g = G();
  if (idle > 700 && g && g.gesture) {
    stepTimes.length = 0;
    Object.assign(g.gesture, { stepRate: 0, armsUp: false, cross: false, armLevel: 0, squatDepth: 0, lean: 0, spread: 0, swingMs: 0, running: false, lm: null });
    if (g.input) { g.input.duck = false; g.input.slow = true; }
    if (g.S && g.S.mode === 'play' && !g.S.paused) { g.S.paused = true; pausedByCamera = true; }
    onStatus({ status: 'lost', message: '识别暂时中断，正在重新连接摄像头……' });
    lastStatus = 'stalled';   // the next real frame re-applies its status and un-pauses
  }
  if (idle > 1500) { try { const v = $('mvideo'); if (v && v.paused) await v.play(); } catch (e) {} }
  if (idle > 4000) {
    restarting = true;
    try { cam.stop(); await cam.start($('mvideo')); lastFrameAt = performance.now(); } catch (e) { onStatus({ status: 'error', message: '摄像头重连失败，请刷新页面' }); }
    restarting = false;
  }
}, 300);
