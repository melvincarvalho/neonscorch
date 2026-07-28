// NEON SCORCH — a tribute to Scorched Earth (Wendell Hicken, 1991)
// Copyright © 2026 Melvin Carvalho — AGPL-3.0-or-later
// Zero assets: every pixel and every sound is generated from code.

'use strict';
window.onerror = (m, s, l, c, e) => { document.title = 'ERR:' + (e && e.stack ? e.stack.replace(/\n/g, ' | ').slice(0, 260) : m + '@' + l); };
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = 1280, H = 720;
const HUD_H = 108, MQ = 36;
const VW = W, VH = H - MQ - HUD_H;
const MONO = '"Courier New", monospace';

// ---------- deterministic RNG ----------
let _seed = 1;
function srand(s) { _seed = (s >>> 0) || 1; }
function rand() {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5; _seed >>>= 0;
  return _seed / 4294967296;
}
function rng(a, b) { return a + rand() * (b - a); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (k >= 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
  else { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// ---------- audio ----------
let AC = null, AUDIO_ON = true;
function audio() { if (!AC && AUDIO_ON) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AUDIO_ON = false; } } }
function blip(f0, f1, dur, type, vol) {
  if (!AC || !AUDIO_ON) return;
  const t = AC.currentTime;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'square';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(28, f1), t + dur);
  g.gain.setValueAtTime(vol || 0.08, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(AC.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
function boom(vol, dur) {
  if (!AC || !AUDIO_ON) return;
  const t = AC.currentTime;
  const len = (AC.sampleRate * dur) | 0;
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const d = buf.getChannelData(0);
  let v = 0;
  for (let i = 0; i < len; i++) { v = v * 0.97 + (Math.random() * 2 - 1) * 0.5; d[i] = v * (1 - i / len); }
  const s = AC.createBufferSource(), g = AC.createGain(), f = AC.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(120, t + dur);
  s.buffer = buf;
  g.gain.value = vol;
  s.connect(f); f.connect(g); g.connect(AC.destination);
  s.start(t);
}
const SFX = {
  aim: () => blip(600, 640, 0.03, 'square', 0.03),
  fire: () => { blip(140, 60, 0.25, 'sawtooth', 0.12); boom(0.06, 0.15); },
  boomS: () => { boom(0.14, 0.4); blip(300, 60, 0.3, 'sawtooth', 0.06); },
  boomL: () => { boom(0.22, 0.8); blip(200, 40, 0.6, 'sawtooth', 0.1); },
  split: () => blip(900, 1400, 0.12, 'sine', 0.08),
  dirt: () => blip(200, 320, 0.2, 'triangle', 0.08),
  sizzle: () => boom(0.06, 0.5),
  hurt: () => blip(400, 110, 0.25, 'square', 0.09),
  die: () => { boom(0.25, 1.0); blip(600, 50, 0.8, 'sawtooth', 0.1); },
  shield: () => blip(500, 900, 0.2, 'sine', 0.09),
  cash: () => { blip(900, 1200, 0.08, 'square', 0.06); setTimeout(() => blip(1200, 1600, 0.1, 'square', 0.06), 70); },
  turn: () => blip(500, 700, 0.08, 'sine', 0.05),
  win: () => { [440, 554, 659, 880].forEach((f, i) => setTimeout(() => blip(f, f * 1.01, 0.3, 'triangle', 0.1), i * 130)); },
  fail: () => { [330, 311, 262, 196].forEach((f, i) => setTimeout(() => blip(f, f * 0.98, 0.35, 'sawtooth', 0.08), i * 160)); },
};

// ---------- constants: the physics constitution ----------
const TW_ = 1280;                 // terrain width = view width (one screen, canon)
const GRAV = 110;                 // px/s^2
const WIND_MAX = 40;              // px/s^2 horizontal accel at full wind
const STEP = 1 / 120;             // projectile integration step (fine, deterministic)
const SIMSTEP = 1 / 60;           // world sim step
const POWER_V = 5.2;              // muzzle velocity per power point (power 0..100)
const FALL_DMG = 0.45;            // hp per px fallen beyond grace
const FALL_GRACE = 18;

const WEAPONS = {
  missile: { name: 'MISSILE', r: 26, dmg: 42, cost: 0, ammo: Infinity, glyph: 'M' },
  bigone: { name: 'THE BIG ONE', r: 44, dmg: 75, cost: 500, ammo: 2, glyph: 'B' },
  mirv: { name: 'MIRV', r: 20, dmg: 30, cost: 900, ammo: 2, glyph: 'V', splits: 5 },
  napalm: { name: 'NAPALM', r: 12, dmg: 4, cost: 700, ammo: 2, glyph: 'N', flows: 60 },
  dirt: { name: 'DIRT BALL', r: 34, dmg: 0, cost: 300, ammo: 3, glyph: 'D', builds: true },
  tracer: { name: 'TRACER', r: 4, dmg: 0, cost: 0, ammo: Infinity, glyph: 'T' },
};
const WEAPON_ORDER = ['tracer', 'missile', 'bigone', 'mirv', 'napalm', 'dirt'];
const TEAM_COL = ['#33d6ff', '#ff2e6d', '#ffd12a', '#5aff9e'];

let G = null;

// ---------- terrain: a 1D heightfield of glowing dunes ----------
function genTerrain(seed) {
  srand(seed);
  const h = new Float32Array(TW_);
  // layered cosines + a couple of peaks
  const base = rng(240, 330);
  const a1 = rng(40, 90), f1 = rng(1.2, 2.2), p1 = rng(0, 6.28);
  const a2 = rng(20, 55), f2 = rng(3.1, 5.3), p2 = rng(0, 6.28);
  const a3 = rng(8, 20), f3 = rng(8, 13), p3 = rng(0, 6.28);
  for (let x = 0; x < TW_; x++) {
    const t = x / TW_;
    h[x] = base + a1 * Math.sin(t * f1 * 6.28 + p1) + a2 * Math.sin(t * f2 * 6.28 + p2) + a3 * Math.sin(t * f3 * 6.28 + p3);
  }
  // h = height of ground above the HUD line, in world px (bigger = taller)
  for (let x = 0; x < TW_; x++) h[x] = clamp(h[x], 80, VH - 120);
  return h;
}
function groundY(x) {   // screen-space y of the terrain surface at world x
  const xi = clamp(Math.round(x), 0, TW_ - 1);
  return MQ + VH - G.terra[xi];
}
function carve(cx, cy, r) {
  // explosion bite: a circle of sky eaten out of the ground
  const x0 = clamp(Math.floor(cx - r), 0, TW_ - 1), x1 = clamp(Math.ceil(cx + r), 0, TW_ - 1);
  for (let x = x0; x <= x1; x++) {
    const dx = x - cx;
    const half = Math.sqrt(Math.max(0, r * r - dx * dx));
    const topY = cy - half, botY = cy + half;    // screen-space span of the blast circle
    const groundTop = MQ + VH - G.terra[x];
    if (botY <= groundTop) continue;             // blast entirely above ground
    const newTop = Math.max(groundTop, topY);
    // remove the slice [newTop, botY] from the column: ground below botY survives,
    // ground between newTop..botY is vaporized, anything above newTop was already sky
    const surviveBelow = Math.max(0, (MQ + VH) - botY);
    const removed = Math.max(0, Math.min(botY, MQ + VH) - newTop);
    if (topY <= groundTop) {
      G.terra[x] = surviveBelow;                 // top of column blown off
    } else {
      // cave: canon Scorched settles overhangs immediately — drop the roof
      G.terra[x] = Math.max(0, G.terra[x] - removed);
    }
  }
}
function pile(cx, cy, r) {
  // dirt ball: mound of new earth
  const x0 = clamp(Math.floor(cx - r), 0, TW_ - 1), x1 = clamp(Math.ceil(cx + r), 0, TW_ - 1);
  for (let x = x0; x <= x1; x++) {
    const dx = x - cx;
    const half = Math.sqrt(Math.max(0, r * r - dx * dx));
    const add = half * 1.4;
    G.terra[x] = clamp(G.terra[x] + add, 0, VH - 40);
  }
}
function settleTanks(shooter) {
  // gravity claims the undermined
  for (const t of G.tanks) {
    if (t.dead) continue;
    const gy = groundY(t.x);
    if (t.y < gy - 1) {
      const fall = gy - t.y;
      t.fallFrom = t.y;
      t.y = gy;
      if (fall > FALL_GRACE) {
        const dmg = (fall - FALL_GRACE) * FALL_DMG;
        damageTank(t, dmg, shooter);
        addPop(t.x, t.y - 30, '-' + Math.round(dmg), '#ff8c42');
      }
    }
  }
}
function damageTank(t, dmg, shooter) {
  if (t.dead) return;
  if (t.shield > 0) {
    const absorbed = Math.min(t.shield, dmg);
    t.shield -= absorbed;
    dmg -= absorbed;
    SFX.shield();
    addRing(t.x, t.y - 10, '#5aff9e');
    if (dmg <= 0) return;
  }
  t.hp -= dmg;
  t.hurtT = 0.4;
  SFX.hurt();
  if (shooter !== undefined && shooter !== t.id) {
    const s = G.tanks[shooter];
    if (s && !s.dead) { s.cash += Math.round(dmg * 4); G.stats.dmg[shooter] += Math.round(dmg); }
  }
  if (t.hp <= 0) {
    t.hp = 0;
    t.dead = true;
    SFX.die();
    addBoomFX(t.x, t.y - 6, 46, '#ffffff');
    carve(t.x, t.y - 4, 30);
    settleTanks(shooter);
    G.shake = Math.max(G.shake, 9);
  }
}

// ---------- game state ----------
function newGame(seed, opts) {
  opts = opts || {};
  const nTanks = opts.tanks || 2;
  G = {
    seed, time: 0, tick: 0, showTitle: !!opts.attract,
    terra: genTerrain(seed),
    tanks: [], shots: [], parts: [], pops: [], fires: [],
    wind: 0, round: 1, maxRounds: opts.rounds || 3,
    turn: 0, phase: 'aim', phaseT: 0,     // aim -> flight -> resolve -> next
    mode: 'play', modeT: 0,
    shake: 0, hintT: 22,
    trace: [],                            // last shot's path for render
    stats: { shots: [0, 0, 0, 0], dmg: [0, 0, 0, 0], hits: [0, 0, 0, 0], err: [[], [], [], []] },
    aiNoise: opts.aiNoise !== undefined ? opts.aiNoise : 14,
    log: [],
  };
  srand(seed ^ 0xbeef);
  const margin = 120, span = (TW_ - margin * 2) / (nTanks - 1 || 1);
  for (let i = 0; i < nTanks; i++) {
    const x = Math.round(margin + span * i + (nTanks > 1 ? rng(-40, 40) : 0));
    G.tanks.push({
      id: i, x, y: 0, hp: 100, shield: 0, dead: false,
      angle: i % 2 === 0 ? 60 : 120,       // degrees, 0 = right, 90 = up
      power: 55, cash: 0, hurtT: 0, fallFrom: 0,
      weapon: 'missile',
      ammo: { missile: Infinity, tracer: Infinity, bigone: 1, mirv: 1, napalm: 1, dirt: 2 },
      ai: opts.human === i ? null : (opts.ai ? opts.ai[i] || 'solver' : 'solver'),
      aimPlan: null,
    });
  }
  for (const t of G.tanks) t.y = groundY(t.x);
  rollWind();
}
function rollWind() {
  G.wind = Math.round(rng(-WIND_MAX, WIND_MAX));
}
function aliveTanks() { return G.tanks.filter(t => !t.dead); }

// ---------- ballistics ----------
function muzzle(t) {
  const a = t.angle * Math.PI / 180;
  return [t.x + Math.cos(a) * 16, t.y - 8 - Math.sin(a) * 16];
}
function fireShot(t, opts) {
  opts = opts || {};
  const a = t.angle * Math.PI / 180;
  const v = t.power * POWER_V;
  const [mx, my] = muzzle(t);
  const w = WEAPONS[t.weapon];
  if (w.ammo !== Infinity) {
    if ((t.ammo[t.weapon] || 0) <= 0) return false;
    t.ammo[t.weapon]--;
  }
  G.shots.push({
    x: mx, y: my, vx: Math.cos(a) * v, vy: -Math.sin(a) * v,
    weapon: t.weapon, owner: t.id, t: 0, split: false, trail: [],
  });
  G.stats.shots[t.id]++;
  G.trace = [];
  G.lastShotBy = t.id;
  if (!opts.silent) SFX.fire();
  G.phase = 'flight';
  G.phaseT = 0;
  return true;
}
function stepShot(s, dt) {
  // wind acts horizontally; napalm and dirt are heavy (half wind)
  const wmul = (s.weapon === 'dirt' || s.weapon === 'napalm') ? 0.5 : 1;
  s.vx += G.wind * wmul * dt;
  s.vy += GRAV * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.t += dt;
  s.trail.push(s.x, s.y);
  if (s.trail.length > 240) s.trail.splice(0, 2);
  // MIRV splits at apex
  const w = WEAPONS[s.weapon] || {};
  if (w.splits && !s.split && s.vy > 0) {
    s.split = true;
    SFX.split();
    for (let i = 0; i < w.splits; i++) {
      G.shots.push({
        x: s.x, y: s.y, vx: s.vx + (i - (w.splits - 1) / 2) * 26, vy: s.vy,
        weapon: 'mirvlet', owner: s.owner, t: 0, split: true, trail: [],
      });
    }
    return 'gone';
  }
  // out of world sides: shot is lost (canon walls off = open)
  if (s.x < -60 || s.x > TW_ + 60 || s.y > MQ + VH + 40) return 'lost';
  // tank hit check (direct)
  for (const t of G.tanks) {
    if (t.dead) continue;
    if (Math.abs(s.x - t.x) < 13 && s.y > t.y - 18 && s.y < t.y + 4) return 'impact';
  }
  // terrain hit
  if (s.y >= groundY(s.x)) return 'impact';
  return 'flying';
}
function detonate(s) {
  const w = WEAPONS[s.weapon] || { r: 20, dmg: 30 };
  const wr = s.weapon === 'mirvlet' ? WEAPONS.mirv.r : w.r;
  const wd = s.weapon === 'mirvlet' ? WEAPONS.mirv.dmg : w.dmg;
  G.impactX = s.x;
  G.log.push({ shot: s.weapon, by: s.owner, x: Math.round(s.x), y: Math.round(s.y), wind: G.wind });
  if (w.builds) {
    pile(s.x, s.y, wr);
    SFX.dirt();
    addBoomFX(s.x, s.y, wr, '#c9a06b', true);
    settleTanks(s.owner);
    return;
  }
  if (w.flows) {
    igniteNapalm(s.x, s.y, s.owner);
    return;
  }
  carve(s.x, s.y, wr);
  addBoomFX(s.x, s.y, wr, s.weapon === 'tracer' ? '#8ab0d0' : '#ff8c42');
  (wr > 30 ? SFX.boomL : SFX.boomS)();
  G.shake = Math.max(G.shake, wr > 30 ? 10 : 5);
  // splash damage with falloff
  for (const t of G.tanks) {
    if (t.dead) continue;
    const d = Math.hypot(t.x - s.x, (t.y - 8) - s.y);
    if (d < wr + 12) {
      const k = clamp(1 - d / (wr + 12), 0, 1);
      const dmg = wd * (0.35 + 0.65 * k);
      if (dmg > 1) {
        damageTank(t, dmg, s.owner);
        addPop(t.x, t.y - 30, '-' + Math.round(dmg), '#ff5c5c');
        if (s.owner !== t.id) G.stats.hits[s.owner]++;
      }
    }
  }
  settleTanks(s.owner);
}
function igniteNapalm(x, y, owner) {
  SFX.sizzle();
  // fire flows downhill from the impact, pooling in valleys
  let fx = clamp(Math.round(x), 2, TW_ - 3);
  const drops = [];
  for (const dir of [-1, 1]) {
    let cx = fx, steps = 0;
    while (steps++ < WEAPONS.napalm.flows) {
      const here = G.terra[cx], next = G.terra[clamp(cx + dir, 0, TW_ - 1)];
      if (next <= here + 0.5) cx = clamp(cx + dir, 1, TW_ - 2);
      else break;
      if (steps % 3 === 0) drops.push(cx);
    }
  }
  drops.push(fx);
  for (const dx of drops) {
    G.fires.push({ x: dx, ttl: rng(2.5, 4), owner });
  }
}

// ---------- turn machine ----------
function sim(dt) {
  G.time += dt; G.tick++; G.modeT += dt;
  G.hintT = Math.max(0, G.hintT - dt);
  if (G.shake > 0) G.shake = Math.max(0, G.shake - 20 * dt);
  tickFX(dt);
  if (G.mode !== 'play') return;
  G.phaseT += dt;

  // napalm burns
  for (const f of [...G.fires]) {
    f.ttl -= dt;
    for (const t of G.tanks) {
      if (!t.dead && Math.abs(t.x - f.x) < 14 && Math.abs(t.y - groundY(f.x)) < 16) {
        damageTank(t, WEAPONS.napalm.dmg * dt * 10, f.owner);
      }
    }
    if (f.ttl <= 0) G.fires.splice(G.fires.indexOf(f), 1);
  }

  if (G.phase === 'aim') {
    const t = G.tanks[G.turn];
    if (!t || t.dead) { nextTurn(); return; }
    if (t.ai) {
      aiAim(t, dt);
    }
  } else if (G.phase === 'flight') {
    // projectiles integrate at fine step for determinism
    const n = Math.round(dt / STEP);
    for (let k = 0; k < n; k++) {
      for (const s of [...G.shots]) {
        const r = stepShot(s, STEP);
        if (r === 'impact') { G.shots.splice(G.shots.indexOf(s), 1); G.trace = s.trail; detonate(s); }
        else if (r === 'lost') { G.shots.splice(G.shots.indexOf(s), 1); G.trace = s.trail; G.impactX = s.x; }
        else if (r === 'gone') { G.shots.splice(G.shots.indexOf(s), 1); }
      }
      if (!G.shots.length) break;
    }
    if (!G.shots.length && G.fires.length === 0) { G.phase = 'resolve'; G.phaseT = 0; }
    if (!G.shots.length && G.fires.length > 0 && G.phaseT > 5) { G.phase = 'resolve'; G.phaseT = 0; }
  } else if (G.phase === 'resolve') {
    if (G.phaseT > 0.6) {
      const alive = aliveTanks();
      if (alive.length <= 1) {
        endRound(alive[0]);
        return;
      }
      nextTurn();
    }
  }
}
function nextTurn() {
  let n = G.turn;
  for (let i = 0; i < G.tanks.length; i++) {
    n = (n + 1) % G.tanks.length;
    if (!G.tanks[n].dead) break;
  }
  G.turn = n;
  G.phase = 'aim';
  G.phaseT = 0;
  rollWind();
  const t = G.tanks[n];
  if (t) t.aimPlan = null;
  SFX.turn();
}
function endRound(winner) {
  G.roundWinner = winner ? winner.id : -1;
  if (winner) winner.cash += 1000;
  if (G.round >= G.maxRounds || !winner) {
    G.mode = winner && winner.id === 0 ? 'won' : 'lost';
    G.modeT = 0;
    (G.mode === 'won' ? SFX.win : SFX.fail)();
  } else {
    G.mode = 'shop';
    G.modeT = 0;
    SFX.cash();
  }
}
function startNextRound() {
  G.round++;
  const cash = G.tanks.map(t => t.cash);
  const ammo = G.tanks.map(t => ({ ...t.ammo }));
  const seed2 = (G.seed * 7919 + G.round * 104729) >>> 0;
  const keep = { human: G.tanks[0].ai ? undefined : 0, tanks: G.tanks.length, rounds: G.maxRounds, aiNoise: G.aiNoise, ai: G.tanks.map(t => t.ai) };
  const stats = G.stats, round = G.round, log = G.log;
  newGame(seed2, keep);
  G.round = round; G.stats = stats; G.log = log;
  for (let i = 0; i < G.tanks.length; i++) { G.tanks[i].cash = cash[i]; G.tanks[i].ammo = ammo[i]; }
}

// ---------- the AI: an aim solver with honest error ----------
function simulateShot(t, angleDeg, power, wind) {
  // ghost integration: same physics, no world mutation
  const a = angleDeg * Math.PI / 180;
  const v = power * POWER_V;
  let x = t.x + Math.cos(a) * 16, y = t.y - 8 - Math.sin(a) * 16;
  let vx = Math.cos(a) * v, vy = -Math.sin(a) * v;
  let steps = 0;
  while (steps++ < 3000) {
    vx += wind * STEP;
    vy += GRAV * STEP;
    x += vx * STEP;
    y += vy * STEP;
    if (x < -60 || x > TW_ + 60 || y > MQ + VH + 40) return x;
    if (y >= groundY(x)) return x;
  }
  return x;
}
function solveAim(t, target, wind, noise) {
  // canon-style solver: sample angles, binary-search power per angle, keep the best
  let best = null, bestErr = 1e9;
  const dir = target.x > t.x ? 1 : -1;
  const angles = dir > 0 ? [35, 45, 55, 65, 75] : [145, 135, 125, 115, 105];
  for (const ang of angles) {
    let lo = 20, hi = 100;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const ix = simulateShot(t, ang, mid, wind);
      const over = dir > 0 ? ix > target.x : ix < target.x;
      if (over) hi = mid; else lo = mid;
    }
    const p = (lo + hi) / 2;
    const err = Math.abs(simulateShot(t, ang, p, wind) - target.x);
    if (err < bestErr) { bestErr = err; best = { angle: ang, power: p, err }; }
  }
  if (best && noise) {
    best.angle += rng(-noise / 8, noise / 8);
    best.power += rng(-noise / 10, noise / 10);
  }
  return best;
}
function pickWeaponAI(t, target) {
  const d = Math.abs(t.x - target.x);
  if ((t.ammo.mirv || 0) > 0 && d > 350) return 'mirv';
  if ((t.ammo.bigone || 0) > 0 && target.hp > 55) return 'bigone';
  if ((t.ammo.napalm || 0) > 0 && target.hp < 40) return 'napalm';
  return 'missile';
}
function aiAim(t, dt) {
  if (!t.aimPlan) {
    const enemies = aliveTanks().filter(e => e.id !== t.id);
    if (!enemies.length) return;
    let target = enemies[0];
    for (const e of enemies) if (e.hp < target.hp) target = e;
    const style = t.ai;
    const wind = style === 'windblind' ? 0 : G.wind;    // the ablation: pretend the air is still
    const noise = style === 'null' ? 0 : (style === 'solver' ? 0 : G.aiNoise);
    if (style === 'null') {
      // the null gunner: fixed futile mortar straight up
      t.aimPlan = { angle: 90, power: 25, wait: 0.5, weapon: 'missile' };
    } else {
      t.weapon = pickWeaponAI(t, target);
      const sol = solveAim(t, target, wind, style === 'canon' ? G.aiNoise : noise);
      t.aimPlan = sol ? { angle: sol.angle, power: sol.power, wait: 0.5, weapon: t.weapon, err: sol.err }
                      : { angle: 60, power: 60, wait: 0.5, weapon: 'missile' };
      G.stats.err[t.id].push(Math.round(sol ? sol.err : 999));
    }
  }
  t.aimPlan.wait -= dt;
  // ease the barrel toward the plan so the aim is visible
  t.angle += clamp(t.aimPlan.angle - t.angle, -60 * dt, 60 * dt);
  t.power += clamp(t.aimPlan.power - t.power, -50 * dt, 50 * dt);
  if (t.aimPlan.wait <= 0 && Math.abs(t.angle - t.aimPlan.angle) < 0.8 && Math.abs(t.power - t.aimPlan.power) < 0.8) {
    t.angle = t.aimPlan.angle; t.power = t.aimPlan.power;
    t.weapon = t.aimPlan.weapon || t.weapon;
    if ((WEAPONS[t.weapon].ammo !== Infinity) && (t.ammo[t.weapon] || 0) <= 0) t.weapon = 'missile';
    fireShot(t);
  }
}

// ---------- fx ----------
function addBoomFX(x, y, r, color, soft) {
  G.parts.push({ kind: 'flash', x, y, r: r * 1.6, color: '#ffffff', life: 0.15, t: 0 });
  G.parts.push({ kind: 'ring', x, y, r: 6, max: r * 2.2, color, life: 0.45, t: 0 });
  const n = soft ? 14 : 26;
  for (let i = 0; i < n; i++) {
    const a = rng(0, 6.28), s = rng(40, soft ? 120 : 260);
    G.parts.push({
      kind: 'chip', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
      color: soft ? '#c9a06b' : (i % 3 === 0 ? '#ffd12a' : color), life: rng(0.4, 0.9), t: 0,
    });
  }
  if (!soft) for (let i = 0; i < 10; i++) {
    G.parts.push({ kind: 'smoke', x: x + rng(-r / 2, r / 2), y: y + rng(-6, 6), vx: rng(-15, 15), vy: rng(-40, -12), color: '#5a5a66', life: rng(0.8, 1.6), t: 0 });
  }
}
function addRing(x, y, color) { G.parts.push({ kind: 'ring', x, y, r: 6, max: 40, color, life: 0.4, t: 0 }); }
function addPop(x, y, txt, color) { G.pops.push({ x, y, txt, color, t: 0, life: 1.1 }); }
function tickFX(dt) {
  for (let i = G.parts.length - 1; i >= 0; i--) {
    const p = G.parts[i];
    p.t += dt;
    if (p.t >= p.life) { G.parts.splice(i, 1); continue; }
    if (p.kind === 'chip') { p.vy += 300 * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.y > groundY(p.x)) { p.y = groundY(p.x); p.vy *= -0.3; p.vx *= 0.7; } }
    else if (p.kind === 'smoke') { p.vy -= 20 * dt; p.x += (p.vx + G.wind * 0.4) * dt; p.y += p.vy * dt; }
    else if (p.kind === 'ring') p.r += (p.max - p.r) * 8 * dt;
  }
  for (let i = G.pops.length - 1; i >= 0; i--) { const o = G.pops[i]; o.t += dt; o.y -= 26 * dt; if (o.t >= o.life) G.pops.splice(i, 1); }
}

// ---------- rendering ----------
const VIGNETTE = (() => {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,8,0.5)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  return c;
})();
function draw() {
  if (G.showTitle) { drawTitle(); return; }
  ctx.fillStyle = '#05060c';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, MQ, VW, VH); ctx.clip();
  // sky
  const sky = ctx.createLinearGradient(0, MQ, 0, MQ + VH);
  sky.addColorStop(0, '#0a0d1c'); sky.addColorStop(0.55, '#070810'); sky.addColorStop(1, '#04050a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, MQ, VW, VH);
  srand(G.seed ^ 0x51a2);
  for (let i = 0; i < 90; i++) {
    const sx = rng(0, VW), sy = MQ + rng(0, VH * 0.8);
    ctx.fillStyle = `rgba(200,220,255,${rng(0.05, 0.3)})`;
    ctx.fillRect(sx, sy, i % 7 === 0 ? 2 : 1.4, i % 7 === 0 ? 2 : 1.4);
  }
  // wind streamers
  ctx.strokeStyle = hexA('#7fb0d0', 0.18);
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    const yy = MQ + 40 + i * 34;
    const off = (G.time * G.wind * 2.2 + i * 160) % (VW + 120) - 60;
    const len = clamp(Math.abs(G.wind) * 1.4, 8, 60) * Math.sign(G.wind || 1);
    ctx.beginPath(); ctx.moveTo(off, yy); ctx.lineTo(off + len, yy); ctx.stroke();
  }
  if (G.shake > 0) ctx.translate(rng(-1, 1) * G.shake * 0.5, rng(-1, 1) * G.shake * 0.35);

  // distant ridge silhouette (parallax flavor)
  ctx.fillStyle = 'rgba(30,40,70,0.35)';
  ctx.beginPath();
  ctx.moveTo(0, MQ + VH);
  srand(G.seed ^ 0x99);
  for (let x = 0; x <= VW; x += 32) {
    ctx.lineTo(x, MQ + VH - G.terra[clamp(x, 0, TW_ - 1)] * 0.55 - 60 - rng(0, 20));
  }
  ctx.lineTo(VW, MQ + VH);
  ctx.closePath(); ctx.fill();

  // terrain: filled silhouette with glowing crust
  ctx.beginPath();
  ctx.moveTo(0, MQ + VH);
  for (let x = 0; x < TW_; x++) ctx.lineTo(x, MQ + VH - G.terra[x]);
  ctx.lineTo(TW_ - 1, MQ + VH);
  ctx.closePath();
  const tg = ctx.createLinearGradient(0, MQ + VH - 320, 0, MQ + VH);
  tg.addColorStop(0, '#1c2438'); tg.addColorStop(0.5, '#131a2a'); tg.addColorStop(1, '#0a0e18');
  ctx.fillStyle = tg;
  ctx.fill();
  // strata speckle
  srand(G.seed ^ 0x777);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let i = 0; i < 260; i++) {
    const x = rng(0, TW_) | 0;
    const y = MQ + VH - rng(4, Math.max(6, G.terra[x] - 4));
    ctx.fillRect(x, y, 2, 2);
  }
  // crust glow
  ctx.save();
  ctx.shadowColor = '#33d6ff'; ctx.shadowBlur = 7;
  ctx.strokeStyle = hexA('#5fd4ff', 0.55);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, MQ + VH - G.terra[0]);
  for (let x = 1; x < TW_; x += 2) ctx.lineTo(x, MQ + VH - G.terra[x]);
  ctx.stroke();
  ctx.restore();

  // napalm pools
  for (const f of G.fires) {
    const fy = groundY(f.x);
    const fl = 0.6 + Math.sin(G.time * 11 + f.x) * 0.4;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fg = ctx.createRadialGradient(f.x, fy, 0, f.x, fy, 18);
    fg.addColorStop(0, hexA('#ffd12a', 0.5 * fl)); fg.addColorStop(0.5, hexA('#ff8c42', 0.3 * fl)); fg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.arc(f.x, fy, 18, 0, 7); ctx.fill();
    ctx.fillStyle = hexA('#ffd12a', fl);
    ctx.beginPath();
    ctx.moveTo(f.x - 4, fy);
    ctx.quadraticCurveTo(f.x - 2, fy - 8 - fl * 6, f.x, fy - 3 - fl * 3);
    ctx.quadraticCurveTo(f.x + 2, fy - 10 - fl * 5, f.x + 4, fy);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // last trace (faint) — the tracer's teaching line
  if (G.trace && G.trace.length > 4) {
    ctx.strokeStyle = hexA('#8ab0d0', 0.22);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(G.trace[0], G.trace[1]);
    for (let i = 2; i < G.trace.length; i += 2) ctx.lineTo(G.trace[i], G.trace[i + 1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // tanks
  for (const t of G.tanks) drawTank(t);

  // live shots with additive tracer trails
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const s of G.shots) {
    const col = TEAM_COL[s.owner] || '#ffffff';
    for (let i = Math.max(0, s.trail.length - 60); i < s.trail.length; i += 2) {
      const k = (i - (s.trail.length - 60)) / 60;
      ctx.fillStyle = hexA(col, Math.max(0, k) * 0.5);
      ctx.fillRect(s.trail[i] - 1, s.trail[i + 1] - 1, 2, 2);
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, 7); ctx.fill();
    const gl = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 12);
    gl.addColorStop(0, hexA(col, 0.6)); gl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(s.x, s.y, 12, 0, 7); ctx.fill();
  }
  ctx.restore();

  // particles
  ctx.save();
  for (const p of G.parts) {
    const k = 1 - p.t / p.life;
    if (p.kind === 'chip') {
      ctx.globalAlpha = k;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    } else if (p.kind === 'smoke') {
      ctx.globalAlpha = k * 0.35;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4 + (1 - k) * 9, 0, 7); ctx.fill();
    } else if (p.kind === 'flash') {
      ctx.globalCompositeOperation = 'lighter';
      const g2 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      g2.addColorStop(0, hexA('#ffffff', k)); g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else if (p.kind === 'ring') {
      ctx.globalAlpha = k * 0.9;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.5 * k + 0.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  for (const o of G.pops) {
    const k = 1 - o.t / o.life;
    ctx.globalAlpha = k;
    ctx.font = `800 13px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = o.color;
    ctx.fillText(o.txt, o.x, o.y);
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  drawTopBar();
  drawHUD();
  if (G.mode === 'shop') drawShop();
  if (G.mode === 'won') { dimWorld(); banner('LAST TANK GLOWING', TEAM_COL[0], endStats()); bannerButton('NEW WAR  ·  SPACE', TEAM_COL[0]); }
  if (G.mode === 'lost') { dimWorld(); banner('SCRAP METAL', TEAM_COL[1], endStats()); bannerButton('NEW WAR  ·  SPACE', TEAM_COL[1]); }
  ctx.drawImage(VIGNETTE, 0, 0);
}
function endStats() {
  const s = G.stats;
  return `ROUND ${G.round}/${G.maxRounds} · SHOTS ${s.shots[0]} · HITS ${s.hits[0]} · DAMAGE DEALT ${s.dmg[0]}`;
}
function dimWorld() {
  ctx.fillStyle = 'rgba(4,5,10,0.55)';
  ctx.fillRect(0, MQ, W, VH);
}
function drawTank(t) {
  if (t.dead) {
    // a scorched wreck remains
    ctx.fillStyle = '#2a2f3a';
    ctx.beginPath(); ctx.roundRect(t.x - 10, t.y - 7, 20, 7, 3); ctx.fill();
    ctx.fillStyle = 'rgba(90,90,102,0.5)';
    ctx.fillRect(t.x - 3, t.y - 12, 5, 5);
    return;
  }
  const c = TEAM_COL[t.id];
  const flash = t.hurtT > 0;
  if (flash) t.hurtT = Math.max(0, t.hurtT - SIMSTEP);
  ctx.save();
  // glow pool
  ctx.globalCompositeOperation = 'lighter';
  const gp = ctx.createRadialGradient(t.x, t.y - 6, 0, t.x, t.y - 6, 34);
  gp.addColorStop(0, hexA(c, 0.16)); gp.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gp;
  ctx.beginPath(); ctx.arc(t.x, t.y - 6, 34, 0, 7); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  // shadow
  ctx.fillStyle = 'rgba(0,0,10,0.55)';
  ctx.beginPath(); ctx.ellipse(t.x, t.y + 1, 14, 3.5, 0, 0, 7); ctx.fill();
  // barrel
  const a = t.angle * Math.PI / 180;
  ctx.strokeStyle = flash ? '#ffffff' : shade(c, 0.25);
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(t.x, t.y - 9);
  ctx.lineTo(t.x + Math.cos(a) * 17, t.y - 9 - Math.sin(a) * 17);
  ctx.stroke();
  // hull
  ctx.fillStyle = flash ? '#ffffff' : shade(c, -0.35);
  ctx.strokeStyle = flash ? '#ffffff' : c;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.roundRect(t.x - 12, t.y - 9, 24, 8, 4); ctx.fill(); ctx.stroke();
  // dome
  ctx.beginPath(); ctx.arc(t.x, t.y - 9, 6, Math.PI, 0); ctx.fill(); ctx.stroke();
  // shield bubble
  if (t.shield > 0) {
    ctx.strokeStyle = hexA('#5aff9e', 0.4 + Math.sin(G.time * 5) * 0.15);
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(t.x, t.y - 8, 22, 0, 7); ctx.stroke();
  }
  // hp pips above
  const hpw = 26;
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  ctx.fillRect(t.x - hpw / 2, t.y - 26, hpw, 3);
  ctx.fillStyle = t.hp > 40 ? c : '#ff5c5c';
  ctx.fillRect(t.x - hpw / 2, t.y - 26, hpw * (t.hp / 100), 3);
  // turn caret
  if (G.turn === t.id && G.phase === 'aim' && G.mode === 'play') {
    const bob = Math.sin(G.time * 5) * 3;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(t.x, t.y - 36 + bob); ctx.lineTo(t.x - 5, t.y - 43 + bob); ctx.lineTo(t.x + 5, t.y - 43 + bob);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// ---------- chrome ----------
function label(txt, x, HY) {
  ctx.font = '700 10px Verdana, sans-serif';
  ctx.letterSpacing = '2px';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(140,175,210,0.75)';
  ctx.fillText(txt, x, HY + 26);
  ctx.letterSpacing = '0px';
}
function drawTopBar() {
  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, W, MQ);
  ctx.fillStyle = 'rgba(200,220,240,0.4)';
  ctx.fillRect(0, MQ - 1.5, W, 1.5);
  ctx.font = '700 13px Verdana, sans-serif';
  ctx.letterSpacing = '2px';
  // tanks' hp
  G.tanks.forEach((t, i) => {
    ctx.textAlign = i === 0 ? 'left' : 'right';
    const x = i === 0 ? 24 : W - 24 - (i - 1) * 170;
    ctx.fillStyle = t.dead ? 'rgba(120,130,150,0.5)' : TEAM_COL[i];
    ctx.fillText(`${i === 0 ? 'YOU' : 'FOE ' + i} ${Math.ceil(t.hp)}`, x, 24);
  });
  // wind gauge center
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(190,215,240,0.9)';
  ctx.fillText(`ROUND ${G.round}/${G.maxRounds}`, W / 2 - 130, 24);
  const wx = W / 2 + 30;
  ctx.fillStyle = 'rgba(140,175,210,0.75)';
  ctx.font = '700 10px Verdana, sans-serif';
  ctx.fillText('WIND', wx - 58, 24);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(wx - 40, 12, 140, 12);
  ctx.fillStyle = 'rgba(240,250,255,0.5)';
  ctx.fillRect(wx + 30 - 0.75, 10, 1.5, 16);
  const wk = clamp(G.wind / WIND_MAX, -1, 1);
  ctx.fillStyle = Math.abs(G.wind) > 25 ? '#ff8c42' : '#5fd4ff';
  if (wk >= 0) ctx.fillRect(wx + 30, 13, 68 * wk, 10);
  else ctx.fillRect(wx + 30 + 68 * wk, 13, -68 * wk, 10);
  ctx.font = `800 12px ${MONO}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(String(Math.abs(G.wind)) + (G.wind >= 0 ? ' →' : ' ←'), wx + 106, 23);
  ctx.letterSpacing = '0px';
  if (G.hintT > 0 && G.mode === 'play') {
    const HINTS = [
      'ARROWS AIM · HOLD FOR FINE CONTROL · SPACE FIRES · THE WIND CHANGES EVERY TURN',
      'TAB CYCLES WEAPONS · DIRT BURIES · NAPALM FLOWS DOWNHILL · MIRV SPLITS AT THE APEX',
      'DAMAGE EARNS CASH · SPEND IT IN THE ARMORY BETWEEN ROUNDS',
    ];
    ctx.globalAlpha = Math.min(1, G.hintT);
    ctx.font = '600 12px Verdana, sans-serif';
    ctx.letterSpacing = '2px';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(210,232,255,0.9)';
    ctx.fillText(HINTS[Math.floor(G.time / 8) % HINTS.length], W / 2, MQ + 24);
    ctx.globalAlpha = 1;
    ctx.letterSpacing = '0px';
  }
}
function drawHUD() {
  const HY = H - HUD_H;
  const me = G.tanks[0];
  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, HY, W, HUD_H);
  ctx.fillStyle = 'rgba(200,220,240,0.45)';
  ctx.fillRect(0, HY, W, 1.5);
  // angle / power readouts
  label('ANGLE', 26, HY);
  ctx.font = `800 26px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(Math.round(me.angle)) + '°', 26, HY + 62);
  label('POWER', 150, HY);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(Math.round(me.power)), 150, HY + 62);
  // power bar
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.roundRect(26, HY + 76, 224, 10, 5); ctx.fill();
  const pg = ctx.createLinearGradient(26, 0, 250, 0);
  pg.addColorStop(0, '#1a7fa8'); pg.addColorStop(1, TEAM_COL[0]);
  ctx.fillStyle = pg;
  ctx.beginPath(); ctx.roundRect(26, HY + 76, 224 * (me.power / 100), 10, 5); ctx.fill();
  // weapon chips
  let hovTip = null;
  WEAPON_ORDER.forEach((wk, i) => {
    const bx = 300 + i * 96, by = HY + 12, bw = 86, bh = 66;
    const w = WEAPONS[wk];
    const n = me.ammo[wk];
    const have = n === Infinity || n > 0;
    const armed = me.weapon === wk;
    const hov = mouse.x > bx && mouse.x < bx + bw && mouse.y > by && mouse.y < by + bh;
    if (hov) hovTip = { wk, bx };
    if (armed && have) {
      ctx.save();
      ctx.shadowColor = TEAM_COL[0]; ctx.shadowBlur = 9;
      ctx.fillStyle = hexA(TEAM_COL[0], 0.25);
      ctx.strokeStyle = TEAM_COL[0]; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7); ctx.fill(); ctx.stroke();
      ctx.restore();
    } else if (armed) {
      ctx.strokeStyle = hexA(TEAM_COL[0], 0.55); ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7); ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = hov && have ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
      ctx.strokeStyle = have ? (hov ? 'rgba(200,230,255,0.8)' : 'rgba(160,195,230,0.45)') : 'rgba(160,195,230,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7); ctx.fill(); ctx.stroke();
    }
    ctx.font = '900 15px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = have ? TEAM_COL[0] : 'rgba(160,195,230,0.35)';
    ctx.fillText(w.glyph, bx + bw / 2, by + 26);
    ctx.font = '700 7.5px Verdana, sans-serif';
    ctx.letterSpacing = '0.5px';
    ctx.fillStyle = have ? 'rgba(210,232,255,0.95)' : 'rgba(160,195,230,0.4)';
    ctx.fillText(w.name, bx + bw / 2, by + 42);
    ctx.letterSpacing = '0px';
    ctx.font = `800 12px ${MONO}`;
    ctx.fillStyle = have ? '#ffffff' : 'rgba(200,220,245,0.45)';
    ctx.fillText(n === Infinity ? '∞' : String(n), bx + bw / 2, by + 58);
    // hotkey
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.strokeStyle = 'rgba(160,195,230,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(bx + bw - 17, by + 4, 13, 13, 3); ctx.fill(); ctx.stroke();
    ctx.font = `800 9px ${MONO}`;
    ctx.fillStyle = 'rgba(225,240,255,0.9)';
    ctx.fillText(String(i + 1), bx + bw - 10.5, by + 13.5);
  });
  // cash + fire button
  label('CASH', 918, HY);
  ctx.font = `800 20px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffd12a';
  ctx.fillText('$' + me.cash, 918, HY + 58);
  const myTurn = G.turn === 0 && G.phase === 'aim' && G.mode === 'play' && !me.ai && !me.dead;
  const fbx = 1030, fby = HY + 18, fbw = 220, fbh = 62;
  const fhov = mouse.x > fbx && mouse.x < fbx + fbw && mouse.y > fby && mouse.y < fby + fbh;
  ctx.save();
  if (myTurn) { ctx.shadowColor = TEAM_COL[0]; ctx.shadowBlur = fhov ? 18 : 10; }
  ctx.fillStyle = myTurn ? hexA(TEAM_COL[0], fhov ? 0.4 : 0.25) : 'rgba(255,255,255,0.04)';
  ctx.strokeStyle = myTurn ? TEAM_COL[0] : 'rgba(160,195,230,0.25)';
  ctx.lineWidth = myTurn ? 2.5 : 1;
  ctx.beginPath(); ctx.roundRect(fbx, fby, fbw, fbh, 10); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.font = '900 20px "Arial Black", Arial, sans-serif';
  ctx.letterSpacing = '3px';
  ctx.textAlign = 'center';
  ctx.fillStyle = myTurn ? '#ffffff' : 'rgba(160,195,230,0.5)';
  ctx.fillText(myTurn ? 'FIRE' : G.phase === 'flight' ? 'SHOT AWAY' : 'HOLD', fbx + fbw / 2, fby + 39);
  ctx.letterSpacing = '0px';
  ctx.restore();
  // tooltip
  if (hovTip) {
    const w = WEAPONS[hovTip.wk];
    const descs = {
      tracer: 'A harmless spotting round: learn the wind for free',
      missile: 'The honest workhorse: 26px bite, 42 damage',
      bigone: 'A 44px crater and 75 damage of consequence',
      mirv: 'Splits into 5 warheads at the top of its arc',
      napalm: 'Ignites and flows downhill, pooling in valleys',
      dirt: 'No damage: buries, entombs, and reshapes the land',
    };
    const tw2 = 300, th2 = 44, tx2 = clamp(hovTip.bx, 10, W - tw2 - 10), ty2 = HY - th2 - 8;
    ctx.fillStyle = 'rgba(6,10,18,0.96)';
    ctx.strokeStyle = 'rgba(180,210,240,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(tx2, ty2, tw2, th2, 6); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = '800 11px Verdana, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(w.name, tx2 + 10, ty2 + 17);
    ctx.font = `700 10px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(160,195,230,0.9)';
    ctx.fillText(w.cost ? '$' + w.cost + ' EACH' : 'FREE', tx2 + tw2 - 10, ty2 + 17);
    ctx.textAlign = 'left';
    ctx.font = '600 10px Verdana, sans-serif';
    ctx.fillStyle = 'rgba(210,232,255,0.85)';
    ctx.fillText(descs[hovTip.wk], tx2 + 10, ty2 + 33);
  }
}
function drawShop() {
  dimWorld();
  const by = H / 2 - 150, bh = 300;
  ctx.fillStyle = 'rgba(5,8,15,0.96)';
  ctx.fillRect(W / 2 - 330, by, 660, bh);
  ctx.strokeStyle = 'rgba(200,220,240,0.5)'; ctx.lineWidth = 1.5;
  ctx.strokeRect(W / 2 - 330, by, 660, bh);
  ctx.textAlign = 'center';
  ctx.font = '900 28px "Arial Black", Arial, sans-serif';
  ctx.letterSpacing = '4px';
  ctx.fillStyle = '#ffd12a';
  ctx.fillText('THE ARMORY', W / 2, by + 44);
  ctx.letterSpacing = '0px';
  ctx.font = '600 12px Verdana, sans-serif';
  ctx.fillStyle = 'rgba(210,232,255,0.9)';
  const me = G.tanks[0];
  ctx.fillText(`ROUND ${G.round} SURVIVED · YOUR CASH $${me.cash} · CLICK TO BUY · SPACE FOR ROUND ${G.round + 1}`, W / 2, by + 72);
  const buyable = WEAPON_ORDER.filter(k => WEAPONS[k].cost > 0);
  buyable.forEach((wk, i) => {
    const w = WEAPONS[wk];
    const bx = W / 2 - 300 + i * 152, byy = by + 100, bw = 140, bhh = 120;
    const afford = me.cash >= w.cost;
    const hov = mouse.x > bx && mouse.x < bx + bw && mouse.y > byy && mouse.y < byy + bhh;
    ctx.fillStyle = hov && afford ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.04)';
    ctx.strokeStyle = afford ? (hov ? '#ffd12a' : 'rgba(200,220,240,0.5)') : 'rgba(160,195,230,0.2)';
    ctx.lineWidth = hov && afford ? 2 : 1;
    ctx.beginPath(); ctx.roundRect(bx, byy, bw, bhh, 8); ctx.fill(); ctx.stroke();
    ctx.font = '900 22px "Arial Black", Arial, sans-serif';
    ctx.fillStyle = afford ? TEAM_COL[0] : 'rgba(160,195,230,0.4)';
    ctx.fillText(w.glyph, bx + bw / 2, byy + 34);
    ctx.font = '700 9px Verdana, sans-serif';
    ctx.fillStyle = afford ? 'rgba(220,238,255,0.95)' : 'rgba(160,195,230,0.45)';
    ctx.fillText(w.name, bx + bw / 2, byy + 54);
    ctx.font = `800 13px ${MONO}`;
    ctx.fillStyle = '#ffd12a';
    ctx.fillText('$' + w.cost, bx + bw / 2, byy + 76);
    ctx.font = `700 11px ${MONO}`;
    ctx.fillStyle = 'rgba(200,225,250,0.85)';
    ctx.fillText('HAVE ' + (me.ammo[wk] || 0), bx + bw / 2, byy + 98);
  });
}
function banner(title, color, sub) {
  ctx.save();
  const by = H / 2 - 78, bh = 140;
  ctx.fillStyle = 'rgba(5,8,15,0.94)';
  ctx.fillRect(0, by, W, bh);
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 10;
  ctx.fillStyle = color;
  ctx.fillRect(0, by, W, 2);
  ctx.fillRect(0, by + bh - 2, W, 2);
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.font = '900 40px "Arial Black", Arial, sans-serif';
  ctx.letterSpacing = '5px';
  ctx.shadowColor = color; ctx.shadowBlur = 24;
  ctx.fillStyle = color;
  ctx.fillText(title, W / 2, by + 58);
  ctx.shadowBlur = 0;
  ctx.font = '600 14px Verdana, sans-serif';
  ctx.letterSpacing = '3px';
  ctx.fillStyle = 'rgba(225,240,255,0.92)';
  ctx.fillText(sub, W / 2, by + 96);
  ctx.letterSpacing = '0px';
  ctx.restore();
}
function bannerButton(label2, color) {
  const bw2 = 260, bh2 = 40, bx2 = W / 2 - bw2 / 2, by2 = H / 2 + 76;
  const hov = mouse.x > bx2 && mouse.x < bx2 + bw2 && mouse.y > by2 && mouse.y < by2 + bh2;
  ctx.save();
  ctx.fillStyle = hov ? hexA(color, 0.3) : hexA(color, 0.12);
  ctx.strokeStyle = color; ctx.lineWidth = hov ? 2.5 : 1.5;
  if (hov) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
  ctx.beginPath(); ctx.roundRect(bx2, by2, bw2, bh2, 8); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.font = '800 15px Verdana, sans-serif';
  ctx.letterSpacing = '2px';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label2, W / 2, by2 + 26);
  ctx.letterSpacing = '0px';
  ctx.restore();
}
function drawTitle() {
  ctx.fillStyle = '#05060c';
  ctx.fillRect(0, 0, W, H);
  // a battle plays out dimly behind the title
  ctx.save();
  ctx.globalAlpha = 0.5;
  const keep = G.showTitle; G.showTitle = false;
  draw();
  G.showTitle = keep;
  ctx.restore();
  ctx.fillStyle = 'rgba(5,6,12,0.6)';
  ctx.fillRect(0, 0, W, H);
  const by = 108, bh = 310;
  ctx.fillStyle = 'rgba(5,8,15,0.9)';
  ctx.fillRect(0, by, W, bh);
  ctx.save();
  ctx.shadowColor = '#ff8c42'; ctx.shadowBlur = 9;
  ctx.fillStyle = 'rgba(255,140,66,0.6)';
  ctx.fillRect(0, by, W, 1.5);
  ctx.fillRect(0, by + bh - 1.5, W, 1.5);
  ctx.restore();
  ctx.textAlign = 'center';
  const ly = 240;
  ctx.font = '900 84px "Arial Black", Arial, sans-serif';
  ctx.letterSpacing = '8px';
  ctx.save();
  ctx.shadowColor = '#ff8c42'; ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffb075'; ctx.fillText('NEON SCORCH', W / 2, ly);
  ctx.shadowBlur = 4;
  ctx.fillStyle = '#ffffff'; ctx.fillText('NEON SCORCH', W / 2, ly);
  ctx.restore();
  ctx.letterSpacing = '5px';
  ctx.font = '600 17px Verdana, sans-serif';
  ctx.fillStyle = '#d0a27f';
  ctx.fillText('A TRIBUTE TO SCORCHED EARTH', W / 2, ly + 46);
  const a = (Math.sin(G.time * 4) + 1) / 2 * 0.45 + 0.55;
  ctx.globalAlpha = a;
  ctx.font = '900 24px "Arial Black", Arial, sans-serif';
  ctx.letterSpacing = '3px';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ff8c42'; ctx.shadowBlur = 12;
  ctx.fillText('PRESS SPACE TO OPEN FIRE', W / 2, ly + 118);
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  ctx.font = '600 13px Verdana, sans-serif';
  ctx.letterSpacing = '3px';
  ctx.fillStyle = 'rgba(180,210,235,0.95)';
  ctx.fillText('ONE HILL. TWO TANKS. THE WIND DECIDES WHO IS LYING.', W / 2, 468);
  ctx.fillStyle = 'rgba(160,190,220,0.85)';
  ctx.fillText('MISSILE · THE BIG ONE · MIRV · NAPALM · DIRT BALL · TRACER', W / 2, 496);
  ctx.letterSpacing = '0px';
  ctx.drawImage(VIGNETTE, 0, 0);
}

// ---------- input ----------
const keys = {};
let mouse = { x: 0, y: 0 };
window.addEventListener('keydown', e => {
  const k = e.key;
  keys[k] = true;
  if (k === ' ') e.preventDefault();
  if (k === 'Tab') e.preventDefault();
  audio();
  if (G.showTitle && (k === ' ' || k === 'Enter')) { G.showTitle = false; newGame((Math.random() * 1e9) >>> 0, { human: 0, tanks: 2, rounds: 3 }); return; }
  if ((G.mode === 'won' || G.mode === 'lost') && k === ' ' && G.modeT > 0.6) { newGame((Math.random() * 1e9) >>> 0, { human: 0, tanks: 2, rounds: 3 }); return; }
  if (G.mode === 'shop' && k === ' ' && G.modeT > 0.4) { startNextRound(); return; }
  const me = G.tanks[0];
  const myTurn = G.turn === 0 && G.phase === 'aim' && G.mode === 'play' && !me.ai && !me.dead;
  if (myTurn) {
    if (k === ' ') { fireShot(me); return; }
    if (k === 'Tab') {
      let i = WEAPON_ORDER.indexOf(me.weapon);
      for (let n = 0; n < WEAPON_ORDER.length; n++) {
        i = (i + 1) % WEAPON_ORDER.length;
        const wk = WEAPON_ORDER[i];
        if (me.ammo[wk] === Infinity || me.ammo[wk] > 0) { me.weapon = wk; break; }
      }
    }
    const num = Number(k) - 1;
    if (num >= 0 && num < WEAPON_ORDER.length) {
      const wk = WEAPON_ORDER[num];
      if (me.ammo[wk] === Infinity || me.ammo[wk] > 0) me.weapon = wk;
    }
  }
});
window.addEventListener('keyup', e => { keys[e.key] = false; });
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) * (W / r.width);
  mouse.y = (e.clientY - r.top) * (H / r.height);
  canvas.style.cursor = (mouse.y > H - HUD_H || G.mode !== 'play') ? 'pointer' : 'crosshair';
});
canvas.addEventListener('mousedown', e => {
  audio();
  if (G.showTitle) { G.showTitle = false; newGame((Math.random() * 1e9) >>> 0, { human: 0, tanks: 2, rounds: 3 }); return; }
  if ((G.mode === 'won' || G.mode === 'lost') && G.modeT > 0.6) {
    const bx2 = W / 2 - 130, by2 = H / 2 + 76;
    if (mouse.x > bx2 && mouse.x < bx2 + 260 && mouse.y > by2 && mouse.y < by2 + 40) { newGame((Math.random() * 1e9) >>> 0, { human: 0, tanks: 2, rounds: 3 }); return; }
    return;
  }
  if (G.mode === 'shop') {
    const by = H / 2 - 150;
    const me = G.tanks[0];
    const buyable = WEAPON_ORDER.filter(k => WEAPONS[k].cost > 0);
    buyable.forEach((wk, i) => {
      const bx = W / 2 - 300 + i * 152, byy = by + 100;
      if (mouse.x > bx && mouse.x < bx + 140 && mouse.y > byy && mouse.y < byy + 120) {
        const w = WEAPONS[wk];
        if (me.cash >= w.cost) { me.cash -= w.cost; me.ammo[wk] = (me.ammo[wk] || 0) + 1; SFX.cash(); }
        else SFX.hurt();
      }
    });
    return;
  }
  const HY = H - HUD_H;
  const me = G.tanks[0];
  if (mouse.y > HY) {
    WEAPON_ORDER.forEach((wk, i) => {
      const bx = 300 + i * 96;
      if (mouse.x > bx && mouse.x < bx + 86 && mouse.y > HY + 12 && mouse.y < HY + 78) {
        if (me.ammo[wk] === Infinity || me.ammo[wk] > 0) me.weapon = wk;
      }
    });
    const myTurn = G.turn === 0 && G.phase === 'aim' && G.mode === 'play' && !me.ai && !me.dead;
    if (myTurn && mouse.x > 1030 && mouse.x < 1250 && mouse.y > HY + 18 && mouse.y < HY + 80) fireShot(me);
  }
});
function humanAim(dt) {
  const me = G.tanks[0];
  if (me.ai || me.dead || G.turn !== 0 || G.phase !== 'aim' || G.mode !== 'play') return;
  const fine = keys.Shift ? 0.25 : 1;
  let moved = false;
  if (keys.ArrowLeft) { me.angle = clamp(me.angle + 40 * dt * fine, 0, 180); moved = true; }
  if (keys.ArrowRight) { me.angle = clamp(me.angle - 40 * dt * fine, 0, 180); moved = true; }
  if (keys.ArrowUp) { me.power = clamp(me.power + 30 * dt * fine, 5, 100); moved = true; }
  if (keys.ArrowDown) { me.power = clamp(me.power - 30 * dt * fine, 5, 100); moved = true; }
  if (moved && G.tick % 6 === 0) SFX.aim();
}

// ---------- main loop ----------
let last = 0, acc = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min((t - last) / 1000, 1 / 15);
  last = t;
  acc += dt;
  let n = 0;
  while (acc >= SIMSTEP && n < 5) { humanAim(SIMSTEP); sim(SIMSTEP); acc -= SIMSTEP; n++; }
  draw();
}

// ---------- harnesses ----------
function stepFor(s) { const n2 = Math.round(s / SIMSTEP); for (let i = 0; i < n2; i++) sim(SIMSTEP); }
function stepUntil(cond, cap) { let n2 = 0; while (!cond() && n2 < cap) { sim(SIMSTEP); n2++; } }
function runShot(name) {
  AUDIO_ON = false;
  const seed = 424242;
  if (name === 'title') {
    newGame(seed, { tanks: 2, rounds: 3 });
    stepFor(20);
    G.showTitle = true;
    G.time = 1.2;
  } else if (name === 'duel') {
    newGame(seed, { tanks: 2, rounds: 3 });
    // catch a shot descending into frame, trail streaming behind it
    stepUntil(() => G.shots.length > 0, 60 * 30);
    stepUntil(() => G.shots.length > 0 && G.shots[0].vy > 40 && G.shots[0].y > MQ + 90, 60 * 10);
  } else if (name === 'crater') {
    newGame(seed, { tanks: 2, rounds: 3 });
    stepUntil(() => G.log.length >= 3, 60 * 90);
    stepFor(0.5);
  } else if (name === 'mirv') {
    newGame(seed, { tanks: 2, rounds: 3 });
    const t = G.tanks[0];
    t.ammo.mirv = 1; t.weapon = 'mirv';
    t.angle = 62; t.power = 82;
    fireShot(t, { silent: true });
    stepUntil(() => G.shots.length > 1, 60 * 10);   // after the split
    stepUntil(() => G.shots.length > 1 && G.shots[0].y > MQ + 110, 60 * 10);   // fan visible in frame
  } else if (name === 'napalm') {
    newGame(seed, { tanks: 2, rounds: 3 });
    const t = G.tanks[0];
    t.ammo.napalm = 1; t.weapon = 'napalm';
    const sol = solveAim(t, G.tanks[1], G.wind, 0);
    if (sol) { t.angle = sol.angle; t.power = sol.power; }
    fireShot(t, { silent: true });
    stepUntil(() => G.fires.length > 0, 60 * 15);
    stepFor(1.2);
  } else if (name === 'dirt') {
    newGame(seed, { tanks: 2, rounds: 3 });
    const t = G.tanks[0];
    t.ammo.dirt = 1; t.weapon = 'dirt';
    const sol = solveAim(t, G.tanks[1], G.wind, 0);
    if (sol) { t.angle = sol.angle; t.power = sol.power; }
    fireShot(t, { silent: true });
    stepUntil(() => G.phase === 'resolve', 60 * 15);
    stepFor(0.4);
  } else if (name === 'bigone') {
    newGame(seed, { tanks: 2, rounds: 3 });
    const t = G.tanks[0];
    t.ammo.bigone = 1; t.weapon = 'bigone';
    const sol = solveAim(t, G.tanks[1], G.wind, 0);
    if (sol) { t.angle = sol.angle; t.power = sol.power; }
    fireShot(t, { silent: true });
    stepUntil(() => G.phase === 'resolve', 60 * 15);
    stepFor(0.25);
  } else if (name === 'shop') {
    newGame(seed, { tanks: 2, rounds: 3 });
    G.tanks[0].cash = 1800;
    G.mode = 'shop'; G.modeT = 1;
  } else if (name === 'win') {
    newGame(seed, { tanks: 2, rounds: 1, ai: ['solver', 'null'] });
    stepUntil(() => G.mode === 'won', 60 * 600);
    stepFor(0.3);
    if (G.mode !== 'won') { document.title = 'shot-FAILED'; return; }
  } else if (name === 'fail') {
    newGame(seed, { tanks: 2, rounds: 1, ai: ['null', 'solver'] });
    stepUntil(() => G.mode === 'lost', 60 * 600);
    stepFor(0.3);
    if (G.mode !== 'lost') { document.title = 'shot-FAILED'; return; }
  } else {
    newGame(seed, { tanks: 2 });
    stepFor(4);
  }
  draw();
  if (document.title !== 'shot-FAILED') document.title = 'shot-ready';
}
function runVerify(mode) {
  try { runVerifyInner(mode); }
  catch (e) { document.title = 'ERR:' + String(e && e.stack || e).replace(/\n/g, ' | ').slice(0, 300); }
}
function runVerifyInner(mode) {
  AUDIO_ON = false;
  const seed = 424242;
  let outcome = 'FAILED', extra = {};
  const duels = {
    solution: ['solver', 'canon'], null: ['null', 'canon'],
    'ablate-wind': ['windblind', 'canon'],
  };
  if (duels[mode]) {
    const [a, b] = duels[mode];
    newGame(seed, { tanks: 2, rounds: 3, ai: [a, b], aiNoise: 14 });
    let simTime = 0;
    const cap = Number(new URLSearchParams(location.search).get('t') || 900);
    while (simTime < cap && G.mode !== 'won' && G.mode !== 'lost') {
      if (G.mode === 'shop') startNextRound();
      sim(SIMSTEP);
      simTime += SIMSTEP;
    }
    outcome = G.mode === 'won' ? 'WON' : G.mode === 'lost' ? 'LOST' : 'STALEMATE';
    const meanErr = a2 => a2.length ? Math.round(a2.reduce((x, y2) => x + y2, 0) / a2.length) : -1;
    extra = {
      time: Math.round(simTime), rounds: G.round,
      hp: G.tanks.map(t => Math.ceil(t.hp)),
      shots: G.stats.shots.slice(0, 2), hits: G.stats.hits.slice(0, 2), dmg: G.stats.dmg.slice(0, 2),
      solverErr: meanErr(G.stats.err[0]), foeErr: meanErr(G.stats.err[1]),
    };
  } else if (mode === 'mech-parabola') {
    // no wind: impact must match the closed-form range within 2%
    newGame(seed, { tanks: 2 });
    G.wind = 0;
    const t = G.tanks[0];
    t.angle = 45; t.power = 62;
    // flatten the world so the closed form applies
    for (let x = 0; x < TW_; x++) G.terra[x] = 200;
    for (const tk of G.tanks) tk.y = groundY(tk.x);
    const a = Math.PI / 4, v = 62 * POWER_V;
    const [mx, my] = muzzle(t);
    const y0 = (MQ + VH - 200) - my;   // muzzle height above the flat ground (positive)
    const vx = Math.cos(a) * v, vy = Math.sin(a) * v;
    const tf = (vy + Math.sqrt(vy * vy + 2 * GRAV * y0)) / GRAV;
    const expect = mx + vx * tf;
    fireShot(t, { silent: true });
    stepUntil(() => G.phase === 'resolve', 60 * 20);
    const got = G.impactX;
    const errPct = Math.abs(got - expect) / Math.abs(expect - mx) * 100;
    outcome = errPct < 2 ? 'SOLVED' : 'FAILED';
    extra = { expect: Math.round(expect), got: Math.round(got), errPct: Math.round(errPct * 100) / 100 };
  } else if (mode === 'mech-wind') {
    // same shot, tail wind vs head wind: impacts must straddle the calm shot in order
    const shoot = wind => {
      newGame(seed, { tanks: 2 });
      for (let x = 0; x < TW_; x++) G.terra[x] = 200;
      for (const tk of G.tanks) tk.y = groundY(tk.x);
      G.wind = wind;
      const t = G.tanks[0];
      t.angle = 55; t.power = 55;
      fireShot(t, { silent: true });
      stepUntil(() => G.phase === 'resolve', 60 * 20);
      return G.impactX;
    };
    const calm = shoot(0), tail = shoot(30), head = shoot(-30);
    outcome = tail > calm + 20 && head < calm - 20 ? 'SOLVED' : 'FAILED';
    extra = { head: Math.round(head), calm: Math.round(calm), tail: Math.round(tail) };
  } else if (mode === 'mech-crater') {
    newGame(seed, { tanks: 2 });
    const cx = 640;
    const before = G.terra[cx];
    carve(cx, MQ + VH - before, 30);
    const after = G.terra[cx];
    let width = 0;
    for (let x = 560; x < 720; x++) if (G.terra[x] < before - 4) width++;
    outcome = after < before - 15 && width > 30 ? 'SOLVED' : 'FAILED';
    extra = { before: Math.round(before), after: Math.round(after), craterWidth: width };
  } else if (mode === 'mech-dirt') {
    newGame(seed, { tanks: 2 });
    const cx = 640;
    const before = G.terra[cx];
    pile(cx, MQ + VH - before, WEAPONS.dirt.r);
    outcome = G.terra[cx] > before + 20 ? 'SOLVED' : 'FAILED';
    extra = { before: Math.round(before), after: Math.round(G.terra[cx]) };
  } else if (mode === 'mech-fall') {
    // undermine a tank: it must fall and take damage
    newGame(seed, { tanks: 2 });
    const t = G.tanks[1];
    const hp0 = t.hp;
    carve(t.x, groundY(t.x) + 40, 55);
    settleTanks(0);
    outcome = t.y > groundY(t.x) - 2 && t.hp < hp0 ? 'SOLVED' : 'FAILED';
    extra = { hp0, hp: Math.ceil(t.hp), fell: Math.round(t.y - t.fallFrom) };
  } else if (mode === 'mech-mirv') {
    newGame(seed, { tanks: 2 });
    const t = G.tanks[0];
    t.ammo.mirv = 1; t.weapon = 'mirv';
    t.angle = 65; t.power = 85;
    fireShot(t, { silent: true });
    let maxShots = 0;
    stepUntil(() => { maxShots = Math.max(maxShots, G.shots.length); return G.phase === 'resolve'; }, 60 * 25);
    const craters = G.log.filter(l => l.shot === 'mirvlet').length;
    outcome = maxShots >= WEAPONS.mirv.splits && craters >= 3 ? 'SOLVED' : 'FAILED';
    extra = { warheads: maxShots, impacts: craters };
  } else if (mode === 'mech-napalm') {
    newGame(seed, { tanks: 2 });
    // drop napalm on a known slope: fire must pool downhill of the impact
    for (let x = 0; x < TW_; x++) G.terra[x] = 200 + (x < 640 ? (640 - x) * 1.0 : 0);   // a real hillside: falls steadily to the right
    const t = G.tanks[0];
    t.ammo.napalm = 1; t.weapon = 'napalm';
    igniteNapalm(500, 0, 0);
    const xs = G.fires.map(f => f.x);
    const meanX = xs.reduce((a2, b2) => a2 + b2, 0) / xs.length;
    outcome = xs.length >= 3 && meanX > 500 ? 'SOLVED' : 'FAILED';
    extra = { pools: xs.length, impactX: 500, meanFireX: Math.round(meanX) };
  } else if (mode === 'mech-solver') {
    // the solver must out-aim its own noise floor: mean error under 25px over 5 seeds
    let errs = [];
    for (let s2 = 0; s2 < 5; s2++) {
      newGame(seed + s2 * 7, { tanks: 2 });
      const t = G.tanks[0];
      const sol = solveAim(t, G.tanks[1], G.wind, 0);
      if (sol) errs.push(Math.round(Math.abs(simulateShot(t, sol.angle, sol.power, G.wind) - G.tanks[1].x)));
    }
    const mean = errs.length ? errs.reduce((a2, b2) => a2 + b2, 0) / errs.length : 999;
    outcome = errs.length === 5 && mean < 25 ? 'SOLVED' : 'FAILED';
    extra = { errs, meanErr: Math.round(mean) };
  }
  const report = { mode, outcome, seed, ...extra };
  document.title = 'VERIFY:' + JSON.stringify(report);
  const el = document.createElement('pre');
  el.id = 'verify-report';
  el.textContent = document.title;
  document.body.appendChild(el);
  draw();
}

const q = new URLSearchParams(location.search);
const shotName = q.get('shot');
const verifyMode = q.get('verify');
if (shotName) runShot(shotName);
else if (verifyMode !== null) runVerify(verifyMode || 'solution');
else { newGame(445566, { tanks: 2, attract: true, ai: ['canon', 'canon'] }); requestAnimationFrame(t => { last = t; requestAnimationFrame(frame); }); }
