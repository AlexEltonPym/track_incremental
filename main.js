// Trackcrimental v1 — incremental top-down time-trial racer.
// Game glue: input, rendering (follow camera + minimap), HUD, economy, save.
// Physics lives in physics.js, track geometry/lap logic in track.js.

import {
  TICK, SURFACE, carParams, createCarState, stepCar,
  UPGRADE_DEFS, upgradeCost, insertRankedLap, fleetSize, RANKED_LAPS_CAP,
} from "./physics.js?v=9";
// track.js exports the ACTIVE track's geometry as ES module live bindings, so
// these names follow setTrack() with no re-import and no plumbing.
// NOTE: the ?v= query on every internal import is deliberate cache-busting for
// this static, no-build ES-module app. A caching dev server (or GitHub Pages)
// will otherwise serve a STALE module for a bare URL like "./bots.js" while a
// sibling ("./track.js") is fresh — a split that once left the F1 grid slots
// computed but unused. Bump this token (and SAVE_VERSION) together on release.
import * as T from "./track.js?v=9";
import {
  ROAD_HALF, CENTER, N, CHECKPOINTS, START_GATE, START_POS, START_ANGLE,
  TRACKS, DEFAULT_TRACK, surfaceAt, createLap, advanceLap,
} from "./track.js?v=9";
import { botField } from "./bots.js?v=9";
// Purely cosmetic world scenery (lakes/forests/rocks/bushes/flowers), generated
// per track from geometry + a seeded PRNG and cached. Rendered under the road.
import { getDecor, PALETTE } from "./decor.js?v=3";

// ---------------------------------------------------------------- constants

const CANVAS_W = 960, CANVAS_H = 620;
// A safety cap that ABORTS an in-progress lap recording if it runs absurdly
// long (a parked car, a stuck player). It has to be TRACK-AWARE: 5 minutes is
// ample for the short circuits but would abort a legitimate lap of the ~2.8-min
// Cape Cruise if a casual driver dawdles, throwing away their earning-ghost
// lap. So it is the larger of 5 minutes and a generous multiple of the active
// track's own length (a full lap even at a crawl, plus slack). The short tracks
// are dominated by the 5-minute floor, so nothing about them changes.
function maxLapTicks() {
  return Math.max(60 * 300, Math.round(T.TRACK_LEN / 40 * 60 * 2));
}

// ENDLESS RACING. There is no fixed race length any more: the START menu runs a
// 3-2-1-GO countdown, everyone launches from the F1 grid at GO (even with no
// player input), and from then on the player drives forever while the four bot
// ghosts loop their flying lap continuously as the pace reference. The lap
// counter is an endless tally; R drops you behind the line to try the lap again.

// Countdown length: 3 s of "3 / 2 / 1", one second each, then GO.
const COUNTDOWN_TICKS = 3 * 60;
const GO_FLASH_TICKS = 45;

// What YOUR OWN valid lap pays, as a multiple of what one loop of an earning
// ghost pays for a lap of the same length. Deliberately more than 1: the ghost
// is idle income you set up once, and actually driving the lap yourself should
// beat watching a recording of yourself drive it. (A ghost's rate is
// round(720 / lapSeconds) x payoutMult per loop — see payoutFor.)
const PLAYER_LAP_MULT = 2.5;

// The DRIVING (global) upgrades — the car — versus the per-track economy pair.
const DRIVING_IDS = ["speed", "accel", "grip", "boostPwr", "boostDur"];

// MAP UNLOCKS. Ember is free from the start; the other two are a one-off credit
// spend that permanently (for the session) adds the circuit. Escalating so the
// second map is an early goal and the third a real project. Every unlocked
// track's ghost fleet then earns simultaneously, so unlocking grows total
// income — that is the progression.
// CAPE CRUISE is unlocked by default (cost 0): it is a test/cruise level, not a
// milestone. Its income is intrinsically near-zero — payout = round(720 /
// lapSeconds) x mult, which for a ~2.8-minute lap rounds to ~1 cr per loop — so
// it is a place to drive, not an income source. That is expected for a test
// level (see README).
const UNLOCK_COSTS = { ember: 0, longshore: 4000, lantern: 15000, cruise: 0 };

// The tracks that start unlocked: everything priced at 0.
function freeTracks() {
  return TRACKS.filter(t => (UNLOCK_COSTS[t.id] ?? Infinity) === 0).map(t => t.id);
}

// ---------------------------------------------------------------- persistence
// PROTOTYPING MODE. With PERSISTENCE = false the game never reads or writes
// localStorage and actively CLEARS any trackcrimental_* keys at boot, so every
// refresh starts from a clean slate: zero credits, zero upgrade levels, no best
// lap, no earning ghost, default zoom and toggles. The save/load code below is
// intact and correct — flip this one constant back to true to restore saving.
const PERSISTENCE = false;

const SAVE_KEY = "trackcrimental_v6";
// Wiped: old physics/track = old ghosts and times invalid. v6 restructures the
// state (per-track economy + unlocks + a RANKED list of best laps replacing the
// single best lap), so the v5 shape cannot be migrated.
const OLD_SAVE_KEYS = ["trackcrimental_v0", "trackcrimental_v1",
  "trackcrimental_v2", "trackcrimental_v3", "trackcrimental_v4",
  "trackcrimental_v5"];
const SAVE_VERSION = 6;

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

// The shop lives in physics.js (UPGRADE_DEFS) — next to the car it modifies,
// and where the acceptance harness can price it, because the differentiation
// gates compare upgrades at EQUAL CREDIT SPEND. Nothing here but the alias.
const UPGRADES = UPGRADE_DEFS;

// ---------------------------------------------------------------- state

// PER-TRACK STATE. Records and the earning economy belong to the circuit they
// were set on — a 9 s lap of the coil is not comparable with a 12 s lap of the
// speedway, and a recording played back on the wrong track would drive through
// the grass. So each track keeps its own RANKED list of best laps plus its own
// Lap Payout and Ghost Fleet levels.
//
//   rankedLaps  the player's best DISTINCT valid laps here, fastest-first,
//               capped at RANKED_LAPS_CAP. Each = { ticks, samples }. Ghost #1
//               replays rankedLaps[0] (your best), #2 rankedLaps[1], and so on.
//   ghostHeads  per-earning-ghost playhead into its own lap's samples (each
//               ghost loops a DIFFERENT lap of a different length, so they
//               cannot share one playhead the way the old single ghost did).
//   lapPayoutLvl / ghostFleetLvl   PER-TRACK economy upgrade levels.
//
// INCOME: every UNLOCKED track's fleet keeps paying, all the time, whichever
// circuit you are currently on. Unlocking a new map and setting laps on it is a
// permanent income increase — unlocking breadth is the progression.
function blankTrackState() {
  return {
    rankedLaps: [],     // [{ ticks, samples: [[x,y,angle], ...] }], fastest-first
    ghostHeads: [],     // per-ghost playhead (parallel to rankedLaps)
    lapPayoutLvl: 0,    // per-track Lap Payout level
    ghostFleetLvl: 0,   // per-track Ghost Fleet level
  };
}

// GLOBAL vs PER-TRACK. The driving upgrades are the CAR and stay global (the
// bots drive your car and their invariants depend on one universal spec);
// Lap Payout and Ghost Fleet are per track. Credits are one global wallet.
const state = {
  credits: 0,
  drivingLevels: { speed: 0, accel: 0, grip: 0, boostPwr: 0, boostDur: 0 },
  currentTrack: DEFAULT_TRACK,
  unlocked: new Set(freeTracks()),   // Ember + Cape Cruise free; the rest are bought
  tracks: Object.fromEntries(TRACKS.map(t => [t.id, blankTrackState()])),
  car: createCarState(START_POS.x, START_POS.y, START_ANGLE),
  lap: createLap(),
  lapRec: [],           // current lap recording
  lapsDone: 0,          // endless lap tally since the last countdown
  surface: SURFACE.ROAD, // 0 tarmac / 1 concrete runoff / 2 grass
  totalTicks: 0,
  showBotGhosts: true,  // G toggles the bot reference ghosts
  userZoom: 1,          // scroll-wheel zoom multiplier (1 = default follow zoom)
  phase: "menu",        // "menu" (start screen) | "countdown" | "racing"
  countdown: 0,         // ticks left in the 3-2-1 countdown
  goFlash: 0,           // ticks of the on-canvas "GO!" flash remaining
  countedIn: new Set(), // tracks that have had their one-time grid countdown
};

let params = carParams(state.drivingLevels);

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
// They drive YOUR CURRENT CAR (the same carParams(state.drivingLevels) you do), so
// buying an upgrade makes them quicker too and the race stays about driving.
// Purely visual — they never earn currency.
let botGhosts = [];     // {label, body, text, samples, bestFlying, standing, idx}
let lastSimMs = 0;      // ms the last (uncached) field simulation took

// Re-simulate the reference field for the current car. Cached inside bots.js
// on (car spec + track), so re-grids and repeat calls are free; only an
// upgrade purchase (or a track change) actually re-runs the physics.
//
// ENDLESS LOOP. Each bot's recording is the whole standing-start race from its
// grid slot. The game plays the standing launch once (samples[0..loopStart])
// and then loops the FIRST FLYING LAP (samples[loopStart..loopStart+loopLen])
// forever, so the four bots are a continuous pace reference rather than a race
// that ends. loopStart = end of lap 1, loopLen = lap 2's length; both crossings
// are on the start line, so the wrap is seamless.
function refreshBotField() {
  const field = botField(params);
  if (field.simMs) lastSimMs = field.simMs;
  // Keep playback position across a re-simulation so buying an upgrade
  // mid-race does not teleport the field back to the grid.
  const keep = state.phase === "racing" ? botGhosts.map(g => g.idx) : null;
  botGhosts = field.map((g, i) => {
    const loopStart = g.lapTicks[0];
    const loopLen = g.lapTicks[1] ?? Math.max(1, g.samples.length - 1 - loopStart);
    return {
      label: g.label, short: g.short, body: g.body, text: g.text,
      samples: g.samples,
      standing: g.lapTicks[0],
      bestFlying: g.bestFlyingTicks,
      loopStart, loopLen,
      idx: keep ? Math.min(keep[i] ?? 0, loopStart + loopLen - 1) : 0,
    };
  });
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

// Faint drift marks laid by REPLAYED cars — the bots (PRO+ slides) and your
// earning ghosts (whatever you drifted on that recorded lap). There is no
// drift flag in the samples, so it is inferred from the motion: when a car's
// travel direction diverges from its heading, it is sliding. Fainter than the
// player's own rubber. Only the active track's replays lay them.
const ghostMarks = [];
const GHOST_MARK_MAX = 1400;
const GHOST_SLIP = 0.28;          // rad of slip before a replay counts as sliding
const GHOST_MARK_MIN_SPEED = 70;  // px/s — ignore near-stationary jitter
const GHOST_MARK_MAX_SPEED = 900; // px/s — skip loop-seam teleport jumps
const earnRear = [];              // previous rear per active-track earning ghost

function driftMarkFor(store, key, x, y, angle, prevX, prevY) {
  const dx = x - prevX, dy = y - prevY;
  const speed = Math.hypot(dx, dy) / TICK;
  const sliding = speed > GHOST_MARK_MIN_SPEED && speed < GHOST_MARK_MAX_SPEED &&
    Math.abs(angDiff(Math.atan2(dy, dx), angle)) > GHOST_SLIP;
  if (!sliding) { store[key] = null; return; }
  const bx = x - Math.cos(angle) * 8, by = y - Math.sin(angle) * 8;
  const ox = -Math.sin(angle) * 5, oy = Math.cos(angle) * 5;
  const rear = [bx + ox, by + oy, bx - ox, by - oy];
  const last = store[key];
  if (last) {
    const born = state.totalTicks;
    ghostMarks.push({ x1: last[0], y1: last[1], x2: rear[0], y2: rear[1], born });
    ghostMarks.push({ x1: last[2], y1: last[3], x2: rear[2], y2: rear[3], born });
    if (ghostMarks.length > GHOST_MARK_MAX) ghostMarks.splice(0, ghostMarks.length - GHOST_MARK_MAX);
  }
  store[key] = rear;
}
let wasDrifting = false;
let boostFlash = 0;     // ticks of "BOOST!" text remaining
let boostFlashTier = 1;
// F1 GRID START. The player sits on POLE (START_POS) and the four bots on grid
// slots 1..4 (NOVICE, MID, PRO, PRO+), each further back along the start
// straight — their recordings begin at v=0 on their own slot, so the launch
// spreads the field into an F1 stagger. Nobody moves until GO: the START menu's
// countdown reaches zero, `phase` becomes "racing", and everyone launches
// together with no player input required. R just resets you to the line; the
// first visit to a track runs the countdown, later visits skip straight to it.
let pendingMsg = null;      // message to show once we are back on the grid (R)

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
  state.lapsDone = 0;       // endless tally resets on a re-grid
  lastRear = null;
  wasDrifting = false;
  boostFlash = 0;
  // Clear all rubber and per-replay drift state (a re-grid is a clean slate).
  marks.length = 0;
  ghostMarks.length = 0;
  earnRear.length = 0;
  for (const g of botGhosts) { g.idx = 0; g._rear = null; }   // bots back on the grid
  // Teleport = snap the camera too; smoothing a reset feels like a swoop.
  camera.x = START_POS.x; camera.y = START_POS.y; camera.angle = START_ANGLE;
  camera.zoom = CAM_ZOOM_SLOW;
  camera.kickLat = 0; camera.kickRot = 0; camera.driftBias = 0; camera.pulse = 0;
}

// R: abandon the current lap ATTEMPT and drop back behind the line at rest to
// try again — the field keeps racing (no re-grid, no countdown), your endless
// tally is kept, and the next timed lap begins when you next cross the line.
function resetToLine() {
  const c = state.car;
  c.x = START_POS.x; c.y = START_POS.y;
  c.angle = START_ANGLE;
  c.vx = 0; c.vy = 0;
  c.steer = 0; c.grip = 1; c.yawRate = 0; c.drifting = false;
  c.stopHold = 0; c.reverseArmed = true;
  c.driftCharge = 0; c.boostTier = 0; c.boostTime = 0; c.boostAmt = 0;
  state.lap = createLap();      // clear checkpoints + lap timer
  state.lapRec = [];
  lastRear = null;
  wasDrifting = false;
  boostFlash = 0;
  camera.x = START_POS.x; camera.y = START_POS.y; camera.angle = START_ANGLE;
  camera.zoom = CAM_ZOOM_SLOW;
  camera.kickLat = 0; camera.kickRot = 0; camera.driftBias = 0; camera.pulse = 0;
}

// Start (or restart) the race: re-grid, hide the menu, run the 3-2-1 countdown.
// Marks this track as counted-in, so returning to it later skips the ceremony.
function startCountdown() {
  resetCar();
  hideMenu();
  state.countedIn.add(state.currentTrack);
  state.phase = "countdown";
  state.countdown = COUNTDOWN_TICKS;
  state.goFlash = 0;
}

// ---------------------------------------------------------------- save/load

// Round a lap recording's samples for compact storage.
function packSamples(samples) {
  return samples.map(s => [Math.round(s[0] * 10) / 10,
    Math.round(s[1] * 10) / 10, Math.round(s[2] * 1000) / 1000]);
}

function save() {
  if (!PERSISTENCE) return;
  try {
    // Per-track economy: ranked laps (with their samples) + the two per-track
    // upgrade levels. Only tracks with a lap are written; a blank track simply
    // has no entry and starts empty on load.
    const tracks = {};
    for (const [id, ts] of Object.entries(state.tracks)) {
      if (!ts.rankedLaps.length && !ts.lapPayoutLvl && !ts.ghostFleetLvl) continue;
      tracks[id] = {
        lapPayoutLvl: ts.lapPayoutLvl,
        ghostFleetLvl: ts.ghostFleetLvl,
        rankedLaps: ts.rankedLaps.map(r => ({ ticks: r.ticks, samples: packSamples(r.samples) })),
      };
    }
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      version: SAVE_VERSION,
      credits: state.credits,
      drivingLevels: state.drivingLevels,
      currentTrack: state.currentTrack,
      unlocked: [...state.unlocked],
      tracks,
      showBotGhosts: state.showBotGhosts,
      userZoom: state.userZoom,
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
    // Physics/shape changed: old saves are invalid. Wipe them.
    for (const k of OLD_SAVE_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.version !== SAVE_VERSION) { localStorage.removeItem(SAVE_KEY); return; }
    if (typeof d.credits === "number") state.credits = d.credits;
    if (typeof d.showBotGhosts === "boolean") state.showBotGhosts = d.showBotGhosts;
    if (typeof d.userZoom === "number" && d.userZoom > 0) {
      state.userZoom = Math.max(USER_ZOOM_MIN, Math.min(USER_ZOOM_MAX, d.userZoom));
    }
    for (const id of DRIVING_IDS) {
      if (d.drivingLevels && Number.isInteger(d.drivingLevels[id])) {
        state.drivingLevels[id] = d.drivingLevels[id];
      }
    }
    // Unlocks. The free tracks (Ember + Cape Cruise) are always in; unknown
    // ids are ignored.
    state.unlocked = new Set(freeTracks());
    for (const id of d.unlocked || []) if (state.tracks[id]) state.unlocked.add(id);
    if (d.currentTrack && state.unlocked.has(d.currentTrack)) state.currentTrack = d.currentTrack;
    // Per-track economy. Unknown ids are ignored; a track with no entry stays
    // blank. Ranked laps round-trip with their samples.
    for (const [id, rec] of Object.entries(d.tracks || {})) {
      const ts = state.tracks[id];
      if (!ts || !rec) continue;
      if (Number.isInteger(rec.lapPayoutLvl)) ts.lapPayoutLvl = rec.lapPayoutLvl;
      if (Number.isInteger(rec.ghostFleetLvl)) ts.ghostFleetLvl = rec.ghostFleetLvl;
      if (Array.isArray(rec.rankedLaps)) {
        ts.rankedLaps = rec.rankedLaps
          .filter(r => r && Number.isInteger(r.ticks) && Array.isArray(r.samples) && r.samples.length > 1)
          .map(r => ({ ticks: r.ticks, samples: r.samples }))
          .sort((a, b) => a.ticks - b.ticks)
          .slice(0, RANKED_LAPS_CAP);
      }
    }
  } catch (e) { /* corrupt save: start fresh */ }
}

// ---------------------------------------------------------------- economy

// The active track's state.
function here() { return state.tracks[state.currentTrack]; }

// Per-track credit multiplier from that track's Lap Payout level.
function payoutMultFor(ts) { return 1 + 0.3 * ts.lapPayoutLvl; }

// Credits one loop of a ghost pays, for a lap of `ticks` at credit multiplier
// `mult`: round(720 / lapSeconds) x mult. Faster laps pay more per loop (and,
// being shorter, also loop more often) — so a slower ghost down your ranked
// list earns less AND less often.
function payoutFor(ticks, mult) {
  return Math.max(1, Math.round((60 / (ticks / 60)) * 12)) * mult;
}

// How many earning ghosts are on this track: 1 + Ghost Fleet level, capped at
// the number of distinct recorded laps (your best is ghost #1 free at Lv 0).
function fleetSizeFor(ts) { return fleetSize(ts.ghostFleetLvl, ts.rankedLaps.length); }

// This track's headline "Ghost payout": what ghost #1 (your best lap) pays per
// loop. 0 until you have set a lap here.
function ghostPayoutHere() {
  const ts = here();
  return ts.rankedLaps.length ? payoutFor(ts.rankedLaps[0].ticks, payoutMultFor(ts)) : 0;
}

// Credits/minute from one track's whole fleet: each ghost earns on its OWN lap
// time, both a smaller per-loop payout and fewer loops per minute for a slower
// lap further down the list.
function trackIncomePerMin(ts) {
  const n = fleetSizeFor(ts), mult = payoutMultFor(ts);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const ticks = ts.rankedLaps[k].ticks;
    sum += payoutFor(ticks, mult) * 3600 / ticks;   // per-loop x loops/min
  }
  return sum;
}

// Credits/minute from EVERY unlocked track's fleet together — they all earn at
// once, so unlocking more maps and setting laps on them grows total income.
function totalIncomePerMin() {
  let sum = 0;
  for (const id of state.unlocked) sum += trackIncomePerMin(state.tracks[id]);
  return sum;
}

// Whether the Ghost Fleet buy is UNLOCKED here: you may only buy the next level
// once you have enough distinct recorded laps to fill the new ghost. You may be
// able to afford it and still be blocked until you have driven another lap.
function canBuyFleetHere() {
  const ts = here();
  return ts.rankedLaps.length > fleetSizeFor(ts);
}

// The playhead into earning ghost k's own lap samples. Ghosts are staggered by
// a golden-ratio fraction of their own length so they spread around the lap
// regardless of fleet size, rather than stacking.
function ghostHeadInit(k, len) {
  return Math.floor((((k * 0.6180339887) % 1) * len));
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
  if (e.code === "KeyR" && state.phase === "racing") {
    resetToLine();
    flashMsg("Back to the line.");
  }
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

  // ---- EARNING GHOSTS + INCOME, always, on EVERY unlocked track ----
  // Independent of the race: the fleets loop and pay whatever phase we are in.
  // Each ghost k loops rankedLaps[k]'s OWN samples at its OWN length, staggered
  // so they spread around the lap, and pays payoutFor(that lap) each time its
  // playhead wraps the line. Only the active track is drawn; the rest keep
  // running and paying (that is what makes unlocking maps grow income).
  const activeId = state.currentTrack;
  for (const id of state.unlocked) {
    const ts = state.tracks[id];
    const n = fleetSizeFor(ts), mult = payoutMultFor(ts);
    for (let k = 0; k < n; k++) {
      const rec = ts.rankedLaps[k];
      const len = rec.samples.length;
      let h = ts.ghostHeads[k];
      if (h == null || h >= len) h = ghostHeadInit(k, len);
      const nh = (h + 1) % len;
      ts.ghostHeads[k] = nh;
      if (nh < h) state.credits += payoutFor(rec.ticks, mult);   // wrapped the line
      // Faint drift marks for the visible fleet only (the others aren't drawn).
      if (id === activeId) {
        if (nh < h) earnRear[k] = null;   // wrapped the line: no seam segment
        else {
          const cur = rec.samples[nh], prev = rec.samples[h];
          driftMarkFor(earnRear, k, cur[0], cur[1], cur[2], prev[0], prev[1]);
        }
      }
    }
  }

  state.totalTicks++;
  if (state.totalTicks % 300 === 0) save(); // autosave every 5 s

  // ---- countdown: 3 / 2 / 1, then GO ----
  if (state.phase === "countdown") {
    state.surface = surfaceAt(c.x, c.y);   // keep the HUD honest while parked
    state.countdown--;
    if (state.countdown <= 0) { state.phase = "racing"; state.goFlash = GO_FLASH_TICKS; }
    return;                                // nobody moves before GO
  }
  if (state.goFlash > 0) state.goFlash--;
  if (state.phase !== "racing") return;    // on the start menu: frozen grid

  const px = c.x, py = c.y;
  state.surface = surfaceAt(c.x, c.y);

  const boostBefore = c.boostTime;
  stepCar(c, {
    throttle: keys.up ? 1 : 0,
    brake: keys.down ? 1 : 0,
    steer: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
    handbrake: !!keys.drift,
    surface: state.surface,
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

  // ---- lap / gate logic (ENDLESS: laps just keep tallying) ----
  const ev = advanceLap(state.lap, px, py, c.x, c.y);
  if (state.lap.active && !ev.started) {
    state.lapRec.push([c.x, c.y, c.angle]);
    if (state.lap.ticks > maxLapTicks()) { state.lap.active = false; state.lapRec = []; }
  }
  if (ev.finished && ev.finished.valid) {
    // ECONOMY on a clean lap:
    //   1. YOU GET PAID FOR DRIVING IT — PLAYER_LAP_MULT times what one loop of
    //      an earning ghost of the same length pays. Active driving beats
    //      watching a recording of yourself drive.
    //   2. The lap is inserted into THIS TRACK's ranked list of best laps. Your
    //      best becomes earning ghost #1, your 2nd best ghost #2, and so on —
    //      each ghost loops forever and pays on its own time, on this track
    //      whether or not you are still driving it.
    const ts = here();
    const mult = payoutMultFor(ts);
    const prevBest = ts.rankedLaps.length ? ts.rankedLaps[0].ticks : null;
    const lapPay = payoutFor(ev.finished.ticks, mult) * PLAYER_LAP_MULT;
    state.credits += lapPay;
    state.lapsDone++;
    const rank = insertRankedLap(ts.rankedLaps, {
      ticks: ev.finished.ticks, samples: state.lapRec.slice(),
    });
    const paid = `+${Math.round(lapPay)} cr`;
    if (prevBest === null || ev.finished.ticks < prevBest) {
      flashMsg(`New best: ${fmtTime(ev.finished.ticks)} — ${paid}, ghost #1 updated!`);
    } else if (rank >= 0) {
      flashMsg(`Lap ${state.lapsDone}: ${fmtTime(ev.finished.ticks)} — ${paid} ` +
        `(#${rank + 1} of ${ts.rankedLaps.length}, best ${fmtTime(prevBest)})`);
    } else {
      flashMsg(`Lap ${state.lapsDone}: ${fmtTime(ev.finished.ticks)} — ${paid} ` +
        `(best ${fmtTime(prevBest)})`);
    }
    save();
  } else if (ev.finished) {
    flashMsg("Lap didn't count — missed a checkpoint.");
  }
  if (ev.started) {
    state.lapRec = [[c.x, c.y, c.angle]];
  }

  // ---- bot reference ghosts: standing launch once, then loop the flying lap ----
  // No income — pure pace reference. They ran from their grid slots, so the
  // standing samples (0..loopStart) spread the F1 grid on launch; after that
  // each loops its flying lap (loopStart..loopStart+loopLen) forever.
  for (const g of botGhosts) {
    const prev = g.samples[g.idx];
    g.idx++;
    if (g.idx >= g.loopStart + g.loopLen) { g.idx = g.loopStart; g._rear = null; }
    const cur = g.samples[g.idx];
    // _rear was nulled on the wrap, so no rubber is drawn across the loop seam.
    driftMarkFor(g, "_rear", cur[0], cur[1], cur[2], prev[0], prev[1]);
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

// Cosmetic scenery, drawn in WORLD space UNDER the road (grass backdrop is
// already painted in screen space by render()). Everything is VIEWPORT-CULLED:
// only items within the visible radius are touched, so a track with hundreds of
// trees (Cape Cruise) still costs only what is on screen. No allocation here —
// the decoration arrays are precomputed and cached in decor.js.
function drawDecor() {
  const decor = getDecor(T.TRACK);
  // Visible radius: half the canvas diagonal in WORLD px (the camera rotates,
  // so a circular bound is rotation-proof), plus a margin for item size.
  const viewR = Math.hypot(CANVAS_W, CANVAS_H) / (2 * camera.zoom) + 60;
  const cx = camera.x, cy = camera.y;
  const vis = (x, y, r) => {
    const dx = x - cx, dy = y - cy, rr = viewR + r;
    return dx * dx + dy * dy <= rr * rr;
  };

  // ---- lakes: shore ring, then water, then island + reeds.
  for (const L of decor.lakes) {
    if (!vis(L.cx, L.cy, L.r)) continue;
    ctx.beginPath();
    ctx.moveTo(L.shore[0][0], L.shore[0][1]);
    for (let i = 1; i < L.shore.length; i++) ctx.lineTo(L.shore[i][0], L.shore[i][1]);
    ctx.closePath();
    ctx.fillStyle = PALETTE.shore;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(L.poly[0][0], L.poly[0][1]);
    for (let i = 1; i < L.poly.length; i++) ctx.lineTo(L.poly[i][0], L.poly[i][1]);
    ctx.closePath();
    ctx.fillStyle = PALETTE.water;
    ctx.fill();
    ctx.strokeStyle = PALETTE.waterEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (L.island) {
      ctx.beginPath();
      ctx.moveTo(L.island[0][0], L.island[0][1]);
      for (let i = 1; i < L.island.length; i++) ctx.lineTo(L.island[i][0], L.island[i][1]);
      ctx.closePath();
      ctx.fillStyle = PALETTE.island;
      ctx.fill();
    }
    if (L.reeds.length) {
      ctx.strokeStyle = PALETTE.reed;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [rx, ry] of L.reeds) { ctx.moveTo(rx, ry); ctx.lineTo(rx, ry - 6); }
      ctx.stroke();
    }
  }

  // ---- trees: all shadows first (one fill), then canopies. Offset shadow gives
  // a subtle hint of depth without a per-tree state change for the shadow.
  ctx.fillStyle = PALETTE.treeShadow;
  for (const t of decor.trees) {
    if (!vis(t[0], t[1], t[2])) continue;
    ctx.beginPath();
    ctx.arc(t[0] + 3, t[1] + 4, t[2], 0, Math.PI * 2);
    ctx.fill();
  }
  for (const t of decor.trees) {
    if (!vis(t[0], t[1], t[2])) continue;
    ctx.fillStyle = PALETTE.trees[t[3]];
    ctx.beginPath();
    ctx.arc(t[0], t[1], t[2], 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- bushes, then rocks: small filled blobs.
  for (const b of decor.bushes) {
    if (!vis(b[0], b[1], b[2])) continue;
    ctx.fillStyle = PALETTE.bushes[b[3]];
    ctx.beginPath();
    ctx.arc(b[0], b[1], b[2], 0, Math.PI * 2);
    ctx.fill();
  }
  for (const r of decor.rocks) {
    if (!vis(r[0], r[1], r[2])) continue;
    ctx.fillStyle = PALETTE.rocks[r[3]];
    ctx.beginPath();
    ctx.arc(r[0], r[1], r[2], 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- flowers: tiny dots.
  for (const f of decor.flowers) {
    if (!vis(f[0], f[1], 2)) continue;
    ctx.fillStyle = PALETTE.flowers[f[2]];
    ctx.beginPath();
    ctx.arc(f[0], f[1], 1.7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderWorld() {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Cosmetic scenery in the grass, BEHIND everything on the road.
  drawDecor();

  // THE CONCRETE RUNOFF, first: a distinct pale-grey skirt on the outside of
  // the demanding corners, drawn UNDER the road edge line so the edge still
  // reads as the boundary of the racing surface. The polygons come straight
  // from track.js's derived width arrays, so what you see is what the physics
  // charges you for. A slightly darker rim keeps it from bleeding into the
  // grass at the taper.
  if (T.RUNOFF_BANDS.length) {
    ctx.save();
    for (const poly of T.RUNOFF_BANDS) {
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      ctx.fillStyle = "#7e8481";
      ctx.fill();
      ctx.strokeStyle = "rgba(40,46,44,0.45)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

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

  // Faint drift marks from the replayed cars (bots + earning ghosts) — same
  // fade, thinner and much dimmer than the player's own so they read as ghostly.
  if (ghostMarks.length) {
    ctx.save();
    ctx.lineWidth = 2.4;
    ctx.lineCap = "butt";
    for (const m of ghostMarks) {
      const age = state.totalTicks - m.born;
      if (age > MARK_LIFE) continue;
      ctx.strokeStyle = `rgba(34,34,38,${(0.22 * (1 - age / MARK_LIFE)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(m.x1, m.y1);
      ctx.lineTo(m.x2, m.y2);
      ctx.stroke();
    }
    ctx.restore();
    while (ghostMarks.length && state.totalTicks - ghostMarks[0].born > MARK_LIFE) ghostMarks.shift();
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

  // Earning ghost fleet: your RANKED best laps ON THIS TRACK. Ghost #1 replays
  // your best, #2 your 2nd best, ... each looping its own recording, staggered
  // around the circuit so they do not stack. The lead ghost is brightest.
  {
    const ts = here();
    const n = fleetSizeFor(ts);
    for (let k = n - 1; k >= 0; k--) {
      const rec = ts.rankedLaps[k];
      const h = Math.min(ts.ghostHeads[k] ?? 0, rec.samples.length - 1);
      const g = rec.samples[h];
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
  // Player car, tinted by surface: red on tarmac, a shade duller on concrete,
  // properly washed out in the grass.
  drawCar(state.car.x, state.car.y, state.car.angle, 1,
    state.surface === SURFACE.GRASS ? "#c95f3f"
      : state.surface === SURFACE.RUNOFF ? "#dc5b46" : "#e84d3d");
}

// Minimap: full track outline + player/ghost dots, top-right corner.
const MM_W = 172, MM_H = 122, MM_PAD = 10;
// Recomputed on every track change: each circuit has its own bounding box, so
// the minimap re-fits rather than drawing the new track at the old one's scale.
let mmBounds = null;
function fitMinimap() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of CENTER) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const s = Math.min((MM_W - 24) / (maxX - minX), (MM_H - 24) / (maxY - minY));
  mmBounds = { minX, minY, s,
    ox: (MM_W - (maxX - minX) * s) / 2,
    oy: (MM_H - (maxY - minY) * s) / 2 };
}
fitMinimap();

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
  {
    const ts = here();
    const n = fleetSizeFor(ts);
    for (let k = 0; k < n; k++) {
      const rec = ts.rankedLaps[k];
      const h = Math.min(ts.ghostHeads[k] ?? 0, rec.samples.length - 1);
      const g = rec.samples[h];
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
  // Surface warning, in two tiers so it never cries wolf. The concrete skirt
  // is a mild, temporary state — a quiet grey note that you are off the racing
  // line — while grass keeps the red "you are losing the lap" warning.
  if (state.surface !== SURFACE.ROAD) {
    const grass = state.surface === SURFACE.GRASS;
    ctx.fillStyle = grass ? "rgba(224,112,111,0.92)" : "rgba(198,205,202,0.78)";
    ctx.font = grass ? "bold 16px sans-serif" : "600 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(grass ? "OFF ROAD — ease back on" : "runoff — off the racing line",
      CANVAS_W / 2, 34);
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

  // ---- countdown: 3 / 2 / 1 (each ~1 s), then a GO! flash ----
  if (state.phase === "countdown") {
    const num = Math.ceil(state.countdown / 60);      // 3, 2, 1
    const frac = (state.countdown % 60) / 60;         // 1 -> 0 within each second
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.65 * frac;
    ctx.fillStyle = "#ffc857";
    ctx.font = `bold ${Math.round(96 + 40 * (1 - frac))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(num), CANVAS_W / 2, CANVAS_H * 0.42);
    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  } else if (state.goFlash > 0) {
    const t = state.goFlash / GO_FLASH_TICKS;         // 1 -> 0
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 2);
    ctx.fillStyle = "#6fe08b";
    ctx.font = `bold ${Math.round(110 + 30 * (1 - t))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("GO!", CANVAS_W / 2, CANVAS_H * 0.42);
    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
}

// ---------------------------------------------------------------- HUD / panel

const el = id => document.getElementById(id);
const upgradeButtons = {};
const trackButtons = {};
let msgTimer = null;

// ---------------------------------------------------------------- tracks

// Switch to an UNLOCKED circuit: swap the geometry (track.js's live bindings),
// re-fit the minimap, re-simulate the bot field for the new track (cached per
// track in bots.js, so flipping back is instant) and re-grid + re-countdown.
// Records, ghosts and the economy are per track, so what you see after the
// switch is THIS circuit's history.
function switchTrack(id) {
  if (id === state.currentTrack || !state.tracks[id] || !state.unlocked.has(id)) return;
  T.setTrack(id);
  state.currentTrack = id;
  getDecor(T.TRACK);            // build+cache this track's scenery up front
  fitMinimap();
  marks.length = 0;             // rubber belongs to the track it was laid on
  ghostMarks.length = 0;
  earnRear.length = 0;
  refreshBotField();
  if (state.countedIn.has(id)) {
    // Been here before: no ceremony. Drop behind the line ready to go (like R),
    // and launch the freshly re-gridded bots immediately — no countdown.
    hideMenu();
    for (const g of botGhosts) { g.idx = 0; g._rear = null; }
    resetToLine();
    state.phase = "racing";
    state.countdown = 0;
    state.goFlash = 0;
  } else {
    startCountdown();           // first visit here: F1 grid + 3-2-1-GO
  }
  updateTrackButtons();
  save();
  const meta = TRACKS.find(t => t.id === id);
  const ts = here();
  flashMsg(`${meta.name} — ${meta.skillLabel}. ` +
    (ts.rankedLaps.length ? `Best ${fmtTime(ts.rankedLaps[0].ticks)}.` : "No lap set here yet."));
}

// Unlock a locked circuit for a one-off credit spend, then switch to it.
function tryUnlock(id) {
  const meta = TRACKS.find(t => t.id === id);
  const cost = UNLOCK_COSTS[id] ?? 0;
  if (state.credits < cost) {
    flashMsg(`${meta.name} locked — ${cost.toLocaleString()} cr to unlock ` +
      `(you have ${Math.floor(state.credits).toLocaleString()}).`);
    return;
  }
  state.credits -= cost;
  state.unlocked.add(id);
  save();
  flashMsg(`Unlocked ${meta.name} for ${cost.toLocaleString()} cr!`);
  switchTrack(id);
}

function buildTrackSelector() {
  const wrap = el("trackSel");
  for (const t of TRACKS) {
    const btn = document.createElement("button");
    btn.addEventListener("click", () =>
      state.unlocked.has(t.id) ? switchTrack(t.id) : tryUnlock(t.id));
    wrap.appendChild(btn);
    trackButtons[t.id] = btn;
  }
  updateTrackButtons();
}

// Locked tracks show their unlock price and grey out until affordable; unlocked
// tracks show their name and highlight the active one.
function updateTrackButtons() {
  for (const t of TRACKS) {
    const btn = trackButtons[t.id];
    const unlocked = state.unlocked.has(t.id);
    const cost = UNLOCK_COSTS[t.id] ?? 0;
    btn.classList.toggle("on", unlocked && t.id === state.currentTrack);
    btn.classList.toggle("locked", !unlocked);
    btn.textContent = unlocked ? t.short : `${t.short} 🔒`;
    btn.title = unlocked
      ? `${t.name} — rewards ${t.skillLabel}`
      : `Unlock ${t.name} — ${cost.toLocaleString()} cr`;
    btn.disabled = !unlocked && state.credits < cost;
  }
  const meta = TRACKS.find(t => t.id === state.currentTrack);
  el("trackName").textContent = meta.skillLabel;
}

function flashMsg(text) {
  el("msg").textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el("msg").textContent = ""; }, 3500);
}

// The current level of an upgrade: driving upgrades are GLOBAL (the car); Lap
// Payout and Ghost Fleet are PER TRACK.
function levelForUpgrade(u) {
  if (u.drives) return state.drivingLevels[u.id];
  return u.id === "payout" ? here().lapPayoutLvl : here().ghostFleetLvl;
}

function buyUpgrade(u) {
  const cost = upgradeCost(u, levelForUpgrade(u));
  if (state.credits < cost) return;
  // Ghost Fleet is GATED: you must have another distinct recorded lap to fill
  // the new ghost, even if you can afford it.
  if (u.id === "ghosts" && !canBuyFleetHere()) {
    flashMsg("Ghost Fleet blocked — set another lap time here first.");
    return;
  }
  state.credits -= cost;
  if (u.drives) {
    state.drivingLevels[u.id]++;
    params = carParams(state.drivingLevels);
    // The bots drive your car, so a DRIVING spec change re-plans and
    // re-simulates their whole race (a few tens of ms) and their HUD times move.
    const before = botGhosts.map(g => g.bestFlying);
    refreshBotField();
    const moved = botGhosts.some((g, i) => g.bestFlying !== before[i]);
    flashMsg(`${u.name} → Lv ${state.drivingLevels[u.id]}` +
      (moved ? " — bots re-simulated on the new spec." : ""));
  } else if (u.id === "payout") {
    here().lapPayoutLvl++;
    flashMsg(`${u.name} → Lv ${here().lapPayoutLvl} (this track)`);
  } else {
    here().ghostFleetLvl++;
    flashMsg(`${u.name} → Lv ${here().ghostFleetLvl} (this track)`);
  }
  save();
}

function buildUpgradePanel() {
  const wrap = el("upgrades");
  const header = text => {
    const h = document.createElement("div");
    h.className = "ugroup";
    h.textContent = text;
    wrap.appendChild(h);
  };
  const addRow = u => {
    const row = document.createElement("div");
    row.className = "upgrade";
    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div class="name">${u.name}</div><div class="lvl"></div>`;
    const btn = document.createElement("button");
    btn.addEventListener("click", () => buyUpgrade(u));
    row.appendChild(info);
    row.appendChild(btn);
    wrap.appendChild(row);
    upgradeButtons[u.id] = { btn, lvlEl: info.querySelector(".lvl") };
  };
  // GLOBAL vs THIS-TRACK, clearly separated.
  header("Car — global");
  UPGRADES.filter(u => u.drives).forEach(addRow);
  header("This track");
  UPGRADES.filter(u => !u.drives).forEach(addRow);
}

function updatePanel() {
  const ts = here();
  // ENDLESS lap tally + the current-lap timer.
  el("raceLap").textContent = state.phase !== "racing" ? "–"
    : state.lap.active ? `${state.lapsDone} (on ${state.lapsDone + 1})`
      : `${state.lapsDone}`;
  el("lapTime").textContent = state.lap.active ? fmtTime(state.lap.ticks) : "–";
  el("bestTime").textContent = ts.rankedLaps.length ? fmtTime(ts.rankedLaps[0].ticks) : "–";
  el("cpStatus").textContent = state.lap.active
    ? `${state.lap.nextCp} / ${CHECKPOINTS.length}` : "–";
  el("currency").textContent = Math.floor(state.credits).toLocaleString();
  // Ghost payout is THIS track's fleet; income is EVERY unlocked track summed.
  const n = fleetSizeFor(ts);
  if (ts.rankedLaps.length) {
    el("payout").textContent = `${Math.round(ghostPayoutHere())} / lap` +
      (n > 1 ? ` x${n} ghosts` : "");
  } else {
    el("payout").textContent = "–";
  }
  const income = totalIncomePerMin();
  el("income").textContent = income > 0 ? `${Math.round(income)} / min` : "–";
  updateTrackButtons();
  for (const u of UPGRADES) {
    const lvl = levelForUpgrade(u);
    const cost = upgradeCost(u, lvl);
    const { btn, lvlEl } = upgradeButtons[u.id];
    btn.textContent = `${cost.toLocaleString()} cr`;
    let blocked = state.credits < cost;
    let hint = "";
    if (u.id === "ghosts") {
      const gated = !canBuyFleetHere();
      blocked = blocked || gated;
      if (gated) hint = " · set another lap time";
    }
    btn.disabled = blocked;
    lvlEl.textContent = `Lv ${lvl} — ${u.desc(lvl)}${hint}`;
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

// ---------------------------------------------------------------- start menu

// A simple HTML overlay over the canvas: title + GO. No prose (deliberately).
function showMenu() { state.phase = "menu"; el("startOverlay").style.display = "flex"; }
function hideMenu() { el("startOverlay").style.display = "none"; }

load();
T.setTrack(state.currentTrack);
getDecor(T.TRACK);             // build+cache the initial track's scenery
fitMinimap();
resetCar();
params = carParams(state.drivingLevels);
buildTrackSelector();
buildUpgradePanel();
// Simulate the reference field for the loaded car before the first frame, so
// the grid is populated and the HUD shows real bot times immediately.
refreshBotField();
el("goBtn").addEventListener("click", startCountdown);
showMenu();
window.addEventListener("beforeunload", save);
requestAnimationFrame(frame);

// Debug/test hook (used by automated verification; harmless in play).
window.__game = {
  state, resetCar, resetToLine, save, marks, ghostMarks, switchTrack, tryUnlock, startCountdown,
  // Skip the menu/countdown straight into the race (headless verification).
  go() { hideMenu(); resetCar(); state.phase = "racing"; state.countdown = 0; state.goFlash = 0; },
  get track() { return { id: T.TRACK_ID, name: T.TRACK_NAME, len: T.TRACK_LEN,
    cps: CHECKPOINTS.length, sig: T.TRACK_SIGNATURE }; },
  get tracks() { return TRACKS; },
  get botGhosts() { return botGhosts; },
  // Generated cosmetic scenery for the ACTIVE track (world coords), for preview.
  get decor() { return getDecor(T.TRACK); },
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
