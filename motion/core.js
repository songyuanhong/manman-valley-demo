/** Render-agnostic, deterministic pose state machine. All lengths are torso-normalized. */
export const DEFAULT_CONFIG = Object.freeze({
  calibrationMs: 1500, calibrationJitter: .10, minVisibility: .6,
  minTorso: .10, uprightKneeGap: .35, uprightLeanMax: .4, filterTimeMs: 45, dropoutMs: 250,
  reacquireMs: 120, squatOn: .28, squatOff: .15, squatHoldMs: 80,
  jumpOn: .065, jumpOff: .025, jumpHoldMs: 30, jumpCooldownMs: 500,
  // jump v2 (2026-11-09, after first human test): hips AND BOTH ankles must rise above a moving
  // ground estimate, so a light hop counts and a single raised leg does not.
  jumpHipBaseMs: 800, jumpHipFreezeMs: 900, groundDownMs: 90, groundUpMs: 3000,
  // crossed forearms in front of the chest = pause gesture
  crossOn: .18, crossHoldMs: 150,
  squatJumpGuardMs: 350, kneeOn: .15, kneeOff: .06, stepHoldMs: 45,
  // v50 step detector: the two legs take turns. A step = the height difference between the legs swinging past
  // ±stepOn (torso units) on the other side from the last step. No absolute knee height needed, so small
  // in-place steps count, and standing still (difference ~0) never does.
  stepOn: .025, stepFastMs: 60, stepSlowMs: 900, stepRepeatMs: 700, armSwingOn: .10, bobOn: .026, legVisibility: .3, leanQuietMs: 450,
  stepCooldownMs: 170, armConfirmMs: 1200, beatMergeMs: 350, runTimeoutMs: 850, armsOn: .18, armsOff: -.02,
  armsHoldMs: 65, sideOn: .22, sideOff: .12, sideHoldMs: 75, sideLeanWeight: 1.2,
  mirror: true, lowImpact: false,
  // one-hand reach (added for 慢慢跑酷 delivery): raised wrist near/above shoulder, other wrist low
  reachOn: .12, reachOther: -.25, reachHoldMs: 140, reachCooldownMs: 600, handVisibility: .35,
  // wave = a raised hand swinging side to side (used to move a selection, never needs the player to walk)
  waveRaise: -.3, waveAmp: .12, waveWindowMs: 1600, waveCooldownMs: 650,
  // arms spread sideways (cloud post office): wrist-to-wrist distance in torso units, counted only while both wrists are near shoulder height
  spreadLevel: .45, spreadMin: .8, spreadMax: 2.4,
});

const REQUIRED = [11,12,23,24,25,26,27,28], CORE = [11,12,23,24];
const center = (a, b) => ({x: (a.x+b.x)/2, y: (a.y+b.y)/2});
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const valid = (p, visibility) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
  && p.x > -.25 && p.x < 1.25 && p.y > -.25 && p.y < 1.25
  && (p.visibility ?? 1) >= visibility;

const armsVisible0 = (a, b, c) => valid(a, c.minVisibility) && valid(b, c.minVisibility);

export class MotionCore {
  constructor(config = {}) { this.config = {...DEFAULT_CONFIG, ...config}; this.reset(); }
  configure(config = {}) { Object.assign(this.config, config); }
  reset() {
    this.status = 'calibrating'; this.calibrationProgress = 0; this.baseline = null;
    this.calibration = []; this.calibrationStarted = null; this.lastTime = -Infinity;
    this.lastVisible = -Infinity; this.reacquireStarted = null; this.filtered = null;
    this.holds = {}; this.squat = false; this.arms = false; this.side = 0;
    this.running = false; this.lastKnee = null; this.kneeHeld = null;
    this.lastStep = -Infinity; this.lastJump = -Infinity; this.lastSquat = -Infinity;
    this.jumpHeld = false; this.features = null; this.reachHeld = false; this.lastReach = -Infinity;
    this.ground = null; this.cross = false;
  }
  snapshot() {
    return {status: this.status, calibrationProgress: this.calibrationProgress,
      calibrated: !!this.baseline, running: this.running, squat: this.squat,
      armsUp: this.arms, cross: this.cross, lean: this.side, features: this.features ? {...this.features} : null};
  }
  _held(key, condition, time, duration) {
    if (!condition) { delete this.holds[key]; return false; }
    this.holds[key] ??= time;
    return time - this.holds[key] >= duration;
  }
  _release(time, events) {
    if (this.squat) events.push({type:'squatEnd', time});
    if (this.arms) events.push({type:'armsDown', time});
    if (this.side) events.push({type:'leanCenter', time});
    if (this.cross) events.push({type:'crossEnd', time});
    this.cross = false; this.ground = null;
    if (this.running) events.push({type:'runStop', time});
    this.squat = this.arms = this.running = this.jumpHeld = false;
    this.side = 0; this.lastKnee = this.kneeHeld = null; this.holds = {};
  }
  process(landmarks, time) {
    if (!Number.isFinite(time) || time <= this.lastTime) return [];
    const dt = time - this.lastTime;
    this.lastTime = time;
    const events = [], c = this.config;
    const emit = type => events.push({type, time});
    // v60: the whole body is needed only to calibrate. Once playing, shoulders + hips are enough to keep going —
    // a lifted foot often blurs and drops below the visibility bar, and those frames used to be thrown away.
    const need = this.baseline ? CORE : REQUIRED, bar = this.baseline ? Math.min(.5, c.minVisibility) : c.minVisibility;
    if (!Array.isArray(landmarks) || need.some(i => !valid(landmarks[i], bar))) {
      if (!this.baseline) { this.calibration = []; this.calibrationStarted = null; this.calibrationProgress = 0; }
      if (time - this.lastVisible > c.dropoutMs) {
        this._release(time, events); this.status = this.baseline ? 'lost' : 'calibrating';
        this.filtered = null; this.reacquireStarted = null; this.features = null;
      }
      return events;
    }
    const alpha = c.filterTimeMs <= 0 || !Number.isFinite(dt) ? 1 : 1-Math.exp(-dt/c.filterTimeMs);
    const p = landmarks.map((point, i) => {
      if (!point) return null;
      const old = this.filtered?.[i];
      return {...point, x: old ? old.x+(point.x-old.x)*alpha : point.x,
        y: old ? old.y+(point.y-old.y)*alpha : point.y};
    });
    this.filtered = p;
    const hip = center(p[23],p[24]), shoulder = center(p[11],p[12]);
    const ankle = center(p[27],p[28]);
    const torso = distance(hip,shoulder);
    if (torso < c.minTorso) return this._invalid(time, events);
    this.lastVisible = time;
    const raw = {hipX:hip.x, hipY:hip.y, shoulderY:shoulder.y, ankleY:ankle.y, torso,
      leftGap:p[25].y-p[23].y, rightGap:p[26].y-p[24].y};
    if (!this.baseline) {
      const upright = Math.min(raw.leftGap,raw.rightGap)/torso > c.uprightKneeGap
        && Math.abs(shoulder.x-hip.x)/torso < c.uprightLeanMax && shoulder.y < hip.y;
      const first = this.calibration[0];
      const stable = !first || Math.hypot(raw.hipX-first.hipX,raw.hipY-first.hipY)/torso < c.calibrationJitter
        && Math.abs(torso-first.torso)/torso < c.calibrationJitter;
      if (!upright || !stable) { this.calibration = []; this.calibrationStarted = null; this.calibrationProgress = 0; return events; }
      this.calibrationStarted ??= time;
      this.calibration.push(raw);
      // Bound memory even if callers supply a very high frame rate.
      if (this.calibration.length > 180) this.calibration.splice(1,1);
      this.calibrationProgress = Math.min(1,(time-this.calibrationStarted)/c.calibrationMs);
      if (this.calibrationProgress >= 1) {
        this.baseline = Object.fromEntries(Object.keys(raw).map(k => [k,this.calibration.reduce((s,v)=>s+v[k],0)/this.calibration.length]));
        this.calibration = []; this.status = 'tracking';
      }
      return events;
    }
    if (this.status === 'lost') {
      this.reacquireStarted ??= time;
      if (time-this.reacquireStarted < c.reacquireMs) return events;
    }
    this.status = 'tracking';
    const b = this.baseline, scale = b.torso;
    const hipDrop = (hip.y-b.hipY)/scale;
    // moving ground estimate: each ankle's baseline follows it down quickly and up very slowly;
    // the hip baseline is a slow average that pauses while a jump candidate is in progress.
    const dtc = Number.isFinite(dt) ? dt : 0;
    const g = this.ground ??= {hip: hip.y, l: p[27].y, r: p[28].y, frozen: 0};
    const env = (base, y) => base + (y-base)*(1-Math.exp(-dtc/(y > base ? c.groundDownMs : c.groundUpMs)));
    g.l = env(g.l, p[27].y); g.r = env(g.r, p[28].y);
    const riseHip = (g.hip-hip.y)/scale, riseL = (g.l-p[27].y)/scale, riseR = (g.r-p[28].y)/scale;
    const feetSeen = valid(p[27],.3) && valid(p[28],.3);
    const rise = feetSeen ? Math.min(riseHip, riseL, riseR) : -1;   // no feet in view, no jump
    g.frozen = rise > c.jumpOff ? g.frozen+dtc : 0;
    if (rise <= c.jumpOff || g.frozen > c.jumpHipFreezeMs) g.hip += (hip.y-g.hip)*(1-Math.exp(-dtc/c.jumpHipBaseMs));
    const lw = p[15], rw = p[16];
    const crossAmount = armsVisible0(lw, rw, c) ? (lw.x-rw.x)*Math.sign(p[12].x-p[11].x)/scale : -Infinity;
    const chest = armsVisible0(lw, rw, c) && Math.max(lw.y, rw.y) < hip.y-.15*scale && Math.min(lw.y, rw.y) > shoulder.y-.45*scale;
    const crossWanted = chest && crossAmount > (this.cross ? c.crossOn*.5 : c.crossOn);
    if (this._held('cross', crossWanted, time, c.crossHoldMs) && !this.cross) { this.cross = true; emit('crossStart'); }
    if (this.cross && !crossWanted) { this.cross = false; emit('crossEnd'); }
    const leftKnee = (b.leftGap-raw.leftGap)/scale, rightKnee = (b.rightGap-raw.rightGap)/scale;
    const armsVisible = valid(p[15],c.minVisibility) && valid(p[16],c.minVisibility);
    const armsHeight = armsVisible ? Math.min(p[11].y-p[15].y,p[12].y-p[16].y)/scale : -Infinity;
    if (Math.abs(hip.x-b.hipX)/scale < .12) b.hipX += (hip.x-b.hipX)*.01;   // v126：人慢慢站偏了也跟上（原来站偏后往一边倾很难认，真人测试：左倾吃力）
    const sideOffset = ((hip.x-b.hipX)+(shoulder.x-hip.x)*c.sideLeanWeight)/scale*(c.mirror ? -1 : 1);
    const lH = valid(p[15],c.handVisibility) ? (p[11].y-p[15].y)/scale : -Infinity;
    const rH = valid(p[16],c.handVisibility) ? (p[12].y-p[16].y)/scale : -Infinity;
    this._wave(p, scale, lH, rH, time, emit);
    { const lw = p[15], rw = p[16], ls = p[11], rs = p[12];
      if (lw && rw && ls && rs) { const sy = (ls.y + rs.y) / 2, dist = Math.abs(lw.x - rw.x) / scale, level = Math.max(Math.abs(lw.y - sy), Math.abs(rw.y - sy)) / scale;
        this.spread = level < c.spreadLevel ? dist : 0; this.spreadLevel = level; } else this.spread = 0; }
    this.features = {spread: this.spread || 0, swingMs: this.swingMs || 0, swingAt: this.swingAt || 0, riseHip,riseL,riseR,crossAmount:Number.isFinite(crossAmount)?crossAmount:null,hipDrop,rise,leftKnee,rightKnee,armsHeight:Number.isFinite(armsHeight)?armsHeight:null,sideOffset,
      leftHand:Number.isFinite(lH)?lH:null, rightHand:Number.isFinite(rH)?rH:null};
    const reachWanted = !this.cross && !crossWanted && ((lH > c.reachOn && rH < c.reachOther) || (rH > c.reachOn && lH < c.reachOther));
    if (!reachWanted) this.reachHeld = false;
    if (this._held('reach', reachWanted && !this.arms, time, c.reachHoldMs) && !this.reachHeld) {
      this.reachHeld = true;
      if (time - this.lastReach > c.reachCooldownMs) { emit('reach'); this.lastReach = time; }
    }
    const squatWanted = this.squat ? hipDrop > c.squatOff : hipDrop > c.squatOn;
    if (this._held('squat',squatWanted,time,c.squatHoldMs) && !this.squat) {this.squat=true;emit('squatStart');}
    if (this.squat && !squatWanted) {this.squat=false;this.lastSquat=time;emit('squatEnd');}
    if (this.squat) this.lastSquat=time;
    const armsWanted = armsHeight > (this.arms ? c.armsOff : c.armsOn);
    if (this._held('arms',armsWanted,time,c.armsHoldMs) && !this.arms) {
      this.arms=true;emit('armsUp');
      if(c.lowImpact && !this.squat && time-this.lastJump>c.jumpCooldownMs) {emit('jump');this.lastJump=time;}
    }
    if(this.arms && !armsWanted) {this.arms=false;emit('armsDown');}
    const stepping = time - this.lastStep < c.leanQuietMs;
    const targetSide = stepping ? this.side : Math.abs(sideOffset) > (this.side ? c.sideOff : c.sideOn) ? Math.sign(sideOffset) : 0;
    for(const key of Object.keys(this.holds))if(key.startsWith('side') && key!=='side'+targetSide)delete this.holds[key];
    if(targetSide !== this.side && this._held('side'+targetSide,true,time,c.sideHoldMs)) {
      this.side=targetSide;
      for(const key of Object.keys(this.holds)) if(key.startsWith('side')) delete this.holds[key];
      if(this.side) {emit(this.side<0?'dodgeLeft':'dodgeRight');emit(this.side<0?'leanLeft':'leanRight');}
      else emit('leanCenter');
    } else if(targetSide === this.side) {
      for(const key of Object.keys(this.holds)) if(key.startsWith('side')) delete this.holds[key];
    }
    if(rise < c.jumpOff) this.jumpHeld=false;
    const jumpWanted = rise>c.jumpOn && !this.squat && time-this.lastSquat>c.squatJumpGuardMs;
    if(this._held('jump',jumpWanted,time,c.jumpHoldMs) && !this.jumpHeld) {
      this.jumpHeld=true;
      if(time-this.lastJump>c.jumpCooldownMs) {emit('jump');this.lastJump=time;}
    }
    // ---- steps (v50): each leg's lift above its own resting height; the two legs take turns ----
    // Resting height = a floor that follows the leg down fast and up slowly (like the jump ground), so a small
    // lift shows clearly, camera drift doesn't, and putting a held leg down never looks like the other leg lifting.
    const kv = valid(p[25],c.legVisibility) && valid(p[26],c.legVisibility), av = valid(p[27],c.legVisibility) && valid(p[28],c.legVisibility);
    if (kv || av) {
      const yL = kv && av ? (p[25].y + p[27].y) / 2 : kv ? p[25].y : p[27].y, yR = kv && av ? (p[26].y + p[28].y) / 2 : kv ? p[26].y : p[28].y;
      const fl = this.legFloor ??= {l: yL, r: yR, sl: yL, sr: yR};
      const sm = 1-Math.exp(-dtc/c.stepFastMs); fl.sl += (yL-fl.sl)*sm; fl.sr += (yR-fl.sr)*sm;
      const env = (base, y) => base + (y-base)*(1-Math.exp(-dtc/(y > base ? 90 : 2500)));
      fl.l = env(fl.l, fl.sl); fl.r = env(fl.r, fl.sr);
      const liftL = (fl.l-fl.sl)/scale, liftR = (fl.r-fl.sr)/scale;
      this.features.liftL = liftL; this.features.liftR = liftR;
      const side = liftL > c.stepOn && liftL > liftR + c.stepOn*.5 ? 'left' : liftR > c.stepOn && liftR > liftL + c.stepOn*.5 ? 'right' : null;
      if (this.kneeHeld && (this.kneeHeld === 'left' ? liftL : liftR) < c.stepOn*.4) this.kneeHeld = null;   // that leg is down again
      if (side && side !== this.kneeHeld && !this.squat && !jumpWanted && time-this.lastStep > c.stepCooldownMs
          && (side !== this.lastKnee || (time-this.lastStep > c.stepRepeatMs && this.prevStepSide !== side))) {
        if (this.lastKnee && !this.running && time-this.lastStep < c.runTimeoutMs) {this.running=true;emit('runStart');}
        this.kneeHeld = side; this.lastKnee = side; this.lastStep = time; this.lastLegStep = time; emit('runStep');
      }
      this.prevStepSide = side;   // same leg twice only counts on a fresh lift, not the tail of an old one
    }
    // ---- walking in place (v60): legs are only one clue. Arm swing and the body's up-down bob also count, ----
    // so natural walking/jogging on the spot drives the game even when the camera can't see the feet clearly.
    // A lone twitch never counts: arm/bob beats need a previous beat of the same kind within the rhythm window.
    {
      const W = this.walk ??= {arm: {f: null, s: 0, side: 0, last: -1e9, away: -1e9}, bob: {f: null, s: 0, up: false, last: -1e9}, n: 0};
      const quiet = !this.squat && !jumpWanted && time-this.lastSquat > 400;
      // v101（真人测试：扭胳膊、抬手也会往前走）：手臂摆动只做「补充」——最近 armConfirmMs 内腿或身体起伏真有动静才算数，光动手不走
      const beat = src => {
        if (!quiet || time-this.lastStep < c.stepCooldownMs) return;
        if (src === 'arms' && !(time-(this.lastLegStep||-1e9) < c.armConfirmMs || time-(W.bob.last||-1e9) < c.armConfirmMs)) return;
        if (time-this.lastStep < c.beatMergeMs) return;   // 手臂和身体起伏常是同一步的两个线索，0.35 秒内只算一次
        if (this.lastKnee && !this.running && time-this.lastStep < c.runTimeoutMs) {this.running=true;emit('runStart');}
        this.lastKnee = this.lastKnee === 'left' ? 'right' : 'left'; this.lastStep = time; this.features.walkSrc = src; emit('runStep');
      };
      if (events.some(e => e.type === 'runStep')) this.features.walkSrc = 'legs';
      // arms: left-vs-right wrist (or elbow) height and depth, swinging in turn
      const wv = valid(p[15],.4) && valid(p[16],.4), ev2 = valid(p[13],.4) && valid(p[14],.4);
      if ((wv || ev2) && valid(p[11],.4) && valid(p[12],.4)) {
        const l = wv ? p[15] : p[13], r = wv ? p[16] : p[14], below = l.y > p[11].y && r.y > p[12].y;
        const d = ((l.y-r.y) + .6*((l.z||0)-(r.z||0)))/scale, A = W.arm;
        if (!below) A.away = time;
        if (A.f === null || time-A.away < 500) { A.f = A.s = d; }   // hands were up (reaching, waving): start over once they settle
        A.f += (d-A.f)*(1-Math.exp(-dtc/70)); A.s += (A.f-A.s)*(1-Math.exp(-dtc/(Math.abs(A.f-A.s) < c.armSwingOn ? 900 : 5000)));
        const x = A.f-A.s, side = x > c.armSwingOn ? 1 : x < -c.armSwingOn ? -1 : 0;
        this.features.armSwing = x;
        if (!below) { A.side = 0; A.last = -1e9; }
        else if (side && side !== A.side) { const rhythm = time-A.last < 1300; A.side = side; A.last = time; if (rhythm) beat('arms'); }
      }
      // bob: the hips dip and rise once per step
      {
        const B = W.bob, y = hip.y/scale;
        if (B.f === null) B.f = B.s = y;
        B.f += (y-B.f)*(1-Math.exp(-dtc/60)); B.s += (B.f-B.s)*(1-Math.exp(-dtc/450));
        const x = B.s-B.f;   // positive = body higher than its recent average
        this.features.bob = x;
        if (!B.up && x > c.bobOn) { B.n = time-B.last < 1000 ? (B.n||0)+1 : 0; B.up = true; B.last = time; if (B.n >= 2) beat('bob'); }   // third bounce in a row onward
        else if (B.up && x < -c.bobOn*.3) B.up = false;
      }
    }
    if(this.running && (this.squat || time-this.lastStep>c.runTimeoutMs)) {this.running=false;emit('runStop');}
    return events;
  }
  _wave(p, scale, lH, rH, time, emit) {
    const c = this.config; this.waves ??= {};
    for (const [side, w, s, h] of [['Left', 15, 11, lH], ['Right', 16, 12, rH]]) {
      const st = this.waves[side] ??= { ext: null, dir: 0, swings: 0, t0: 0 };
      if (!(h > c.waveRaise)) { st.ext = null; st.dir = 0; st.swings = 0; st.lastTurn = 0; continue; }
      const x = (p[w].x - p[s].x) / scale;
      if (st.ext === null) { st.ext = x; st.dir = 0; st.swings = 0; st.t0 = time; continue; }
      const d = x - st.ext;
      if (st.dir === 0 && Math.abs(d) > c.waveAmp) { st.dir = Math.sign(d); st.ext = x; st.swings = 1; st.t0 = time; }
      else if (st.dir !== 0) {
        if (Math.sign(d) === st.dir) st.ext = st.dir > 0 ? Math.max(st.ext, x) : Math.min(st.ext, x);       // still going the same way
        else if (Math.abs(d) > c.waveAmp) { st.dir = -st.dir; st.ext = x; st.swings++; if (st.lastTurn) { this.swingMs = time - st.lastTurn; this.swingAt = time; emit('swing' + side); } st.lastTurn = time; }   // turned around
      }
      if (time - st.t0 > c.waveWindowMs) { st.swings = st.dir ? 1 : 0; st.t0 = time; }
      if (st.swings >= 2 && time - (this.lastWave || -Infinity) > c.waveCooldownMs) { emit('wave' + side); this.lastWave = time; st.swings = 1; st.t0 = time; }
    }
  }
  _invalid(time,events) {
    if(!this.baseline){this.calibration=[];this.calibrationStarted=null;this.calibrationProgress=0;}
    if(time-this.lastVisible>this.config.dropoutMs) {
      this._release(time,events);this.status=this.baseline?'lost':'calibrating';
      this.filtered=null;this.reacquireStarted=null;this.features=null;
    }
    return events;
  }
}
