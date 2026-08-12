// Trackcrimental v1 — incremental top-down time-trial racer.
// Game glue: input, rendering (follow camera + minimap), HUD, economy, save.
// Physics lives in physics.js, track geometry/lap logic in track.js.

import {
  TICK, carParams, createCarState, stepCar,
} from "./physics.js";
import {
  ROAD_HALF, CENTER, N, CHECKPOINTS, START_GATE, START_POS, START_ANGLE,
  distToTrack, createLap, advanceLap,
} from "./track.js";
import { botField } from "./bots.js";

// ---------------------------------------------------------------- constants

const CANVAS_W = 960, CANVAS_H = 620;
const MAX_LAP_TICKS = 60 * 300;   // abort recording after 5 minutes
// A RACE IS THREE LAPS — for the player and for the bot ghosts alike. Lap 1
// is run from the standing start on the grid; laps 2 and 3 are flying laps
// (already at speed over the line) and are correspondingly quicker. This is
// pure framing for racing the bots and for lap-time attempts: the ECONOMY is
// untouched — your best single lap still becomes the earning ghost, which
// loops forever and pays per loop.
const RACE_LAPS = 3;

// ---------------------------------------------------------------- persistence
// PROTOTYPING MODE. With PERSISTENCE = false the game never reads or writes
// localStorage and actively CLEARS any trackcrimental_* keys at boot, so every
// refresh starts from a clean slate: zero credits, zero upgrade levels, no best
// lap, no earning ghost, default zoom and toggles. The save/load code below is
// intact and correct — flip this one constant back to true to restore saving.
const PERSISTENCE = false;

const SAVE_KEY = "trackcrimental_v4";
// Wiped: old physics/track = old ghosts and times invalid (v4: the v3 circuit
// with its tight hairpin plus the buffed drift boost changed both the lap
// distance and what lap times are earnable).
const OLD_SAVE_KEYS = ["trackcrimental_v0", "trackcrimental_v1",
  "trackcrimental_v2", "trackcrimental_v3"];
const SAVE_VERSION = 4;

const CAM_ZOOM_SLOW = 1.7;        // zoom at standstill (was fixed 2.0: more vision now)
const CAM_ZOOM_FAST = 1.45;       // zoom at top speed — fast = even more forward vision
const CAM_ZOOM_SMOOTH = 2.2;      // 1/s exponential smoothing (slow: zoom never pumps)
const CAM_SMOOTH = 3.8;           // 1/s exponential smoothing (position)
const CAM_ROT_SMOOTH = 5.0;       // 1/s exponential smoothing (rotation) — lower = more leeway
const CAM_LOOKAHEAD_T = 0.45;     // s of velocity look-ahead
const CAM_LOOKAHEAD_MAX = 120;    // px cap — the camera leads the car into corners
const CAM_ANCHOR_Y = 0.58;        // car sits below screen center: more road visible ahead
const CAM_FWD_MIN = 30;           // px/s forward speed where camera starts tracking velocity dir
const CAM_FWD_FULL = 140;         // px/s forward speed where it fully tracks velocity dir
// Drift/boost camera juice — deliberately subtle (casual player, no nausea).
const CAM_KICK_LAT = 9;           // px lateral impulse when a drift starts
const CAM_KICK_ROT = 0.04;        // rad (~2.3°) extra rotation lag when a drift starts
const CAM_KICK_DAMP = 7.5;        // 1/s spring-return of the kick (~0.4 s to settle)
const CAM_DRIFT_BIAS = 30;        // px of lateral bias per rad of slip while drifting
const CAM_DRIFT_BIAS_MAX = 16;    // px cap on that bias (see through the corner)
const CAM_DRIFT_BIAS_SMOOTH = 4;  // 1/s smoothing of the bias
const CAM_BOOST_ZOOM = 0.10;      // zoom-out pulse when a boost fires
const CAM_BOOST_KICK = 16;        // px forward camera kick when a boost fires
const CAM_PULSE_DAMP = 4.5;       // 1/s decay of the boost pulse (~0.5 s)
const MARK_LIFE = 240;            // tire mark fade time (ticks)
const MARK_MAX = 900;             // max stored tire mark segments
const USER_ZOOM_MIN = 0.4;        // scroll-wheel zoom-out floor (see most of the track)
const USER_ZOOM_MAX = 1.35;       // scroll-wheel zoom-in ceiling
const USER_ZOOM_STEP = 0.0016;    // wheel-delta -> zoom factor sensitivity
// Tire-mark / HUD colors per drift-charge tier (0 none, 1 blue, 2 orange).
const TIER_RGB = ["20,20,22", "84,158,255", "255,150,48"];

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// ---------------------------------------------------------------- upgrades

// `drives: true` marks an upgrade that changes how the CAR behaves — the ones
// the bots inherit (they drive your car) and the ones test/drive_bot.mjs sweeps
// for the ordering/monotonicity invariants. The economy upgrades below it are
// deliberately excluded from that regime: they cannot make anyone quicker.
const UPGRADES = [
  { id: "speed",  name: "Top Speed",    baseCost: 50, growth: 1.6, drives: true,
    desc: lvl => `+${lvl * 10}% max speed, +${(lvl * 2.6).toFixed(0)}% brakes` },
  { id: "accel",  name: "Acceleration", baseCost: 40, growth: 1.6, drives: true,
    desc: lvl => `+${lvl * 12}% accel, +${lvl * 8}% brakes` },
  { id: "grip",   name: "Grip",         baseCost: 45, growth: 1.6, drives: true,
    desc: lvl => `+${lvl} handling` },
  { id: "boostPwr", name: "Boost Power", baseCost: 90, growth: 1.65, drives: true,
    desc: lvl => `drift boost +${lvl * 9}% stronger` },
  { id: "boostDur", name: "Boost Duration", baseCost: 80, growth: 1.65, drives: true,
    desc: lvl => `drift boost +${lvl * 10}% longer` },
  { id: "payout", name: "Lap Payout",   baseCost: 60, growth: 1.7,
    desc: lvl => `x${(1 + lvl * 0.3).toFixed(1)} credits` },
  // The big income multiplier: every extra ghost replays your best lap on the
  // same loop and pays the same as the first, so income scales linearly with
  // the level while the price scales by 7x — buying the third one is a project.
  { id: "ghosts", name: "Ghost Fleet",  baseCost: 400, growth: 7,
    desc: lvl => `${lvl + 1} earning ghost${lvl ? "s" : ""} (x${lvl + 1} income)` },
];

function upgradeCost(u, lvl) {
  return Math.round(u.baseCost * Math.pow(u.growth, lvl));
}

// ---------------------------------------------------------------- state

const state = {
  currency: 0,
  levels: { speed: 0, accel: 0, grip: 0, boostPwr: 0, boostDur: 0, payout: 0, ghosts: 0 },
  bestTicks: null,      // best lap length in physics ticks
  ghostRec: null,       // best lap samples: [[x, y, angle], ...] one per tick
  ghostIndex: 0,
  car: createCarState(START_POS.x, START_POS.y, START_ANGLE),
  lap: createLap(),
  lapRec: [],           // current lap recording
  raceLaps: [],         // valid lap times (ticks) completed in THIS 3-lap race
  raceDone: false,      // 3 laps in the bag — R restarts the race
  offRoad: false,
  totalTicks: 0,
  showBotGhosts: true,  // G toggles the bot reference ghosts
  userZoom: 1,          // scroll-wheel zoom multiplier (1 = default follow zoom)
};

let params = carParams(state.levels);

const camera = {
  x: START_POS.x, y: START_POS.y, angle: START_ANGLE,
  zoom: CAM_ZOOM_SLOW,
  kickLat: 0,     // px lateral drift-start kick (spring-returns)
  kickRot: 0,     // rad rotation-lag drift-start kick (spring-returns)
  driftBias: 0,   // px smoothed slip-proportional lateral bias while drifting
  pulse: 0,       // 0..1 boost-fire pulse (drives zoom-out + forward kick)
};
// Bot reference ghosts ("is it just me?" calibration): four bot tiers, each
// a full THREE-LAP RACE from rest on the grid (lap 1 standing, laps 2-3
// flying), SIMULATED IN THE BROWSER on demand by bots.js.
//   NOVICE — timid keyboard driver.      MID — clean line, never drifts.
//   PRO — the optimal clean lap: brakes for the hairpin, never drifts.
//   PRO+ — slides the corners its corner analyser marks as drift zones and
//   fires the banked boost, worth ~1.5 s (13%) a lap over PRO.
// They drive YOUR CURRENT CAR (the same carParams(state.levels) you do), so
// buying an upgrade makes them quicker too and the race stays about driving.
// Purely visual — they never earn currency.
let botGhosts = [];     // {label, body, text, samples, bestFlying, standing, idx}
let lastSimMs = 0;      // ms the last (uncached) field simulation took

// Re-simulate the reference field for the current car. Cached inside bots.js
// on (car spec + track), so re-grids and repeat calls are free; only an
// upgrade purchase (or a track change) actually re-runs the physics.
function refreshBotField() {
  const field = botField(params);
  if (field.simMs) lastSimMs = field.simMs;
  // Keep playback position across a re-simulation so buying an upgrade
  // mid-race does not teleport the field back to the grid.
  const keep = botsLaunched ? botGhosts.map(g => g.idx) : null;
  botGhosts = field.map((g, i) => ({
    label: g.label, short: g.short, body: g.body, text: g.text,
    samples: g.samples,
    standing: g.lapTicks[0],
    bestFlying: g.bestFlyingTicks,
    idx: keep ? Math.min(keep[i] ?? 0, g.samples.length - 1) : 0,
  }));
  updateRefLaps();
  return field;
}

function updateRefLaps() {
  // Displayed times are each bot's best FLYING lap of its 3-lap race — the
  // like-for-like comparison against your own flying laps (their lap 1 is
  // ~1.2-1.9 s slower because it starts from rest on the grid). Four tiers
  // is too wide for one panel row: wrap to two color-coded lines.
  const bits = botGhosts.map(g =>
    `<span style="color:${g.text}" title="${g.label}: lap 1 (standing) ` +
    `${(g.standing / 60).toFixed(2)}s, best flying ${(g.bestFlying / 60).toFixed(2)}s">` +
    `${g.short} ${(g.bestFlying / 60).toFixed(1)}s</span>`);
  const lines = [];
  for (let i = 0; i < bits.length; i += 2) lines.push(bits.slice(i, i + 2).join(" "));
  el("refLaps").innerHTML = lines.length ? lines.join("<br>") : "–";
}

const marks = [];       // fading tire marks: {x1,y1,x2,y2,born,tier}
let lastRear = null;    // previous rear-wheel positions for mark segments
let wasDrifting = false;
let boostFlash = 0;     // ticks of "BOOST!" text remaining
let boostFlashTier = 1;
// Fair STANDING start: player and all bot ghosts share the same grid spot
// (START_POS, behind the line) at zero velocity. The bots sit parked there
// until the player first touches any drive control, then everyone launches
// together and accelerates from rest — the bot recordings begin at v=0 on
// the grid, so the drag race off the line is equal. Each bot then drives its
// whole THREE-LAP race once and holds its final frame; R re-grids everyone,
// re-arms the start and restarts the player's race too.
//
// Finishing all three laps ALSO re-grids automatically (see physicsStep), so
// the loop is: line up -> touch a control -> race -> back on the grid with
// the result on screen, ready to go again. Nothing about the earning ghost or
// the credit loop is touched by a re-grid.
let botsLaunched = false;
let pendingRegrid = null;   // result message to show once we are back on the grid

function resetCar() {
  const c = state.car;
  c.x = START_POS.x; c.y = START_POS.y;
  c.angle = START_ANGLE;
  c.vx = 0; c.vy = 0;
  c.steer = 0; c.grip = 1; c.yawRate = 0; c.drifting = false;
  c.stopHold = 0; c.reverseArmed = true;
  c.driftCharge = 0; c.boostTier = 0; c.boostTime = 0; c.boostAmt = 0;
  state.lap = createLap();
  state.lapRec = [];
  state.raceLaps = [];      // fresh 3-lap race
  state.raceDone = false;
  lastRear = null;
  wasDrifting = false;
  boostFlash = 0;
  // Re-line-up the bots at the start; they wait again for your first input.
  botsLaunched = false;
  for (const g of botGhosts) g.idx = 0;
  // Teleport = snap the camera too; smoothing a reset feels like a swoop.
  camera.x = START_POS.x; camera.y = START_POS.y; camera.angle = START_ANGLE;
  camera.zoom = CAM_ZOOM_SLOW;
  camera.kickLat = 0; camera.kickRot = 0; camera.driftBias = 0; camera.pulse = 0;
}

// ---------------------------------------------------------------- save/load

function save() {
  if (!PERSISTENCE) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      version: SAVE_VERSION,
      currency: state.currency,
      levels: state.levels,
      bestTicks: state.bestTicks,
      showBotGhosts: state.showBotGhosts,
      userZoom: state.userZoom,
      ghostRec: state.ghostRec
        ? state.ghostRec.map(s => [Math.round(s[0] * 10) / 10, Math.round(s[1] * 10) / 10, Math.round(s[2] * 1000) / 1000])
        : null,
    }));
  } catch (e) { /* storage may be unavailable; play on without saving */ }
}

function load() {
  try {
    if (!PERSISTENCE) {
      // Prototyping mode: leave no trace and inherit none. Every
      // trackcrimental_* key goes, including this version's, so a stale save
      // written before the flag was flipped cannot leak into a fresh run.
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("trackcrimental_")) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
      return;
    }
    // Physics changed: old saves' ghost times are invalid. Wipe them.
    for (const k of OLD_SAVE_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.version !== SAVE_VERSION) { localStorage.removeItem(SAVE_KEY); return; }
    if (typeof d.currency === "number") state.currency = d.currency;
    if (typeof d.showBotGhosts === "boolean") state.showBotGhosts = d.showBotGhosts;
    if (typeof d.userZoom === "number" && d.userZoom > 0) {
      state.userZoom = Math.max(USER_ZOOM_MIN, Math.min(USER_ZOOM_MAX, d.userZoom));
    }
    for (const u of UPGRADES) {
      if (d.levels && Number.isInteger(d.levels[u.id])) state.levels[u.id] = d.levels[u.id];
    }
    if (Number.isInteger(d.bestTicks) && Array.isArray(d.ghostRec) && d.ghostRec.length > 1) {
      state.bestTicks = d.bestTicks;
      state.ghostRec = d.ghostRec;
    }
  } catch (e) { /* corrupt save: start fresh */ }
}

// ---------------------------------------------------------------- economy

function ghostLapSeconds() { return state.bestTicks / 60; }

function ghostPayout() {
  // Faster laps pay more per lap (and also loop more often).
  return Math.max(1, Math.round((60 / ghostLapSeconds()) * 12)) * params.payoutMult;
}

// How many earning ghosts are on track (Ghost Fleet Lv0 = the original one).
function ghostCount() { return 1 + state.levels.ghosts; }

// Playback index of earning ghost `k`, staggered evenly around the lap so the
// fleet is spread out rather than stacked on top of each other.
function ghostSampleIndex(k) {
  const len = state.ghostRec.length;
  return (state.ghostIndex + Math.round(k * len / ghostCount())) % len;
}

// ---------------------------------------------------------------- input

const keys = {};
const KEYMAP = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
  Space: "drift", ShiftLeft: "drift", ShiftRight: "drift",
};

window.addEventListener("keydown", e => {
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); }
  if (e.code === "KeyR") { resetCar(); flashMsg(`Back on the grid — ${RACE_LAPS}-lap race re-armed.`); }
  if (e.code === "KeyG") {
    state.showBotGhosts = !state.showBotGhosts;
    save();
    flashMsg(state.showBotGhosts ? "Bot ghosts ON" : "Bot ghosts OFF");
  }
});
window.addEventListener("keyup", e => {
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = false; e.preventDefault(); }
});

// Scroll wheel over the canvas = zoom out/in (clamped). Scroll down zooms out
// to survey most of the track; scroll up zooms back in. Listener is on the
// canvas so the upgrade panel still scrolls normally.
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * USER_ZOOM_STEP);
  state.userZoom = Math.max(USER_ZOOM_MIN, Math.min(USER_ZOOM_MAX, state.userZoom * factor));
}, { passive: false });

// ---------------------------------------------------------------- game tick

function physicsStep() {
  const c = state.car;
  const px = c.x, py = c.y;

  state.offRoad = distToTrack(c.x, c.y) > ROAD_HALF;

  // Standing start: the player's FIRST touch of any drive control is the
  // "go" signal for the bot ghosts parked alongside on the grid.
  if (!botsLaunched && (keys.up || keys.down || keys.left || keys.right || keys.drift)) {
    botsLaunched = true;
  }

  const boostBefore = c.boostTime;
  stepCar(c, {
    throttle: keys.up ? 1 : 0,
    brake: keys.down ? 1 : 0,
    steer: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
    handbrake: !!keys.drift,
    offRoad: state.offRoad,
  }, params, TICK);

  // ---- camera juice triggers (applied/decayed in updateCamera) ----
  if (c.boostTime > 0 && boostBefore <= 0) {          // a drift boost just fired
    camera.pulse = 1;
    boostFlash = 55;
    boostFlashTier = c.boostTier;
  }
  if (c.drifting && !wasDrifting) {                   // a drift just started
    const dir = Math.sign(c.yawRate) || 1;
    camera.kickLat += CAM_KICK_LAT * dir;
    camera.kickRot -= CAM_KICK_ROT * dir;             // brief extra rotation lag
  }
  wasDrifting = c.drifting;

  // ---- tire marks while drifting (colored by banked charge tier) ----
  if (c.drifting) {
    const bx = c.x - Math.cos(c.angle) * 8, by = c.y - Math.sin(c.angle) * 8;
    const ox = -Math.sin(c.angle) * 5, oy = Math.cos(c.angle) * 5;
    const rear = [bx + ox, by + oy, bx - ox, by - oy];
    if (lastRear) {
      const tier = c.boostTier;
      marks.push({ x1: lastRear[0], y1: lastRear[1], x2: rear[0], y2: rear[1], born: state.totalTicks, tier });
      marks.push({ x1: lastRear[2], y1: lastRear[3], x2: rear[2], y2: rear[3], born: state.totalTicks, tier });
      if (marks.length > MARK_MAX) marks.splice(0, marks.length - MARK_MAX);
    }
    lastRear = rear;
  } else {
    lastRear = null;
  }
  if (boostFlash > 0) boostFlash--;

  // ---- lap / gate logic ----
  const ev = advanceLap(state.lap, px, py, c.x, c.y);
  if (state.lap.active && !ev.started) {
    state.lapRec.push([c.x, c.y, c.angle]);
    if (state.lap.ticks > MAX_LAP_TICKS) { state.lap.active = false; state.lapRec = []; }
  }
  if (ev.finished && ev.finished.valid) {
    // ECONOMY (unchanged): the best SINGLE lap — whichever of the race's
    // laps it is — becomes the earning ghost that loops forever and pays.
    if (state.bestTicks === null || ev.finished.ticks < state.bestTicks) {
      state.bestTicks = ev.finished.ticks;
      state.ghostRec = state.lapRec.slice();
      state.ghostIndex = 0;
      flashMsg(`New best: ${fmtTime(ev.finished.ticks)} — ghost updated!`);
      save();
    } else {
      flashMsg(`Lap: ${fmtTime(ev.finished.ticks)} (best ${fmtTime(state.bestTicks)})`);
    }
    // RACE (framing only): three laps, lap 1 from the standing start. The
    // third finish ends the race and puts you straight back on the grid,
    // stopped and re-armed, with the result on screen — the next race's
    // clock starts when you touch a control and cross the line, exactly as
    // after R.
    if (!state.raceDone) {
      state.raceLaps.push(ev.finished.ticks);
      if (state.raceLaps.length >= RACE_LAPS) {
        state.raceDone = true;
        const best = Math.min(...state.raceLaps);
        pendingRegrid = `Race complete — ${state.raceLaps.map(fmtTime).join(" / ")}` +
          ` · best ${fmtTime(best)}. Back on the grid — go when ready.`;
      }
    }
  } else if (ev.finished) {
    flashMsg("Lap didn't count — missed a checkpoint.");
  }
  if (ev.started) {
    state.lapRec = [[c.x, c.y, c.angle]];
  }

  // ---- ghost playback + income ----
  // The fleet all replays the SAME best-lap recording, each offset by a fixed
  // slice of the lap, and each pays a full lap's credits when its own offset
  // playhead wraps the line — so income is exactly ghostCount() x the single
  // ghost's rate, but arrives in evenly spaced instalments rather than one
  // lump. (Ghosts are income and decoration only: they never collide.)
  if (state.ghostRec) {
    const len = state.ghostRec.length;
    const n = ghostCount();
    const prev = state.ghostIndex;
    state.ghostIndex = (state.ghostIndex + 1) % len;
    const pay = ghostPayout();
    for (let k = 0; k < n; k++) {
      const off = Math.round(k * len / n);
      if ((prev + off) % len > (state.ghostIndex + off) % len) state.currency += pay;
    }
  }

  // Bot reference ghosts (no income). Parked on the grid until the player's
  // first input launches everyone together; each bot then plays back its
  // whole 3-lap race ONCE and holds its final frame (parked past the finish
  // line) — no looping. R re-grids and re-arms them.
  if (botsLaunched) {
    for (const g of botGhosts) {
      if (g.idx < g.samples.length - 1) g.idx++;
    }
  }

  state.totalTicks++;
  if (state.totalTicks % 300 === 0) save(); // autosave every 5 s

  // Race over: back to the grid (done at the END of the tick so the lap /
  // ghost bookkeeping above has already run on the finishing crossing).
  if (pendingRegrid) {
    const msg = pendingRegrid;
    pendingRegrid = null;
    resetCar();
    flashMsg(msg);
  }
}

// ---------------------------------------------------------------- camera

// Shortest signed angular difference a - b, wrapped to (-PI, PI].
function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function updateCamera(dt) {
  const c = state.car;
  const sp = Math.hypot(c.vx, c.vy);

  // ---- speed-scaled zoom: fast = wider view. Slow smoothing, never pumps.
  // A firing boost briefly pulls the view another notch wider.
  const zTarget = (CAM_ZOOM_SLOW + (CAM_ZOOM_FAST - CAM_ZOOM_SLOW) *
    Math.min(1, sp / params.topSpeed) - CAM_BOOST_ZOOM * camera.pulse) * state.userZoom;
  camera.zoom += (zTarget - camera.zoom) * (1 - Math.exp(-CAM_ZOOM_SMOOTH * dt));

  // ---- velocity look-ahead (the camera leads, the car follows) ----
  let lx = c.vx * CAM_LOOKAHEAD_T, ly = c.vy * CAM_LOOKAHEAD_T;
  const lm = Math.hypot(lx, ly);
  if (lm > CAM_LOOKAHEAD_MAX) { lx *= CAM_LOOKAHEAD_MAX / lm; ly *= CAM_LOOKAHEAD_MAX / lm; }
  if (sp > 1 && camera.pulse > 0.02) {   // boost fire: tiny forward kick
    lx += (c.vx / sp) * CAM_BOOST_KICK * camera.pulse;
    ly += (c.vy / sp) * CAM_BOOST_KICK * camera.pulse;
  }

  // ---- drift lateral bias: shift the view a touch toward the slide so the
  // player sees through the corner; plus the spring-returning start kick.
  const slipSigned = sp > 30 ? angDiff(Math.atan2(c.vy, c.vx), c.angle) : 0;
  const biasTarget = c.drifting
    ? Math.max(-CAM_DRIFT_BIAS_MAX, Math.min(CAM_DRIFT_BIAS_MAX, slipSigned * CAM_DRIFT_BIAS))
    : 0;
  camera.driftBias += (biasTarget - camera.driftBias) * (1 - Math.exp(-CAM_DRIFT_BIAS_SMOOTH * dt));
  const lat = camera.driftBias + camera.kickLat;
  const latX = -Math.sin(camera.angle) * lat, latY = Math.cos(camera.angle) * lat;

  const a = 1 - Math.exp(-CAM_SMOOTH * dt);
  camera.x += (c.x + lx + latX - camera.x) * a;
  camera.y += (c.y + ly + latY - camera.y) * a;

  // Rotation target: direction of travel when moving forward (so the car,
  // not the world, swings during a drift), the car's heading at low speed.
  // Reverse keeps the heading so the camera never flips behind you.
  const fwd = c.vx * Math.cos(c.angle) + c.vy * Math.sin(c.angle);
  let target = c.angle;
  if (fwd > CAM_FWD_MIN) {
    const t = Math.min(1, (fwd - CAM_FWD_MIN) / (CAM_FWD_FULL - CAM_FWD_MIN));
    target = c.angle + angDiff(Math.atan2(c.vy, c.vx), c.angle) * t;
  }
  const ra = 1 - Math.exp(-CAM_ROT_SMOOTH * dt);
  camera.angle += angDiff(target, camera.angle) * ra;

  // ---- decay the impulses ----
  const kd = Math.exp(-CAM_KICK_DAMP * dt);
  camera.kickLat *= kd;
  camera.kickRot *= kd;
  camera.pulse *= Math.exp(-CAM_PULSE_DAMP * dt);
}

// ---------------------------------------------------------------- rendering

function fmtTime(ticks) {
  const t = ticks / 60;
  const m = Math.floor(t / 60);
  return m > 0
    ? `${m}:${(t % 60).toFixed(2).padStart(5, "0")}`
    : `${(t % 60).toFixed(2)}s`;
}

function tracePath() {
  ctx.beginPath();
  ctx.moveTo(CENTER[0][0], CENTER[0][1]);
  for (let i = 1; i < N; i++) ctx.lineTo(CENTER[i][0], CENTER[i][1]);
  ctx.closePath();
}

function drawGateLine(gate, style, width, dash) {
  ctx.save();
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(gate.ax, gate.ay);
  ctx.lineTo(gate.bx, gate.by);
  ctx.stroke();
  ctx.restore();
}

function drawCar(x, y, angle, alpha, bodyColor) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = bodyColor;
  ctx.fillRect(-11, -6, 22, 12);          // body
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(-4, -4.5, 9, 9);           // roof
  ctx.fillStyle = "#ffe9a0";
  ctx.fillRect(9, -5, 2, 3);              // headlights
  ctx.fillRect(9, 2, 2, 3);
  ctx.restore();
}

function renderWorld() {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Road edges then asphalt.
  tracePath();
  ctx.strokeStyle = "#cfcabb";
  ctx.lineWidth = ROAD_HALF * 2 + 8;
  ctx.stroke();
  tracePath();
  ctx.strokeStyle = "#3a3f45";
  ctx.lineWidth = ROAD_HALF * 2;
  ctx.stroke();

  // Dashed centerline.
  ctx.save();
  tracePath();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  ctx.setLineDash([14, 18]);
  ctx.stroke();
  ctx.restore();

  // Tire marks (fading).
  if (marks.length) {
    ctx.save();
    ctx.lineWidth = 3;
    ctx.lineCap = "butt";
    for (const m of marks) {
      const age = state.totalTicks - m.born;
      if (age > MARK_LIFE) continue;
      // Charge tier tints the rubber: grey -> blue (tier 1) -> orange (tier 2).
      const alpha = (m.tier ? 0.6 : 0.45) * (1 - age / MARK_LIFE);
      ctx.strokeStyle = `rgba(${TIER_RGB[m.tier || 0]},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(m.x1, m.y1);
      ctx.lineTo(m.x2, m.y2);
      ctx.stroke();
    }
    ctx.restore();
    // Drop fully faded marks from the front.
    while (marks.length && state.totalTicks - marks[0].born > MARK_LIFE) marks.shift();
  }

  // Checkpoint gates: green if passed this lap, yellow if next, dim otherwise.
  CHECKPOINTS.forEach((cp, i) => {
    let color = "rgba(255,255,255,0.18)";
    if (state.lap.active) {
      if (i < state.lap.nextCp) color = "rgba(111,224,139,0.65)";
      else if (i === state.lap.nextCp) color = "rgba(255,200,87,0.8)";
    }
    drawGateLine(cp, color, 4, [6, 6]);
    // Counter-rotate the label so it stays upright under the rotating camera.
    ctx.save();
    ctx.translate(cp.bx + 6, cp.by + 4);
    ctx.rotate(Math.PI / 2 + camera.angle);
    ctx.fillStyle = color;
    ctx.font = "bold 13px sans-serif";
    ctx.fillText(String(i + 1), 0, 0);
    ctx.restore();
  });

  // Start/finish line: checkered.
  drawGateLine(START_GATE, "#eee", 10);
  drawGateLine(START_GATE, "#111", 10, [7, 7]);

  // Bot reference ghosts (more transparent than the income ghost), with a
  // small floating label counter-rotated to stay upright under the camera.
  if (state.showBotGhosts) {
    for (const g of botGhosts) {
      const s = g.samples[g.idx];
      drawCar(s[0], s[1], s[2], 0.24, g.body);
      ctx.save();
      ctx.translate(s[0], s[1]);
      ctx.rotate(Math.PI / 2 + camera.angle);   // upright in screen space
      ctx.fillStyle = g.text;
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(g.label, 0, -14);
      ctx.restore();
    }
  }

  // Earning ghost fleet: your best lap, replayed `ghostCount()` times over,
  // spread evenly around the circuit. The lead ghost is the brightest.
  if (state.ghostRec) {
    for (let k = ghostCount() - 1; k >= 0; k--) {
      const g = state.ghostRec[ghostSampleIndex(k)];
      drawCar(g[0], g[1], g[2], k === 0 ? 0.38 : 0.26, k === 0 ? "#cfe8ff" : "#9fd0f5");
    }
  }

  // Boost flames: flickering rectangles trailing the car while boosting.
  const car = state.car;
  if (car.boostTime > 0) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    const flick = 1 + 0.35 * Math.sin(state.totalTicks * 1.1);
    const len = (car.boostAmt > 0.3 ? 16 : 11) * flick;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = car.boostAmt > 0.3 ? "#ff9630" : "#549eff";
    ctx.fillRect(-11 - len, -4, len, 3.4);
    ctx.fillRect(-11 - len, 0.6, len, 3.4);
    ctx.fillStyle = "#fff3c4";
    ctx.fillRect(-11 - len * 0.45, -3.2, len * 0.45, 2);
    ctx.fillRect(-11 - len * 0.45, 1.2, len * 0.45, 2);
    ctx.restore();
  }

  // Player car.
  drawCar(state.car.x, state.car.y, state.car.angle, 1, state.offRoad ? "#c95f3f" : "#e84d3d");
}

// Minimap: full track outline + player/ghost dots, top-right corner.
const MM_W = 172, MM_H = 122, MM_PAD = 10;
const mmBounds = (() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of CENTER) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const s = Math.min((MM_W - 24) / (maxX - minX), (MM_H - 24) / (maxY - minY));
  return { minX, minY, s,
    ox: (MM_W - (maxX - minX) * s) / 2,
    oy: (MM_H - (maxY - minY) * s) / 2 };
})();

function mmPoint(x, y) {
  return [
    CANVAS_W - MM_W - MM_PAD + mmBounds.ox + (x - mmBounds.minX) * mmBounds.s,
    MM_PAD + mmBounds.oy + (y - mmBounds.minY) * mmBounds.s,
  ];
}

function renderMinimap() {
  ctx.save();
  ctx.fillStyle = "rgba(15,18,22,0.72)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(CANVAS_W - MM_W - MM_PAD, MM_PAD, MM_W, MM_H, 6);
  ctx.fill();
  ctx.stroke();

  // Track outline.
  ctx.beginPath();
  const p0 = mmPoint(CENTER[0][0], CENTER[0][1]);
  ctx.moveTo(p0[0], p0[1]);
  for (let i = 1; i < N; i += 2) {
    const p = mmPoint(CENTER[i][0], CENTER[i][1]);
    ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();
  ctx.strokeStyle = "rgba(200,205,215,0.8)";
  ctx.lineWidth = Math.max(2, ROAD_HALF * 2 * mmBounds.s);
  ctx.lineJoin = "round";
  ctx.stroke();

  // Start line tick.
  const sg = mmPoint(START_GATE.x, START_GATE.y);
  ctx.fillStyle = "#ffc857";
  ctx.fillRect(sg[0] - 2, sg[1] - 2, 4, 4);

  // Bot reference ghost dots.
  if (state.showBotGhosts) {
    for (const g of botGhosts) {
      const s = g.samples[g.idx];
      const bp = mmPoint(s[0], s[1]);
      ctx.fillStyle = g.body;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(bp[0], bp[1], 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Ghost fleet dots.
  if (state.ghostRec) {
    for (let k = 0; k < ghostCount(); k++) {
      const g = state.ghostRec[ghostSampleIndex(k)];
      const gp = mmPoint(g[0], g[1]);
      ctx.fillStyle = k === 0 ? "#8fc3f0" : "#6b9ec6";
      ctx.beginPath();
      ctx.arc(gp[0], gp[1], k === 0 ? 2.5 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Player: small heading triangle (map stays north-up while the camera rotates).
  const pp = mmPoint(state.car.x, state.car.y);
  ctx.save();
  ctx.translate(pp[0], pp[1]);
  ctx.rotate(state.car.angle);
  ctx.fillStyle = "#e84d3d";
  ctx.beginPath();
  ctx.moveTo(4.5, 0);
  ctx.lineTo(-3, -3);
  ctx.lineTo(-3, 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

function render() {
  // Grass backdrop (screen space).
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#223321";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // World with rotating follow camera: forward is up, car slightly below center.
  ctx.setTransform(1, 0, 0, 1, CANVAS_W / 2, CANVAS_H * CAM_ANCHOR_Y);
  ctx.rotate(-Math.PI / 2 - (camera.angle + camera.kickRot));
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);
  renderWorld();

  // Screen-space HUD.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  renderMinimap();
  if (state.offRoad) {
    ctx.fillStyle = "rgba(224,112,111,0.92)";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("OFF ROAD — ease back on", CANVAS_W / 2, 34);
    ctx.textAlign = "left";
  }
  if (state.car.drifting) {
    // Indicator tracks the banked charge tier: yellow -> blue -> orange.
    const tier = state.car.boostTime > 0 ? 0 : state.car.boostTier;
    ctx.fillStyle = tier > 0 ? `rgba(${TIER_RGB[tier]},0.95)` : "rgba(255,200,87,0.9)";
    ctx.font = "bold 14px sans-serif";
    ctx.fillText(tier > 0 ? `DRIFT ${"+".repeat(tier)}` : "DRIFT", 14, 26);
  }
  if (boostFlash > 0) {
    const t = boostFlash / 55;                        // 1 -> 0
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 2.5);
    ctx.fillStyle = `rgba(${TIER_RGB[boostFlashTier]},1)`;
    ctx.font = `bold ${Math.round(24 + 6 * (1 - t))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(boostFlashTier === 2 ? "SUPER BOOST!" : "BOOST!", CANVAS_W / 2, CANVAS_H * 0.30);
    ctx.restore();
    ctx.textAlign = "left";
  }
}

// ---------------------------------------------------------------- HUD / panel

const el = id => document.getElementById(id);
const upgradeButtons = {};
let msgTimer = null;

function flashMsg(text) {
  el("msg").textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el("msg").textContent = ""; }, 3500);
}

function buildUpgradePanel() {
  const wrap = el("upgrades");
  for (const u of UPGRADES) {
    const row = document.createElement("div");
    row.className = "upgrade";
    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div class="name">${u.name}</div><div class="lvl"></div>`;
    const btn = document.createElement("button");
    btn.addEventListener("click", () => {
      const cost = upgradeCost(u, state.levels[u.id]);
      if (state.currency >= cost) {
        state.currency -= cost;
        state.levels[u.id]++;
        params = carParams(state.levels);
        // The bots drive your car, so a DRIVING spec change re-plans and
        // re-simulates their whole race (a few tens of ms) and their HUD times
        // move too. Economy upgrades touch nothing they care about.
        const before = botGhosts.map(g => g.bestFlying);
        if (u.drives) refreshBotField();
        const moved = botGhosts.some((g, i) => g.bestFlying !== before[i]);
        flashMsg(`${u.name} → Lv ${state.levels[u.id]}` +
          (moved ? " — bots re-simulated on the new spec." : ""));
        save();
      }
    });
    row.appendChild(info);
    row.appendChild(btn);
    wrap.appendChild(row);
    upgradeButtons[u.id] = { btn, lvlEl: info.querySelector(".lvl") };
  }
}

function updatePanel() {
  // Race progress: crossing the line starts lap 1; after RACE_LAPS valid
  // laps the race is done (R restarts it).
  el("raceLap").textContent = state.raceDone
    ? `${RACE_LAPS} / ${RACE_LAPS} ✓`
    : state.lap.active
      ? `${Math.min(state.raceLaps.length + 1, RACE_LAPS)} / ${RACE_LAPS}`
      : `– / ${RACE_LAPS}`;
  el("lapTime").textContent = state.lap.active ? fmtTime(state.lap.ticks) : "–";
  el("bestTime").textContent = state.bestTicks !== null ? fmtTime(state.bestTicks) : "–";
  el("cpStatus").textContent = state.lap.active
    ? `${state.lap.nextCp} / ${CHECKPOINTS.length}` : "–";
  el("currency").textContent = Math.floor(state.currency).toLocaleString();
  if (state.bestTicks !== null) {
    const pay = ghostPayout();
    const n = ghostCount();
    el("payout").textContent = `${Math.round(pay)} / lap` + (n > 1 ? ` x${n}` : "");
    el("income").textContent = `${Math.round(n * pay * 60 / ghostLapSeconds())} / min`;
  } else {
    el("payout").textContent = "–";
    el("income").textContent = "–";
  }
  for (const u of UPGRADES) {
    const lvl = state.levels[u.id];
    const cost = upgradeCost(u, lvl);
    const { btn, lvlEl } = upgradeButtons[u.id];
    btn.textContent = `${cost.toLocaleString()} cr`;
    btn.disabled = state.currency < cost;
    lvlEl.textContent = `Lv ${lvl} — ${u.desc(lvl)}`;
  }
}

// ---------------------------------------------------------------- main loop

let last = performance.now();
let acc = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.25); // clamp huge tab-switch gaps
  acc += dt;
  last = now;
  while (acc >= TICK) {
    physicsStep();
    acc -= TICK;
  }
  updateCamera(dt);
  render();
  updatePanel();
  requestAnimationFrame(frame);
}

load();
params = carParams(state.levels);
buildUpgradePanel();
// Simulate the reference field for the loaded car before the first frame, so
// the grid is populated and the HUD shows real bot times immediately.
refreshBotField();
window.addEventListener("beforeunload", save);
requestAnimationFrame(frame);

// Debug/test hook (used by automated verification; harmless in play).
window.__game = {
  state, resetCar, save, marks,
  get botGhosts() { return botGhosts; },
  get simMs() { return lastSimMs; },
  refreshBotField,
  get params() { return params; },
  // Manually advance the game when rAF is throttled (headless/testing).
  step(n = 1) {
    for (let i = 0; i < n; i++) { physicsStep(); updateCamera(TICK); }
    render();
    updatePanel();
    return { x: state.car.x, y: state.car.y, cam: { ...camera } };
  },
};
