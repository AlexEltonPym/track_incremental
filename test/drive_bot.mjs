// drive_bot.mjs — headless bot-driver test harness for Trackcrimental.
//
//   node test/drive_bot.mjs            run novice/average/expert/pro/proplus,
//                                      print telemetry + PASS/FAIL acceptance
//   node test/drive_bot.mjs baseline   also run bots against v0 (legacy)
//                                      physics for a before/after comparison
//   node test/drive_bot.mjs sweep      grid-search key handling constants,
//                                      print a metrics table
//
// Simulates physics.js + track.js at unlimited speed with pure-pursuit bot
// drivers at parameterized skill levels, and reports F1-style telemetry:
// lap times, off-road %, wobble index (steering reversals + yaw-rate zero
// crossings per second), lateral g (peak/RMS), traction-circle utilization.
// Bot logic lives in ../bots.js — the SAME module the browser game imports
// to simulate its reference bots, so what this harness gates is what you race.
//
// Telemetry unit assumption: 10 px = 1 m, so 98.1 px/s^2 = 1 g.

// ?v= matches the browser imports (see main.js): every importer of a stateful
// module — track.js holds the active-track state — must use the IDENTICAL
// specifier, or Node/the browser loads two separate instances and setTrack()
// on one is invisible to the other.
import {
  TICK, G_PX, SURFACE, carParams, legacyParams, createCarState, stepCar, slipAngle,
  ZERO_LEVELS, DRIVING_UPGRADES, UPGRADE_BY_ID, levelsForBudget,
  insertRankedLap, fleetSize, RANKED_LAPS_CAP,
} from "../physics.js?v=9";
import {
  SKILLS, runBot, recordRace, raceBest, deriveDriftZones, mulberry32,
  simulateBotField, BOT_TIERS,
} from "../bots.js?v=9";
import * as T from "../track.js?v=9";

// ---------------------------------------------------------------- scripted feature tests

const n = s => Math.round(s / TICK);

// Signed slip in degrees: atan2(v_lateral, v_forward) in the car frame.
function signedSlipDeg(car) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  const vf = car.vx * fx + car.vy * fy;
  const vl = -car.vx * fy + car.vy * fx;
  return Math.atan2(vl, Math.max(Math.abs(vf), 1)) * 180 / Math.PI;
}

// Drift boost: drive to speed on open ground, hold a ~1 s handbrake drift,
// release, floor it. Expect a tier-1 charge, a post-release peak well above
// top speed, and a clean settle (no fishtail) right after release.
function driftBoostTest(p) {
  const car = createCarState(0, 0, 0);
  for (let i = 0; i < n(4); i++) stepCar(car, { throttle: 1 }, p, TICK);

  let maxSlip = 0;
  for (let i = 0; i < n(1.0); i++) {
    stepCar(car, { throttle: 1, steer: 1, handbrake: true }, p, TICK);
    maxSlip = Math.max(maxSlip, slipAngle(car));
  }
  const charge = car.driftCharge;
  const tierBanked = car.boostTier;

  let peak = 0, settle = null;
  for (let i = 0; i < n(2.5); i++) {
    stepCar(car, { throttle: 1 }, p, TICK);
    peak = Math.max(peak, Math.hypot(car.vx, car.vy));
    if (settle === null && slipAngle(car) < 10 * Math.PI / 180) settle = i * TICK;
  }
  return { charge, tierBanked, maxSlip, peak, settle, topSpeed: p.topSpeed };
}

// Drift controllability: enter a drift at speed on CONSTANT full steer —
// the stabilizer must settle slip into the 15..40 deg band (after a short
// entry transient) and never diverge past 55 deg. Then release steer (still
// holding the handbrake): slip must decay below 10 deg within 0.8 s without
// flipping sign (no fishtail oscillation).
function driftControlTest(p) {
  const car = createCarState(0, 0, 0);
  for (let i = 0; i < n(4); i++) stepCar(car, { throttle: 1 }, p, TICK);

  // Phase 1: constant steer + handbrake for 1.5 s.
  let maxSlip = 0, bandMin = Infinity, bandMax = -Infinity;
  const settleTicks = n(0.5);            // entry transient allowance
  for (let i = 0; i < n(1.5); i++) {
    stepCar(car, { throttle: 1, steer: 1, handbrake: true }, p, TICK);
    const s = Math.abs(signedSlipDeg(car));
    maxSlip = Math.max(maxSlip, s);
    if (i >= settleTicks) {
      bandMin = Math.min(bandMin, s);
      bandMax = Math.max(bandMax, s);
    }
  }

  // Phase 2: steer released, handbrake still held: straighten gradually.
  const sign0 = Math.sign(signedSlipDeg(car));
  let tUnder10 = null, signFlip = false;
  for (let i = 0; i < n(1.2); i++) {
    stepCar(car, { throttle: 1, handbrake: true }, p, TICK);
    const ss = signedSlipDeg(car);
    if (tUnder10 === null && Math.abs(ss) < 10) tUnder10 = (i + 1) * TICK;
    if (sign0 !== 0 && Math.sign(ss) === -sign0 && Math.abs(ss) > 5) signFlip = true;
  }
  return { bandMin, bandMax, maxSlip, tUnder10, signFlip };
}

// Exploit regression (a): straight-line handbrake hold at speed for 2 s.
// No slip, no yaw, no steering => the charge must never approach tier 1,
// and the handbrake must NOT act as an effective brake (mostly coasts).
function exploitStraightTest(p) {
  // Reference: a plain no-input coast from the same speed (rolling drag only).
  const ref = createCarState(0, 0, 0);
  for (let i = 0; i < n(6); i++) stepCar(ref, { throttle: 1 }, p, TICK);
  const entry = Math.hypot(ref.vx, ref.vy);
  for (let i = 0; i < n(2.0); i++) stepCar(ref, {}, p, TICK);
  const coastExit = Math.hypot(ref.vx, ref.vy);

  const car = createCarState(0, 0, 0);
  for (let i = 0; i < n(6); i++) stepCar(car, { throttle: 1 }, p, TICK);
  let maxCharge = 0;
  for (let i = 0; i < n(2.0); i++) {
    stepCar(car, { handbrake: true }, p, TICK);   // throttle off: pure coast
    maxCharge = Math.max(maxCharge, car.driftCharge);
  }
  const exit = Math.hypot(car.vx, car.vy);
  // Then release: no boost may fire.
  let boostFired = false;
  for (let i = 0; i < n(0.5); i++) {
    stepCar(car, {}, p, TICK);
    if (car.boostTime > 0) boostFired = true;
  }
  return { entry, exit, coastExit, keptFrac: exit / coastExit, maxCharge, boostFired };
}

// Exploit regression (b): bank a genuine tier-1 charge, then use the
// handbrake(+brake) to stop. The decay must bleed the charge during the
// stop, and the release-speed floor must block any boost from a standstill.
function exploitStopTest(p) {
  const car = createCarState(0, 0, 0);
  for (let i = 0; i < n(4); i++) stepCar(car, { throttle: 1 }, p, TICK);
  // Genuine drift: bank a tier-1 charge.
  for (let i = 0; i < n(1.0); i++) {
    stepCar(car, { throttle: 1, steer: 1, handbrake: true }, p, TICK);
  }
  const chargeBanked = car.driftCharge;
  // Straighten and brake to a stop, handbrake still held the whole way.
  let ticks = 0;
  while (Math.hypot(car.vx, car.vy) > 2 && ticks < n(4)) {
    stepCar(car, { brake: 1, handbrake: true }, p, TICK);
    ticks++;
  }
  const chargeAtStop = car.driftCharge;
  // Release everything at the standstill: no boost may fire.
  let boostFired = false, peakAfter = 0;
  for (let i = 0; i < n(1.0); i++) {
    stepCar(car, {}, p, TICK);
    if (car.boostTime > 0) boostFired = true;
    peakAfter = Math.max(peakAfter, Math.hypot(car.vx, car.vy));
  }
  return { chargeBanked, chargeAtStop, boostFired, peakAfter };
}

// Brake gate: from top speed, hold brake. The car must reach a full stop,
// HOLD it stopped >= 0.3 s, and only then start reversing.
function brakeGateTest(p) {
  const car = createCarState(0, 0, 0);
  for (let i = 0; i < n(6); i++) stepCar(car, { throttle: 1 }, p, TICK);
  const entry = Math.hypot(car.vx, car.vy);

  let tStop = null, tRev = null;
  for (let i = 0; i < n(4); i++) {
    stepCar(car, { brake: 1 }, p, TICK);
    const vf = car.vx * Math.cos(car.angle) + car.vy * Math.sin(car.angle);
    if (tStop === null && Math.abs(vf) < 0.5) tStop = i * TICK;
    if (tRev === null && vf < -1) tRev = i * TICK;
  }
  return { entry, tStop, tRev, hold: tStop !== null && tRev !== null ? tRev - tStop : null };
}

// Three surfaces: drive flat out on each for 6 s from rest and see what the
// car settles at. The point of the check is the ORDER and the SPACING — the
// concrete skirt has to be a nudge, not a punishment, and grass has to stay
// the thing you genuinely do not want to be on.
function surfaceTest(p) {
  const run = surface => {
    const car = createCarState(0, 0, 0);
    for (let i = 0; i < n(6); i++) stepCar(car, { throttle: 1, surface }, p, TICK);
    return Math.hypot(car.vx, car.vy);
  };
  // Entering each surface AT SPEED and coasting: how much does it scrub off?
  const enter = surface => {
    const car = createCarState(0, 0, 0);
    for (let i = 0; i < n(6); i++) stepCar(car, { throttle: 1 }, p, TICK);
    const before = Math.hypot(car.vx, car.vy);
    for (let i = 0; i < n(1.0); i++) stepCar(car, { throttle: 1, surface }, p, TICK);
    return Math.hypot(car.vx, car.vy) / before;
  };
  return {
    road: run(SURFACE.ROAD), runoff: run(SURFACE.RUNOFF), grass: run(SURFACE.GRASS),
    keepRunoff: enter(SURFACE.RUNOFF), keepGrass: enter(SURFACE.GRASS),
  };
}

// Sustained speed on a surface: the lower of that surface's speed cap and the
// speed at which full throttle balances drag. Used by the cut test below as a
// deliberately GENEROUS model of a cheater (no cornering limit at all, instant
// direction changes, no time lost accelerating).
function sustainedSpeed(p, surface) {
  const cap = surface === SURFACE.GRASS ? p.offRoadCap
    : surface === SURFACE.RUNOFF ? p.runoffCap : 1;
  const drag = p.rollDrag + (surface === SURFACE.GRASS ? p.offRoadDrag
    : surface === SURFACE.RUNOFF ? p.runoffDrag : 0);
  return Math.min(p.topSpeed * cap, p.accel / drag);
}

// ------------------------------------------------ checkpoints and cutting
//
// A synthetic crossing of `gate` at parameter u along it (0 = the a end,
// 1 = the b end), travelling in the gate's forward direction (sign +1) or
// against it (-1). Returns [px, py, x, y] for advanceLap.
function crossAt(gate, u, sign, d = 8) {
  const x = gate.ax + (gate.bx - gate.ax) * u;
  const y = gate.ay + (gate.by - gate.ay) * u;
  return [x - sign * gate.fx * d, y - sign * gate.fy * d,
    x + sign * gate.fx * d, y + sign * gate.fy * d];
}

// The parameter of the gate's WIDER (outside-of-the-corner) tip, just inside
// the very end of the line.
function outerU(gate) {
  const wa = Math.hypot(gate.ax - gate.x, gate.ay - gate.y);
  const wb = Math.hypot(gate.bx - gate.x, gate.by - gate.y);
  return wa >= wb ? 0.04 : 0.96;
}

// THE SHORTEST GATE-LEGAL PATH. Coordinate descent on where each gate is
// crossed, minimising the total length of the closed polyline through
// START -> cp1 -> ... -> cpN -> START. Any cut that keeps a lap valid is at
// least this long, so if THIS path cannot beat the clean lap, nothing can.
function cheatPath() {
  const gates = [T.START_GATE, ...T.CHECKPOINTS];
  const m = gates.length;
  const u = new Array(m).fill(0.5);
  const P = i => {
    const g = gates[i];
    return [g.ax + (g.bx - g.ax) * u[i], g.ay + (g.by - g.ay) * u[i]];
  };
  for (let iter = 0; iter < 40; iter++) {
    for (let i = 0; i < m; i++) {
      const a = P((i - 1 + m) % m), b = P((i + 1) % m);
      let bestU = u[i], bestD = Infinity;
      for (let k = 0; k <= 200; k++) {
        u[i] = k / 200;
        const q = P(i);
        const d = Math.hypot(q[0] - a[0], q[1] - a[1]) +
          Math.hypot(b[0] - q[0], b[1] - q[1]);
        if (d < bestD) { bestD = d; bestU = k / 200; }
      }
      u[i] = bestU;
    }
  }
  return gates.map((g, i) => P(i));
}

// Walk a closed polyline in ~2 px steps: is it a valid lap, how long is it,
// and how long would the most generous possible cheater take to drive it?
function walkPath(poly, p) {
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(L / 2));
    for (let k = 0; k < steps; k++) {
      pts.push([a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps]);
    }
  }
  let len = 0, secs = 0;
  const onSurface = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ds = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const s = T.surfaceAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    onSurface[s] += ds;
    len += ds;
    secs += ds / sustainedSpeed(p, s);
  }
  // Two laps of the polyline through the real gate logic: the first crossing
  // of the start line arms the lap, the second completes it.
  const lap = T.createLap();
  let finished = null;
  for (let pass = 0; pass < 2 && !finished; pass++) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ev = T.advanceLap(lap, a[0], a[1], b[0], b[1]);
      if (ev.finished) { finished = ev.finished; break; }
    }
  }
  return { len, secs, onSurface, valid: !!(finished && finished.valid) };
}

// ---------------------------------------------------------------- reporting

const f = (v, d = 2) => v === null || v === undefined ? "  –  " : v.toFixed(d);

function printRun(m, perLap = true) {
  console.log(`\n  [${m.skill}]  valid laps ${m.validLaps}/${m.attempts}` +
    `  best ${f(m.bestLap)}s  mean ${f(m.meanLap)}s`);
  if (perLap && m.lapTimes.length) {
    console.log(`    laps: ${m.lapTimes.map(t => t.toFixed(2)).join("  ")}`);
  }
  console.log(`    off-road ${f(m.offRoadPct, 1)}% (concrete ${f(m.runoffPct, 1)}%,` +
    ` grass ${f(m.grassPct, 1)}%)  |  wobble ${f(m.wobble)}/s` +
    ` (steer ${f(m.steerRevPerS)}, yaw ${f(m.yawRevPerS)})` +
    `  |  yaw-acc rms ${f(m.rmsYawAcc, 1)} rad/s^2`);
  console.log(`    lat g: peak ${f(m.peakLatG)}  rms ${f(m.rmsLatG)}` +
    `  |  traction circle ${f(100 * m.traction, 0)}%` +
    `  |  max slip ${f(m.maxSlipDeg, 0)} deg${m.spinOut ? "  SPIN-OUT" : ""}`);
}

function pad(s, w) { s = String(s); return s.length >= w ? s : s + " ".repeat(w - s.length); }
function padL(s, w) { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; }

// ------------------------------------------------ the upgrade-space sweep
//
// THE INVARIANTS. The bots drive the player's car, so every claim the game
// makes about them has to survive the whole upgrade space, not just the stock
// spec. Two properties, checked at every sampled combination of the DRIVING
// upgrades (speed / accel / grip / boostPwr / boostDur — Lap Payout and Ghost
// Fleet are economy only and cannot make anyone quicker, so they are excluded
// by construction: the sweep only knows about DRIVING_UPGRADES):
//
//   (a) ORDERING     proplus < pro < mid < novice, on best flying lap.
//   (b) MONOTONICITY buying one more level of ANY driving upgrade never makes
//                    a bot slower.
//
// Sampling: every upgrade alone at 3/7/12/20, several mixed edge cases (one
// stat maxed with the rest near zero, all-high, all-max) and a seeded random
// sample of the 21^5 space. Each combo also evaluates its five +1 neighbours,
// memoised, so the ~30 printed rows cost ~90 distinct simulated specs.
//
// Noise: MID/PRO/PRO+ are deterministic (steerNoise ~ 0), so their times are
// exact and the tolerance is tight. NOVICE is a deliberately sloppy driver
// whose per-seed spread is ~1.5-3%, so its time is the MEDIAN of five seeds
// and its tolerance is correspondingly wider. Neither tolerance is a licence
// to be slower — the sweep prints every violation with its combo, tier and
// upgrade so a regression names itself.
// Seeds averaged for a noisy tune. Seven, not five: the technical circuit has
// fourteen corners a lap and the keyboard NOVICE's per-seed spread there is
// wide enough that a five-seed median moves ~1% on its own — enough to trip
// the monotonicity gate on noise rather than on a regression.
const SWEEP_SEEDS = 7;
const SWEEP_TOL = { novice: 0.03, mid: 0.01, pro: 0.01, proplus: 0.01 };
const SWEEP_MAX = 20;

// The sweep runs on EVERY track, which would triple a 22 s job. So the
// combination list is sampled per track: the full grid on the reference
// circuit (the drift track — the one with the most moving parts, since it is
// the only one where the corner analyser plans zones), and a reduced grid that
// still covers each upgrade alone, the mixed extremes and a random sample on
// the other two.
function sweepCombos(mode = "full") {
  const out = [];
  const push = o => out.push(Object.fromEntries(DRIVING_UPGRADES.map(k => [k, o[k] || 0])));
  push({});
  const levels = mode === "full" ? [3, 7, 12, 20] : [7, 20];
  for (const u of DRIVING_UPGRADES) for (const v of levels) push({ [u]: v });
  if (mode === "full") {
    push({ speed: 20, accel: 2, grip: 2 });
    push({ speed: 2, accel: 20, grip: 2 });
    push({ speed: 2, accel: 2, grip: 20 });
    push({ speed: 20, accel: 20, grip: 0 });
    push({ speed: 0, accel: 20, grip: 20 });
    push({ speed: 20, accel: 0, grip: 20 });
  }
  push({ speed: 10, accel: 10, grip: 10, boostPwr: 10, boostDur: 10 });
  push({ speed: 20, accel: 20, grip: 20, boostPwr: 20, boostDur: 20 });
  const rng = mulberry32(20250812);
  for (let i = 0; i < (mode === "full" ? 8 : 3); i++) {
    const o = {};
    for (const u of DRIVING_UPGRADES) o[u] = Math.floor(rng() * (SWEEP_MAX + 1));
    push(o);
  }
  return out;
}

function upgradeSweep(mode = "full") {
  const t0 = Date.now();
  const tiers = [["novice", "novice"], ["mid", "expert"], ["pro", "pro"],
    ["proplus", "proplus"]];
  const cache = new Map();
  const specKey = lv => DRIVING_UPGRADES.map(k => lv[k] || 0).join(",");
  const at = lv => {
    const key = specKey(lv);
    if (cache.has(key)) return cache.get(key);
    const p = carParams(lv);
    const row = { params: p, zones: deriveDriftZones(p, SKILLS.proplus).zones };
    for (const [tier, skillName] of tiers) {
      const sk = SKILLS[skillName];
      const seeds = sk.steerNoise > 0.01 ? SWEEP_SEEDS : 1;
      const runs = [];
      for (let i = 0; i < seeds; i++) {
        const r = raceBest(i ? { ...sk, seed: sk.seed + i * 97 } : sk, p, { laps: 3 });
        if (r) runs.push(r);
      }
      const metric = process.env.TC_METRIC === "total"
        ? r => r.totalTicks * TICK / 3 : r => r.bestFlyingTicks * TICK;
      const times = runs.map(metric).sort((a, b) => a - b);
      row[tier] = {
        // A tune that cannot string three clean laps together on a majority of
        // seeds counts as a failure, not as a slow lap.
        lap: runs.length >= Math.ceil(seeds * 0.6) ? times[(times.length - 1) >> 1] : null,
        valid: runs.length, seeds,
        offRoad: runs.length ? runs[0].offRoadTicks * TICK : 0,
        drifts: runs.length ? runs[0].handbrakeTicks : 0,
      };
    }
    cache.set(key, row);
    return row;
  };

  const rows = [];
  const ordFails = [], monFails = [], invalid = [];
  let worstMon = 0;
  for (const combo of sweepCombos(mode)) {
    const here = at(combo);
    const lap = t => here[t].lap;
    for (const [tier] of tiers) {
      if (lap(tier) === null) invalid.push(`${specKey(combo)} ${tier} could not race 3 clean laps`);
    }
    for (const [a, b] of [["proplus", "pro"], ["pro", "mid"], ["mid", "novice"]]) {
      if (lap(a) !== null && lap(b) !== null && lap(a) >= lap(b)) {
        ordFails.push(`${specKey(combo)}: ${a} ${lap(a).toFixed(2)}s >= ${b} ${lap(b).toFixed(2)}s`);
      }
    }
    for (const u of DRIVING_UPGRADES) {
      if ((combo[u] || 0) >= SWEEP_MAX) continue;
      const up = at({ ...combo, [u]: (combo[u] || 0) + 1 });
      for (const [tier] of tiers) {
        const a = lap(tier), b = up[tier].lap;
        if (a === null) continue;
        if (b === null) {
          monFails.push(`${specKey(combo)}: ${tier} ${u}+1 stopped completing the race`);
          continue;
        }
        const pct = 100 * (b - a) / a;
        if (b > a * (1 + SWEEP_TOL[tier])) {
          if (pct > worstMon) worstMon = pct;
          monFails.push(`${specKey(combo)}: ${tier} got SLOWER buying ${u} ` +
            `(Lv ${combo[u] || 0}->${(combo[u] || 0) + 1}): ${a.toFixed(2)}s -> ${b.toFixed(2)}s (+${pct.toFixed(1)}%)`);
        } else if (pct > worstMon) worstMon = Math.max(worstMon, 0);
      }
    }
    rows.push([combo, here]);
  }

  console.log(`\nUpgrade-space sweep on ${T.TRACK_NAME} (${mode}) — the bots drive YOUR car,`);
  console.log("so the ladder and the 'an upgrade is never a downgrade' rule are checked across it.");
  console.log(`  driving upgrades: ${DRIVING_UPGRADES.join(", ")}` +
    "   (Lap Payout / Ghost Fleet are economy only and excluded)");
  console.log("  " + pad("sp,ac,gr,bp,bd", 16) + padL("novice", 9) + padL("mid", 9) +
    padL("pro", 9) + padL("proplus", 9) + "  " + pad("top", 6) + pad("PRO+ drift plan", 26));
  for (const [combo, here] of rows) {
    const zones = here.zones.map(z =>
      `${z.why[0]}${(100 * z.from).toFixed(0)}-${(100 * z.to).toFixed(0)}`).join(" ") || "-";
    console.log("  " + pad(specKey(combo), 16) +
      tiers.map(([t]) => padL(here[t].lap === null ? "FAIL" : here[t].lap.toFixed(2), 9)).join("") +
      "  " + pad(here.params.topSpeed.toFixed(0), 6) + pad(zones, 26));
  }
  const dt = Date.now() - t0;
  console.log(`  ${cache.size} distinct specs simulated in ${(dt / 1000).toFixed(1)}s` +
    `  |  ordering violations ${ordFails.length}` +
    `  |  monotonicity violations ${monFails.length}` +
    (monFails.length ? ` (worst +${worstMon.toFixed(1)}%)` : "") +
    `  |  tolerance novice ${100 * SWEEP_TOL.novice}% (median of ${SWEEP_SEEDS} seeds), others ${100 * SWEEP_TOL.mid}%`);
  for (const m of [...invalid, ...ordFails, ...monFails]) console.log(`    ! ${m}`);
  return { ordFails, monFails, invalid, worstMon, cache, at, specKey, tiers };
}

// ------------------------------------------------ upgrade sensitivity
//
// THE PROOF THAT THE THREE CIRCUITS ARE DIFFERENT TRACKS AND NOT THREE
// DRAWINGS. For each track and each driving upgrade, buy SENS_LEVELS levels of
// that upgrade ALONE and measure what it does to the best flying lap of the
// reference driver. A track's identity is not the shape, it is which column of
// this table is the big one.
//
// PRO+ is the measuring driver because it is the only tier that drifts, so it
// is the only one through which Boost Power / Boost Duration can show up at
// all — and it races its options (raceBest), so a track where the drift stops
// paying simply shows a small boost number rather than a broken lap.
const SENS_LEVELS = 8;

function sensitivity(tracks) {
  const t0 = Date.now();
  const table = {};
  for (const id of tracks) {
    T.setTrack(id);
    const lapOf = levels => {
      const r = raceBest(SKILLS.proplus, carParams(levels), { laps: 3 });
      return r ? { t: r.bestFlyingTicks * TICK, boosts: r.boostFires, tier: r.maxTierFired } : null;
    };
    const base = lapOf(ZERO_LEVELS);
    const row = { base: base ? base.t : null, boosts: base ? base.boosts : 0,
      tier: base ? base.tier : 0, gain: {} };
    for (const u of DRIVING_UPGRADES) {
      const up = lapOf({ ...ZERO_LEVELS, [u]: SENS_LEVELS });
      row.gain[u] = base && up ? 100 * (base.t - up.t) / base.t : NaN;
    }
    // What the drift line itself is worth here: PRO+ (which slides where its
    // analyser says to) against PRO (the best clean line), same car.
    const proRec = raceBest(SKILLS.pro, carParams(ZERO_LEVELS), { laps: 3 });
    row.driftGain = proRec && base
      ? 100 * (proRec.bestFlyingTicks * TICK - base.t) / (proRec.bestFlyingTicks * TICK) : NaN;
    table[id] = row;
  }
  console.log("\nUPGRADE SENSITIVITY — % off PRO+'s best flying lap for " +
    `${SENS_LEVELS} levels of one upgrade, per track.`);
  console.log("  " + pad("track", 12) + pad("designed for", 15) + padL("base lap", 10) +
    DRIVING_UPGRADES.map(u => padL(u, 10)).join("") + padL("drift line", 12) + "  boosts/lap");
  for (const id of tracks) {
    const r = table[id];
    const meta = T.TRACKS.find(t => t.id === id);
    console.log("  " + pad(id, 12) + pad(meta.skillLabel, 15) +
      padL(r.base.toFixed(2) + "s", 10) +
      DRIVING_UPGRADES.map(u => padL(r.gain[u].toFixed(2) + "%", 10)).join("") +
      padL(r.driftGain.toFixed(1) + "%", 12) +
      `  ${(r.boosts / 3).toFixed(1)} (tier ${r.tier})`);
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return table;
}


// ------------------------------------------------ VALUE PER CREDIT
//
// THE DIFFERENTIATION MEASUREMENT. The old version of this bought EIGHT LEVELS
// of each upgrade and compared the lap time that bought — which is not a
// decision any player ever faces, because levels are not what you spend. Top
// Speed measured as the biggest lever on two circuits out of three and looked
// like a design failure; what it actually was, in part, was a measurement that
// ignored half the decision.
//
// So: give every upgrade THE SAME PILE OF CREDITS, let it buy as many levels
// as that affords, and compare the lap time each pile bought. That is the
// choice the player is really making, and it is what the gates below assert.
// Several budgets, because "which upgrade first" must not depend on being
// early or late in the run.
const VPC_BUDGETS = [1200, 3000, 8000];

function valuePerCredit(tracks) {
  const t0 = Date.now();
  const table = {};
  for (const id of tracks) {
    T.setTrack(id);
    const lapOf = levels => {
      const r = raceBest(SKILLS.proplus, carParams(levels), { laps: 3 });
      return r ? r.bestFlyingTicks * TICK : null;
    };
    const base = lapOf(ZERO_LEVELS);
    const rows = {};
    for (const B of VPC_BUDGETS) {
      const row = {};
      for (const u of DRIVING_UPGRADES) {
        const { levels, spent } = levelsForBudget(u, B);
        const lap = lapOf({ ...ZERO_LEVELS, [u]: levels });
        row[u] = { levels, spent, gain: 100 * (base - lap) / base };
      }
      // ...plus the pair of boost upgrades, splitting the same budget between
      // them. Boost Power and Boost Duration are two halves of one purchase —
      // a stronger burst that lasts no longer, or a longer burst that is no
      // stronger, is half a plan — so the fair comparison against a single
      // upgrade's pile of credits is the pile split across the pair.
      const a = levelsForBudget("boostPwr", B / 2);
      const b = levelsForBudget("boostDur", B / 2);
      const lap = lapOf({ ...ZERO_LEVELS, boostPwr: a.levels, boostDur: b.levels });
      row.boost = { levels: `${a.levels}+${b.levels}`, spent: a.spent + b.spent,
        gain: 100 * (base - lap) / base };
      rows[B] = row;
    }
    table[id] = { base, rows };
  }
  const cols = [...DRIVING_UPGRADES, "boost"];
  console.log("\nVALUE PER CREDIT — same credits on each upgrade, % off PRO+'s best flying lap.");
  console.log("  (levels the budget buys in brackets; 'boost' = the budget split across " +
    "Boost Power + Boost Duration)");
  console.log("  " + pad("track", 11) + pad("budget", 8) +
    cols.map(u => padL(u, 15)).join(""));
  for (const id of tracks) {
    for (const B of VPC_BUDGETS) {
      const row = table[id].rows[B];
      const best = cols.reduce((x, u) => row[u].gain > row[x].gain ? u : x, cols[0]);
      console.log("  " + pad(id, 11) + pad(B + " cr", 8) +
        cols.map(u => padL(`${row[u].gain.toFixed(2)}% (${row[u].levels})` +
          (u === best ? "*" : " "), 15)).join(""));
    }
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s   (* = best value on that row)`);
  return table;
}

// ------------------------------------------------ per-track expectations
//
// The gates that are ABOUT THE CIRCUIT rather than about the physics. Every
// track has to be casual-friendly (the novice numbers) and has to hold the
// tier ladder, but "how much does the clean line have to lift" and "must
// drifting pay" are properties of the track's design, not universal truths —
// the speedway exists precisely to be a lap you barely lift on, and asserting
// a hairpin's worth of braking there would be asserting the wrong thing.
const TRACK_EXPECT = {
  ember: {
    pace: [8, 16],          // MID's best flying lap, seconds
    liftFrac: 0.85,         // PRO's slowest FLYING-lap speed, x top speed
    driftPays: { secs: 0.6, frac: 0.06 },   // vs the clean line, standing lap
    wobble: 3.8,
  },
  longshore: {
    pace: [10, 20],
    liftFrac: 1.0,          // a near-flat-out lap IS this circuit's design
    driftPays: null,        // no corner here is long enough to bank a charge
    wobble: 3.8,
  },
  lantern: {
    pace: [8, 18],
    liftFrac: 0.75,
    driftPays: null,        // ditto — this one is decided by cornering, not boost
    wobble: 4.5,            // ten corners a lap: more (legitimate) steering work
  },
};

// The three DESIGNED circuits carry the full machinery — the friendliness /
// ladder / margin gates, the per-track upgrade-space sweep, and the specialist-
// differentiation gates. The fourth circuit, CAPE CRUISE, is a long, chill
// cruise with NO dominant upgrade by design, so it is EXEMPT from the
// differentiation gates (they would assert a specialist it deliberately lacks)
// and from the heavy per-track sweep (a multi-minute lap would make it crawl);
// it gets a small, cheap check set of its own (see cruiseChecks). Iterating the
// designed three explicitly — rather than T.TRACKS — is exactly what keeps
// adding the cruise from perturbing the existing per-track checks.
const DESIGNED = ["ember", "longshore", "lantern"];

// ---------------------------------------------------------------- checks
//
// The acceptance suite is in three parts:
//   physicsChecks()  scripted feature/exploit tests — pure physics, no track,
//                    so they run once.
//   trackChecks()    everything that is about DRIVING A CIRCUIT: the novice
//                    friendliness gates, the tier ladder, the 3-lap race, the
//                    on-road margins and the per-track design intent. Run on
//                    EVERY track, because a track only the pro bot survives is
//                    not a track this game ships.
//   the sweeps       the upgrade-space invariants, per track.
//   sensitivity()    the proof that the three circuits reward different things.

// ------------------------------------------------ grid + economy logic
//
// Light checks on the ENDLESS-model plumbing, deliberately kept out of the
// driving sweep (grid slots, ranked-lap insertion and the fleet-buy gate do
// not affect how the car drives — the user's requirement). Pure functions, so
// they cost microseconds.

// The F1 grid: five slots (player pole + four bots), each further back along
// the track than the one ahead, all distinct and on the racing surface — AND,
// the load-bearing half, the four bots' ACTUAL simulated recordings must begin
// at their assigned slots. Testing gridSlot() in isolation is not enough: it
// once returned correct slots that recordRace never consumed, so the field
// launched stacked on the pole. This simulates the real field and asserts each
// bot's sample[0] == gridSlot(tier+1), mutually distinct, on every track.
function gridChecks(tracks) {
  const checks = [];
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5;
  for (const id of tracks) {
    T.setTrack(id);
    const slots = [0, 1, 2, 3, 4].map(k => T.gridSlot(k));
    // Arc length behind the start line, per slot (the line is at arc 0).
    const behind = slots.map(s => {
      const i = T.nearestIndex(s.x, s.y);
      return ((T.TRACK_LEN - T.CUMLEN[i]) % T.TRACK_LEN + T.TRACK_LEN) % T.TRACK_LEN;
    });
    let ordered = true, distinct = true, onRoad = true;
    for (let k = 1; k < slots.length; k++) {
      if (!(behind[k] > behind[k - 1] + 1)) ordered = false;   // each further back
      const dx = slots[k].x - slots[k - 1].x, dy = slots[k].y - slots[k - 1].y;
      if (Math.hypot(dx, dy) < 10) distinct = false;
    }
    for (const s of slots) if (T.surfaceAt(s.x, s.y) !== SURFACE.ROAD) onRoad = false;

    // Simulate the real four-bot field and check where each recording BEGINS.
    const field = simulateBotField(carParams(ZERO_LEVELS));
    // Field order follows BOT_TIERS (novice, mid, pro, proplus) = slots 1..4.
    const starts = field.map(g => g.samples[0]);
    let startsAtSlot = field.length === 4;
    field.forEach((g, ti) => {
      const slot = T.gridSlot(ti + 1);
      if (!near(g.samples[0], [slot.x, slot.y])) startsAtSlot = false;
    });
    let startsDistinct = true;
    for (let a = 0; a < starts.length; a++) {
      for (let b = a + 1; b < starts.length; b++) {
        if (Math.hypot(starts[a][0] - starts[b][0], starts[a][1] - starts[b][1]) < 5) {
          startsDistinct = false;
        }
      }
    }
    console.log(`  [${id}] bot grid starts: ` + field.map((g, ti) =>
      `${g.short} (${g.samples[0][0].toFixed(0)},${g.samples[0][1].toFixed(0)})`).join("  "));

    checks.push(
      [`[${id}] grid slots are distinct and ordered pole -> 5th (each further back)`,
        ordered && distinct],
      [`[${id}] every grid slot sits on the racing surface`, onRoad],
      [`[${id}] the four bot recordings actually START at their grid slots (1..4)`,
        startsAtSlot],
      [`[${id}] the four bot start positions are mutually distinct (no stacking on pole)`,
        startsDistinct]);
  }
  return checks;
}

// The ranked-lap list stays sorted fastest-first and capped, and the fleet-size
// gate never lets the fleet exceed the number of recorded laps.
function economyLogicChecks() {
  // Insert out of order; the list must come out ascending and capped.
  const list = [];
  const times = [1200, 900, 1500, 900, 700, 2000, 1100];
  for (const t of times) insertRankedLap(list, { ticks: t, samples: [[0, 0, 0], [1, 1, 0]] });
  const sorted = list.every((e, i) => i === 0 || list[i - 1].ticks <= e.ticks);
  const best = list.length && list[0].ticks === 700;
  // Cap: push far more than the cap and confirm it never grows past it, keeping
  // the fastest.
  const big = [];
  for (let i = 0; i < RANKED_LAPS_CAP * 3; i++) {
    insertRankedLap(big, { ticks: 500 + ((i * 37) % 1000), samples: [[0, 0, 0], [1, 1, 0]] });
  }
  const capped = big.length === RANKED_LAPS_CAP &&
    big.every((e, i) => i === 0 || big[i - 1].ticks <= e.ticks);
  // Rank returned points at where the lap landed (or -1 when too slow to fit).
  const rankReturn = (() => {
    const l = [{ ticks: 100 }, { ticks: 200 }];
    const r1 = insertRankedLap(l, { ticks: 150 }, 3);          // lands at index 1
    const r2 = insertRankedLap(l, { ticks: 999 }, 3);          // full now, too slow -> -1
    return r1 === 1 && r2 === -1;
  })();
  // Fleet-size gate: never exceeds the recorded-lap count; buying is only
  // unblocked when there is another distinct lap to fill.
  let gateOK = true;
  for (let lvl = 0; lvl <= 15; lvl++) {
    for (let laps = 0; laps <= 15; laps++) {
      const n = fleetSize(lvl, laps);
      if (n !== Math.min(1 + lvl, laps)) gateOK = false;
      if (n > laps) gateOK = false;
      // The buy is unlocked exactly when there is a lap the new ghost can use.
      const canBuy = laps > n;
      if (canBuy && fleetSize(lvl + 1, laps) <= n) gateOK = false;
    }
  }
  return [
    ["ranked laps: insertion keeps the list sorted fastest-first", sorted && best],
    [`ranked laps: the list is capped at ${RANKED_LAPS_CAP}, keeping the fastest`, capped],
    ["ranked laps: insert returns the landing rank (or -1 when too slow to fit)", rankReturn],
    ["fleet gate: fleet size never exceeds the recorded-lap count", gateOK],
  ];
}

function physicsChecks() {
  const p = carParams(ZERO_LEVELS);
  const db = driftBoostTest(p);
  const dc = driftControlTest(p);
  const xs = exploitStraightTest(p);
  const xp = exploitStopTest(p);
  const bg = brakeGateTest(p);
  const sf = surfaceTest(p);
  console.log(`\nDrift-boost script: 1.0s drift -> charge ${db.charge.toFixed(2)}s` +
    ` (tier ${db.tierBanked}, max slip ${(db.maxSlip * 180 / Math.PI).toFixed(0)} deg),` +
    ` release peak ${db.peak.toFixed(0)} px/s (top ${db.topSpeed}),` +
    ` slip<10deg after ${db.settle === null ? ">2.5" : db.settle.toFixed(2)}s`);
  console.log(`Drift-control script: settled slip band ${dc.bandMin.toFixed(0)}..` +
    `${dc.bandMax.toFixed(0)} deg (peak ${dc.maxSlip.toFixed(0)}),` +
    ` steer-release slip<10deg after ${dc.tUnder10 === null ? ">1.2" : dc.tUnder10.toFixed(2)}s` +
    `${dc.signFlip ? ", SIGN-FLIP" : ", no sign-flip"}`);
  console.log(`Exploit scripts: straight 2s handbrake -> max charge ${xs.maxCharge.toFixed(2)}s,` +
    ` kept ${(100 * xs.keptFrac).toFixed(0)}% of plain-coast speed` +
    ` (${xs.exit.toFixed(0)} vs ${xs.coastExit.toFixed(0)} px/s)` +
    `${xs.boostFired ? ", BOOST FIRED" : ""};` +
    ` stop-with-charge (banked ${xp.chargeBanked.toFixed(2)}s) -> at stop` +
    ` ${xp.chargeAtStop.toFixed(2)}s${xp.boostFired ? ", BOOST FIRED" : ", no boost"}`);
  console.log(`Brake-gate script: from ${bg.entry.toFixed(0)} px/s, stop at` +
    ` ${bg.tStop === null ? "never" : bg.tStop.toFixed(2) + "s"}, held stopped` +
    ` ${bg.hold === null ? "n/a" : bg.hold.toFixed(2) + "s"} before reverse`);
  console.log(`Surface script: flat-out settled speed  road ${sf.road.toFixed(0)}` +
    `  runoff ${sf.runoff.toFixed(0)} (${(100 * sf.runoff / sf.road).toFixed(0)}% of road)` +
    `  grass ${sf.grass.toFixed(0)} (${(100 * sf.grass / sf.road).toFixed(0)}%)` +
    `  |  1 s after running wide at speed you keep` +
    ` ${(100 * sf.keepRunoff).toFixed(0)}% (runoff) vs` +
    ` ${(100 * sf.keepGrass).toFixed(0)}% (grass)`);

  return [
    ["drift boost: ~1s sustained drift banks tier 1", db.tierBanked >= 1],
    // Tier 1 is +28% for 1.1 s, so a 1 s drift must show a clear burst.
    ["drift boost: release peak >= +25% over top speed", db.peak >= p.topSpeed * 1.25],
    ["drift boost: slip < 10 deg within 0.6s of release",
      db.settle !== null && db.settle <= 0.6],
    ["drift control: slip settles in 15..40 deg band on constant steer",
      dc.bandMin >= 15 && dc.bandMax <= 40],
    ["drift control: never diverges past 55 deg", dc.maxSlip < 55],
    ["drift control: slip < 10 deg within 0.8s of steer release",
      dc.tUnder10 !== null && dc.tUnder10 <= 0.8],
    ["drift control: no sign-flip oscillation after release", !dc.signFlip],
    ["exploit: 2s straight-line handbrake stays below tier 1",
      xs.maxCharge < p.boostTier1 && !xs.boostFired],
    ["exploit: straight handbrake mostly coasts (>= 75% of plain-coast speed)",
      xs.keptFrac >= 0.75],
    ["exploit: handbrake-to-stop fires no boost (had tier-1 charge banked)",
      xp.chargeBanked >= p.boostTier1 && !xp.boostFired && xp.peakAfter < 40],
    ["brake gate: reaches a full stop under held brake", bg.tStop !== null],
    ["brake gate: holds the stop >= 0.3s before reverse",
      bg.hold !== null && bg.hold >= 0.3],
    // ---- three surfaces, and the runoff strictly between the other two ----
    ["surfaces: runoff is strictly slower than road and strictly faster than grass",
      sf.runoff < sf.road && sf.runoff > sf.grass],
    ["surfaces: runoff is a nudge, not a penalty (>= 85% of road speed)",
      sf.runoff >= 0.85 * sf.road],
    ["surfaces: grass is still the thing to avoid (< 45% of road speed)",
      sf.grass < 0.45 * sf.road],
    ["surfaces: running wide onto concrete at speed costs < 10% in the first second",
      sf.keepRunoff > 0.90 && sf.keepRunoff < 1 && sf.keepGrass < 0.6 * sf.keepRunoff],
  ];
}

// ------------------------------------------ gates, runoff and cutting
//
// Everything about the ACTIVE track's gate rules and its concrete skirt. Pure
// geometry and gate arithmetic — no bot laps — so it costs milliseconds.
function gateAndSurfaceChecks(p, novice) {
  const id = T.TRACK_ID;
  const q = s => `[${id}] ${s}`;
  const cps = T.CHECKPOINTS;
  const t = T.TRACK;

  // ---- (1) a lap salvaged by crossing one checkpoint BACKWARDS is valid ----
  const salvage = (() => {
    const lap = T.createLap();
    T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    cps.forEach((g, i) => {
      // Take checkpoint 2 (or the last one, on a short list) backwards, as a
      // driver who spun and reversed through it would.
      const back = i === Math.min(1, cps.length - 1);
      T.advanceLap(lap, ...crossAt(g, 0.5, back ? -1 : 1));
    });
    const ev = T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    return ev.finished && ev.finished.valid;
  })();

  // ---- (2) a checkpoint registers from well OFF the racing surface ----
  const offSurface = cps.map(g => {
    const u = outerU(g);
    const x = g.ax + (g.bx - g.ax) * u, y = g.ay + (g.by - g.ay) * u;
    return { surf: T.surfaceAt(x, y), dist: T.distToTrack(x, y) };
  });
  const wideEnough = offSurface.every(o => o.surf !== SURFACE.ROAD &&
    o.dist > T.ROAD_HALF + 20);
  const wideRegisters = (() => {
    const lap = T.createLap();
    T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    for (const g of cps) T.advanceLap(lap, ...crossAt(g, outerU(g), 1));
    const ev = T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    return ev.finished && ev.finished.valid;
  })();

  // ---- (3) EXPLOITS ----
  // (a) shuttling back and forth over one gate never advances past it.
  const shuttle = (() => {
    const lap = T.createLap();
    T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    for (let i = 0; i < 12; i++) {
      T.advanceLap(lap, ...crossAt(cps[0], 0.5, i % 2 ? -1 : 1));
    }
    return lap.nextCp === 1;
  })();
  // (b) the finish line is DIRECTIONAL: reversing back over it is not a
  // crossing, and crossing it again forwards ends the lap as INVALID.
  const finishDirectional = (() => {
    const lap = T.createLap();
    T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    const back = T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, -1));
    const again = T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    return !back.started && !back.finished &&
      again.finished && !again.finished.valid;
  })();
  // (c) taking the checkpoints in REVERSE order does not validate a lap.
  const reverseOrder = (() => {
    if (cps.length < 2) return true;
    const lap = T.createLap();
    T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    for (let i = cps.length - 1; i >= 0; i--) {
      T.advanceLap(lap, ...crossAt(cps[i], 0.5, -1));
    }
    const ev = T.advanceLap(lap, ...crossAt(T.START_GATE, 0.5, 1));
    return ev.finished && !ev.finished.valid;
  })();

  // ---- (4) CUTTING. The shortest gate-legal path there is, driven by a
  // cheater with no cornering limit at all, against PRO's real clean lap.
  const cut = walkPath(cheatPath(), p);

  // ---- (5) THE RUNOFF: at the corners, on the outside, and not everywhere --
  const kEnter = 1 / (8 * T.ROAD_HALF);       // the corner threshold it derives from
  const bandsOK = (() => {
    let ok = true, bands = 0;
    for (const [arr, sgn] of [[t.RUNOFF_POS, 1], [t.RUNOFF_NEG, -1]]) {
      let start = -1;
      for (let k = 0; k < t.N; k++) if (arr[k] <= 0) { start = k; break; }
      if (start < 0) return false;             // concrete the whole way round
      let run = null;
      for (let k = 0; k <= t.N; k++) {
        const i = (start + k) % t.N;
        if (arr[i] > 0) { (run || (run = [])).push(i); continue; }
        if (!run) continue;
        bands++;
        // The band's peak curvature has to be a real corner, and the concrete
        // has to be on the OUTSIDE of it (curvature > 0 bends toward +normal,
        // so the outside is the -normal side).
        let peak = 0;
        for (const j of run) {
          const kk = t.curvSigned(j);
          if (Math.abs(kk) > Math.abs(peak)) peak = kk;
        }
        if (Math.abs(peak) < kEnter) ok = false;
        if (Math.sign(peak) === Math.sign(sgn)) ok = false;
        run = null;
      }
    }
    return ok && bands > 0;
  })();
  // The longest stretch with no concrete on either side — the straights have
  // to still be bare, or "at the corners" means nothing.
  const bareRun = (() => {
    let best = 0, cur = 0;
    for (let k = 0; k < 2 * t.N; k++) {
      const i = k % t.N;
      if (t.RUNOFF_POS[i] <= 0 && t.RUNOFF_NEG[i] <= 0) {
        cur += t.CUMLEN[i + 1] - t.CUMLEN[i];
        if (cur > best) best = cur;
      } else cur = 0;
    }
    return Math.min(best, t.TRACK_LEN) / t.TRACK_LEN;
  })();

  console.log(`  runoff: ${(100 * t.RUNOFF_COVERAGE).toFixed(1)}% of the lap has` +
    ` concrete on one side (so ${(100 * (1 - t.RUNOFF_COVERAGE)).toFixed(0)}% has none),` +
    ` in ${t.RUNOFF_CORNERS.length} skirt(s);` +
    ` longest bare stretch ${(100 * bareRun).toFixed(0)}% of the lap`);
  for (const c of t.RUNOFF_CORNERS) {
    console.log(`    ${(100 * c.from).toFixed(0).padStart(3)}%-` +
      `${(100 * c.to).toFixed(0).padStart(3)}%  ${pad(c.sector, 24)}` +
      ` r ${c.radius.toFixed(0).padStart(4)} px, turns ${c.turnDeg.toFixed(0).padStart(3)}deg,` +
      ` demand ${c.demand.toFixed(2)} -> ${c.width.toFixed(0)} px of concrete`);
  }
  console.log(`  checkpoint gates reach ${offSurface[0].dist.toFixed(0)} px from the` +
    ` centerline at their outer tip (road half-width ${T.ROAD_HALF} px)`);
  console.log(`  cutting: shortest gate-legal path ${cut.len.toFixed(0)} px` +
    ` (${(100 * cut.len / T.TRACK_LEN).toFixed(0)}% of the lap),` +
    ` ${cut.onSurface[2].toFixed(0)} px of it on grass;` +
    ` best possible time on it ${cut.secs.toFixed(2)}s` +
    ` (lap ${cut.valid ? "valid" : "INVALID"})`);

  return {
    cut,
    checks: [
      [q("checkpoints count in EITHER direction: a lap with one gate taken backwards is valid"),
        salvage],
      [q("checkpoint gates reach well past the road edge, into the runoff/grass"),
        wideEnough],
      [q("a checkpoint registers from the far tip of the gate, off the racing surface"),
        wideRegisters],
      [q("exploit: shuttling over one gate never advances past it"), shuttle],
      [q("exploit: the finish line stays directional — reverse-and-recross scores an invalid lap"),
        finishDirectional],
      [q("exploit: taking the checkpoints in reverse order does not validate a lap"),
        reverseOrder],
      // "Not everywhere": a quarter of the lap has no concrete at all, and
      // there is at least one unbroken bare stretch. The bare-stretch bar is
      // low on purpose — the coil is seven linked corners with no straight
      // longer than 91 px, so demanding a long bare run there would be
      // demanding a different circuit. The load-bearing half of this gate is
      // `bandsOK`: EVERY skirt is verified, from the width arrays themselves,
      // to peak at a real corner and to sit on the OUTSIDE of it.
      [q("runoff sits at corners, on the outside, and leaves bare track between them"),
        bandsOK && bareRun >= 0.05 && (1 - T.TRACK.RUNOFF_COVERAGE) >= 0.25],
      [q("runoff exists here at all (>= 10% of the lap)"),
        T.TRACK.RUNOFF_COVERAGE >= 0.10],
      [q("novice never reaches the grass (the concrete catches it)"),
        novice.grassPct === 0],
    ],
  };
}

// Everything that has to hold ON THE ACTIVE TRACK. `results` is the runBot
// telemetry suite for this track. Returns { checks, summary }.
function trackChecks(results) {
  const trackId = T.TRACK_ID;
  const nov = results.novice, exp = results.expert;
  const pro = results.pro, pp = results.proplus;
  const want = TRACK_EXPECT[trackId];
  const p = carParams(ZERO_LEVELS);
  const q = s => `[${trackId}] ${s}`;

  // Shipped-ghost robustness: a race is THREE LAPS (lap 1 standing, laps 2-3
  // flying), and the recordings the game grids up must stay clearly ON the
  // road for all of it — minimum distance to the road edge over the whole race
  // (ROAD_HALF minus the max centerline distance reached). Guards against
  // re-tunes that buy lap time by running the ragged edge of the grip limit.
  // Margin to the ROAD edge, not the runoff edge. That choice is deliberate:
  // the concrete skirt exists to forgive the player, and a bot allowed to
  // measure itself against the outside of it would simply drive 30 px wider
  // everywhere and call it a racing line. recordRace already tracked the
  // furthest the car ever got from the centerline, so this is free.
  const edgeMargin = rec => T.ROAD_HALF - rec.maxDist;
  const RACE_TIERS = [["novice", "novice"], ["mid", "expert"],
    ["pro", "pro"], ["proplus", "proplus"]];
  const races = {};
  for (const [ghost, skillName] of RACE_TIERS) {
    // raceBest, not recordRace: this is exactly what the game grids up, so a
    // drift-capable tier is gated on the strategy it actually races.
    races[ghost] = raceBest(SKILLS[skillName], p, { laps: 3 });
  }
  const proRec = races.pro, ppRec = races.proplus;
  const proMargin = proRec ? edgeMargin(proRec) : -Infinity;
  const ppMargin = ppRec ? edgeMargin(ppRec) : -Infinity;
  const proLap = proRec ? proRec.lapTicks[0] * TICK : null;
  const ppLap = ppRec ? ppRec.lapTicks[0] * TICK : null;
  const driftGain = proLap !== null && ppLap !== null ? proLap - ppLap : null;
  // The lift gate looks at the FLYING laps only: lap 1 starts from rest, so
  // its slowest point is the launch, not a corner.
  const flyLaps = proRec ? proRec.perLap.slice(1) : [];
  const slowest = flyLaps.length
    ? flyLaps.reduce((a, b) => a.minSpeed <= b.minSpeed ? a : b) : null;
  const proFlyMin = slowest ? slowest.minSpeed : Infinity;

  console.log(`\n${T.TRACK_NAME} — 3-lap race recordings (lap 1 standing, laps 2-3 flying):`);
  console.log("  " + pad("tier", 9) + pad("lap 1", 9) + pad("lap 2", 9) +
    pad("lap 3", 9) + pad("total", 9) + pad("best fly", 10) + pad("fly gain", 10) +
    pad("margin", 9) + pad("boosts", 9));
  for (const [ghost] of RACE_TIERS) {
    const r = races[ghost];
    if (!r) { console.log(`  ${pad(ghost, 9)}FAILED — no 3 valid laps`); continue; }
    const gain = (r.lapTicks[0] - r.bestFlyingTicks) * TICK;
    console.log("  " + pad(ghost, 9) +
      r.lapTicks.map(t => pad(f(t * TICK), 9)).join("") +
      pad(f(r.totalTicks * TICK), 9) + pad(f(r.bestFlyingTicks * TICK), 10) +
      pad(`-${gain.toFixed(2)}s`, 10) + pad(f(edgeMargin(r), 1), 9) +
      pad(`${r.boostFires}${r.maxTierFired ? ` (t${r.maxTierFired})` : ""}`, 9));
  }
  console.log(`  drift line pays ${driftGain === null ? "n/a" : driftGain.toFixed(2) + "s"}` +
    `${driftGain !== null && proLap ? ` (${(100 * driftGain / proLap).toFixed(1)}%)` : ""}` +
    ` on the standing lap; edge margin pro ${proMargin.toFixed(1)} px,` +
    ` proplus ${ppMargin.toFixed(1)} px`);
  if (proRec) {
    console.log(`  clean-line lift: PRO brakes for ${(proRec.brakeTicks * TICK).toFixed(2)}s` +
      ` of its race; slowest FLYING-lap point ${proFlyMin.toFixed(0)} px/s` +
      ` (${(100 * proFlyMin / p.topSpeed).toFixed(0)}% of top speed)` +
      ` at ${T.sectorAt(slowest ? slowest.minSpeedFrac : 0)}`);
  }

  const checks = [
    // ---- casual friendliness: the novice bot is the regression gate ----
    [q("novice completes >= 8/10 valid laps"), nov.validLaps >= 8],
    [q("novice off-road ticks < 6%"), nov.offRoadPct < 6],
    // Calibrated: v0 physics measures ~5.3/s with the same keyboard novice
    // bot; ~1.7/s of the index is the bot's own bang-bang input reversals.
    [q(`novice wobble index < ${want.wobble}/s`), nov.wobble < want.wobble],
    [q("expert best >= 12% faster than novice mean"),
      exp.bestLap !== null && nov.meanLap !== null && exp.bestLap <= nov.meanLap * 0.88],
    [q(`MID best flying lap in ${want.pace[0]}..${want.pace[1]} s (pace sanity)`),
      races.mid !== null && races.mid.bestFlyingTicks * TICK >= want.pace[0] &&
      races.mid.bestFlyingTicks * TICK <= want.pace[1]],
    [q("no bot spins out (slip < 90 deg outside drift)"),
      Object.values(results).every(r => !r.spinOut)],
    // ---- the tier ladder ----
    [q("pro (clean line) completes >= 8/10 valid laps"), pro.validLaps >= 8],
    [q("pro (clean line) best beats expert/MID best without the handbrake"),
      pro.bestLap !== null && exp.bestLap !== null &&
      pro.bestLap < exp.bestLap && pro.handbrakeTicks === 0],
    [q("proplus best beats pro best"),
      pp.bestLap !== null && pro.bestLap !== null && pp.bestLap < pro.bestLap],
    // ENDLESS MODEL: the game grids everyone up, launches at GO, and the bots
    // then loop their flying lap forever. So what has to hold is that each bot
    // strings consecutive valid laps (the field loops these) and that a flying
    // lap is genuinely faster than the gridded standing launch.
    [q("every reference bot strings consecutive valid laps (the endless field loops these)"),
      RACE_TIERS.every(([g]) => races[g] && races[g].lapTicks.length === 3)],
    [q("a flying lap is faster than the gridded standing launch"),
      RACE_TIERS.every(([g]) => races[g] &&
        races[g].bestFlyingTicks < races[g].lapTicks[0])],
    [q("tier ladder holds on best flying lap (proplus < pro < mid < novice)"),
      RACE_TIERS.every(([g]) => races[g]) &&
      races.proplus.bestFlyingTicks < races.pro.bestFlyingTicks &&
      races.pro.bestFlyingTicks < races.mid.bestFlyingTicks &&
      races.mid.bestFlyingTicks < races.novice.bestFlyingTicks],
    // ---- on-road margin: a "faster" tune that scrapes the grass is fragile ----
    [q("pro 3-lap race stays >= 8 px inside the road edge"),
      proRec !== null && proMargin >= 8],
    [q("proplus 3-lap race stays >= 3 px inside the road edge"),
      ppRec !== null && ppMargin >= 3],
    // ---- per-track design intent ----
    [q(`PRO's clean line lifts below ${(100 * want.liftFrac).toFixed(0)}% of top speed`),
      proRec !== null && proRec.brakeTicks > 0 &&
      proFlyMin < p.topSpeed * want.liftFrac],
  ];
  // The drift gate is PER TRACK. On the boost circuit the drift line has to
  // pay a felt margin or the whole design is decoration; on the speedway and
  // the coil no corner is long enough to bank a charge in, and demanding a
  // drift there would be demanding the wrong thing — so the gate becomes
  // "PRO+ is still ahead, without needing the handbrake to do it".
  if (want.driftPays) {
    checks.push([q("proplus genuinely drifts: handbrake held, >= 1 boost per valid lap"),
      pp.handbrakeTicks > 0 && pp.validLaps > 0 && pp.boostFires >= pp.validLaps]);
    checks.push([q(`drift line pays >= ${want.driftPays.secs}s AND >= ` +
      `${(100 * want.driftPays.frac).toFixed(0)}% over the clean line (standing start)`),
      driftGain !== null && proLap !== null &&
      driftGain >= want.driftPays.secs && driftGain / proLap >= want.driftPays.frac]);
  } else {
    checks.push([q("drift optional here: proplus still leads without needing a boost"),
      ppRec !== null && proRec !== null &&
      ppRec.bestFlyingTicks < proRec.bestFlyingTicks]);
  }

  // ---- gate rules, the concrete skirt, and whether cutting pays ----
  const gs = gateAndSurfaceChecks(p, nov);
  checks.push(...gs.checks);
  checks.push([q("cutting cannot pay: the shortest gate-legal path is slower than PRO's clean lap"),
    proRec !== null && gs.cut.secs > proRec.bestFlyingTicks * TICK]);

  const summary = {
    id: trackId, name: T.TRACK_NAME, skill: T.TRACK.skillLabel,
    len: T.TRACK_LEN, road: T.ROAD_HALF, cps: T.CHECKPOINTS.length,
    corners: T.TRACK.def.segs.filter(s => s[0] === "a").length,
    novice: races.novice ? races.novice.bestFlyingTicks * TICK : null,
    mid: races.mid ? races.mid.bestFlyingTicks * TICK : null,
    pro: races.pro ? races.pro.bestFlyingTicks * TICK : null,
    proplus: races.proplus ? races.proplus.bestFlyingTicks * TICK : null,
    novOff: nov.offRoadPct, margin: Math.min(proMargin, ppMargin),
    liftPct: 100 * proFlyMin / p.topSpeed,
    boosts: races.proplus ? races.proplus.boostFires : 0,
  };
  return { checks, summary };
}

// ------------------------------------------------ the CAPE CRUISE (exempt)
//
// The fourth circuit's SMALL check set. It is a long, deliberately chill cruise
// with no dominant upgrade, so it is exempt from the differentiation and the
// heavy upgrade-space sweep. What it still has to prove is:
//   * it is FRIENDLY: the timid NOVICE laps it and stays out of the grass;
//   * the tier LADDER holds (proplus < pro < mid < novice, best flying);
//   * basic MONOTONICITY on a small spec sample (an upgrade never slows a bot);
//   * it is genuinely LONG (its bot lap far exceeds the designed circuits');
//   * a full lap RECORDS end-to-end without hitting the recording cap;
//   * the field simulates within a first-visit budget (kept fast by the 2-lap
//     field and the absence of any drift plan to race).
// Deliberately a handful of specs, so the whole suite stays within a few
// minutes despite a multi-minute lap.
function cruiseChecks(maxDesignedSecs) {
  T.setTrack("cruise");
  const id = T.TRACK_ID;
  const q = s => `[${id}] ${s}`;
  const p = carParams(ZERO_LEVELS);
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5;

  // First-visit field (2 laps — see bots.fieldLaps): time it cold.
  const field = simulateBotField(p);
  const simMs = field.simMs;
  const by = Object.fromEntries(field.map(g => [g.key, g]));
  const nov = by.novice, mid = by.mid, pro = by.pro, pp = by.proplus;

  // Grid: five slots ordered pole->5th, distinct, on-road, and the four bot
  // recordings actually START at their slots.
  const slots = [0, 1, 2, 3, 4].map(k => T.gridSlot(k));
  const behind = slots.map(s => {
    const i = T.nearestIndex(s.x, s.y);
    return ((T.TRACK_LEN - T.CUMLEN[i]) % T.TRACK_LEN + T.TRACK_LEN) % T.TRACK_LEN;
  });
  let gridOK = field.length === 4;
  for (let k = 1; k < slots.length; k++) {
    if (!(behind[k] > behind[k - 1] + 1)) gridOK = false;
    if (Math.hypot(slots[k].x - slots[k - 1].x, slots[k].y - slots[k - 1].y) < 10) gridOK = false;
  }
  for (const s of slots) if (T.surfaceAt(s.x, s.y) !== SURFACE.ROAD) gridOK = false;
  field.forEach((g, ti) => {
    const slot = T.gridSlot(ti + 1);
    if (!near(g.samples[0], [slot.x, slot.y])) gridOK = false;
  });

  // Friendliness: the NOVICE completes a full 2-lap race and stays off the grass.
  const novRec = recordRace(SKILLS.novice, p, { laps: 2 });
  const novOffPct = novRec ? 100 * novRec.offRoadTicks / novRec.totalTicks : 100;
  const novGrassPct = novRec ? 100 * novRec.grassTicks / novRec.totalTicks : 100;

  // Ladder + a small monotonicity sample.
  const TIERS = [["novice", "novice"], ["mid", "expert"], ["pro", "pro"],
    ["proplus", "proplus"]];
  const lapOf = (sk, lv) => {
    const r = raceBest(SKILLS[sk], carParams(lv), { laps: 2 });
    return r ? r.bestFlyingTicks * TICK : null;
  };
  // stock, and +6/+7 of each of speed/grip/accel so a +1 step can be checked.
  const specs = {
    stock: {}, speed6: { speed: 6 }, speed7: { speed: 7 },
    grip6: { grip: 6 }, grip7: { grip: 7 }, accel6: { accel: 6 }, accel7: { accel: 7 },
  };
  const lap = {};
  for (const [name, lv] of Object.entries(specs)) {
    lap[name] = TIERS.map(([, sk]) => lapOf(sk, lv));
  }
  const orderOK = row => row.every(v => v !== null) &&
    row[3] < row[2] && row[2] < row[1] && row[1] < row[0];
  const ladderStock = orderOK(lap.stock);
  const orderAll = Object.values(lap).every(orderOK);
  let monoOK = true;
  for (const [lo, hi] of [["speed6", "speed7"], ["grip6", "grip7"], ["accel6", "accel7"]]) {
    for (let i = 0; i < 4; i++) {
      if (lap[lo][i] === null || lap[hi][i] === null || lap[hi][i] > lap[lo][i] * 1.01) monoOK = false;
    }
  }

  // Length + recording cap. The cap mirrors main.js's maxLapTicks().
  const capTicks = Math.max(60 * 300, Math.round(T.TRACK_LEN / 40 * 60 * 2));
  const midFly = mid ? mid.bestFlyingTicks : 0;
  const recordsFully = !!novRec &&
    novRec.lapTicks.every(t => t < capTicks) && capTicks > midFly;

  console.log(`\n${T.TRACK_NAME} — the fourth circuit (EXEMPT from differentiation):`);
  console.log(`  ${T.TRACK_LEN.toFixed(0)} px, road ${2 * T.ROAD_HALF} px, ` +
    `${T.CHECKPOINTS.length} checkpoints, field sim ${simMs.toFixed(0)} ms (2-lap field), ` +
    `recording cap ${capTicks} ticks (${(capTicks / 60).toFixed(0)}s)`);
  console.log("  " + pad("tier", 9) + pad("lap 1 (standing)", 18) + pad("lap 2 (flying)", 16) +
    pad("boosts", 8));
  for (const g of field) {
    console.log("  " + pad(g.short, 9) + pad((g.lapTicks[0] * TICK).toFixed(1) + "s", 18) +
      pad((g.bestFlyingTicks * TICK).toFixed(1) + "s", 16) + pad(g.boostFires, 8));
  }
  console.log(`  novice: ${novRec ? "valid 2-lap race" : "FAILED"}, ` +
    `off-road ${novOffPct.toFixed(2)}% (grass ${novGrassPct.toFixed(2)}%); ` +
    `mid flying lap ${(midFly * TICK).toFixed(1)}s vs designed max ${maxDesignedSecs.toFixed(1)}s`);

  return [
    [q("the four reference bots all complete the 2-lap field"), field.length === 4],
    [q("grid slots ordered/distinct/on-road AND bot recordings start at them"), gridOK],
    [q("novice cruises it: a full valid 2-lap race"), !!novRec],
    [q("novice stays out of the grass (0%) and mostly on the road (< 3% off)"),
      novGrassPct === 0 && novOffPct < 3],
    [q("tier ladder holds on best flying lap (proplus < pro < mid < novice)"), ladderStock],
    [q("ladder holds across the small upgrade sample too"), orderAll],
    [q("monotonic on the small sample: +1 level never makes a bot slower"), monoOK],
    [q("no drift plan here (a chill cruise has no chargeable corner)"),
      deriveDriftZones(p, SKILLS.proplus).zones.length === 0],
    [q(`the lap is genuinely long (>= 90s AND >= 5x the designed circuits' ${maxDesignedSecs.toFixed(0)}s)`),
      midFly * TICK >= 90 && midFly * TICK >= 5 * maxDesignedSecs],
    [q("a full lap records end-to-end without hitting the recording cap"), recordsFully],
    [q("first-visit field sim stays within budget (< 1500 ms)"), simMs < 1500],
  ];
}

// ---------------------------------------------------------------- modes

function runSuite(paramsFor, label) {
  console.log(`\n=== ${label} ===`);
  const results = {};
  for (const name of Object.keys(SKILLS)) {
    results[name] = runBot(name, SKILLS[name], paramsFor());
    printRun(results[name]);
  }
  return results;
}

function main() {
  const mode = process.argv[2] || "run";
  const t0 = Date.now();
  console.log("Trackcrimental bot harness  (10 lap attempts per bot, seeded PRNG)");
  console.log(`Telemetry scale: 10 px = 1 m; 1 g = ${G_PX.toFixed(1)} px/s^2`);
  console.log(`Tracks: ${T.TRACKS.map(t => `${t.name} (${t.skillLabel})`).join(", ")}`);

  if (mode === "sweep") {
    // Grid-search key handling constants; novice + expert metrics per combo.
    console.log("\nParam sweep (novice wobble/offroad/laps + expert best):\n");
    const turns = [1.8, 2.1, 2.4, 2.6]; // maxTurn (rad/s)
    const ramps = [4, 5, 6, 8];         // steerRampUp (1/s)
    const lats = [450, 520, 600];       // maxLatAccel (px/s^2)
    console.log(pad("maxTurn", 9) + pad("rampUp", 8) + pad("latAcc", 8) +
      pad("nov laps", 10) + pad("nov off%", 10) + pad("nov wob", 9) +
      pad("nov yacc", 10) + pad("nov mean", 10) + pad("exp best", 9));
    for (const mt of turns) for (const r of ramps) for (const la of lats) {
      const mk = () => {
        const p = carParams(ZERO_LEVELS);
        p.maxTurn = mt; p.steerRampUp = r; p.maxLatAccel = la;
        return p;
      };
      const nov = runBot("novice", SKILLS.novice, mk());
      const exp = runBot("expert", SKILLS.expert, mk());
      console.log(pad(mt, 9) + pad(r, 8) + pad(la, 8) +
        pad(`${nov.validLaps}/${nov.attempts}`, 10) +
        pad(f(nov.offRoadPct, 1), 10) + pad(f(nov.wobble), 9) +
        pad(f(nov.rmsYawAcc, 1), 10) +
        pad(f(nov.meanLap), 10) + pad(f(exp.bestLap), 9));
    }
    return;
  }

  if (mode === "baseline") {
    T.setTrack(T.TRACKS[0].id);
    runSuite(() => legacyParams(ZERO_LEVELS), "BASELINE: v0 (legacy) physics");
  }

  const checks = physicsChecks();
  // Endless-model plumbing: grid slots (per track) + ranked-lap / fleet-gate
  // logic (track-independent). Excluded from the driving sweep on purpose.
  checks.push(...gridChecks(DESIGNED));
  checks.push(...economyLogicChecks());
  const summaries = [];
  for (const meta of T.TRACKS.filter(t => DESIGNED.includes(t.id))) {
    T.setTrack(meta.id);
    const results = runSuite(() => carParams(ZERO_LEVELS),
      `${meta.name} — ${meta.skillLabel} — CURRENT physics ` +
      `(${T.TRACK_LEN.toFixed(0)} px, road ${2 * T.ROAD_HALF} px, ` +
      `${T.CHECKPOINTS.length} checkpoints)`);
    const r = trackChecks(results);
    checks.push(...r.checks);
    summaries.push(r.summary);
  }

  // ---- per-track summary ----
  console.log("\nPER-TRACK SUMMARY (best flying lap, stock car):");
  console.log("  " + pad("track", 12) + pad("designed for", 16) + padL("len px", 8) +
    padL("road", 6) + padL("cnrs", 6) + padL("cps", 5) + padL("novice", 9) +
    padL("mid", 8) + padL("pro", 8) + padL("pro+", 8) + padL("nov off%", 10) +
    padL("margin", 8) + padL("PRO lift", 10) + padL("pro+ boosts", 13));
  for (const s of summaries) {
    console.log("  " + pad(s.id, 12) + pad(s.skill, 16) + padL(s.len.toFixed(0), 8) +
      padL(2 * s.road, 6) + padL(s.corners, 6) + padL(s.cps, 5) +
      padL(f(s.novice), 9) + padL(f(s.mid), 8) + padL(f(s.pro), 8) +
      padL(f(s.proplus), 8) + padL(f(s.novOff, 2), 10) +
      padL(f(s.margin, 1), 8) + padL(s.liftPct.toFixed(0) + "%", 10) +
      padL(s.boosts, 13));
  }

  // ---- the upgrade-space sweep, per track ----
  // Full grid on the drift circuit (the only one where the corner analyser
  // plans zones, so the one with the most ways to break); a reduced grid on
  // the other two, which still covers every upgrade alone plus the extremes.
  for (const meta of T.TRACKS.filter(t => DESIGNED.includes(t.id))) {
    T.setTrack(meta.id);
    const full = meta.skill === "boost";
    const sweep = upgradeSweep(full ? "full" : "reduced");
    const stockRow = sweep.at({});
    const faster = [7, 14].every(lvl => {
      const row = sweep.at(Object.fromEntries(DRIVING_UPGRADES.map(k => [k, lvl])));
      return sweep.tiers.every(([t]) => row[t].lap !== null && stockRow[t].lap !== null &&
        row[t].lap < stockRow[t].lap);
    });
    const q = s => `[${meta.id}] ${s}`;
    checks.push(
      [q("sweep: every bot strings 3 valid laps at every sampled upgrade combo"),
        sweep.invalid.length === 0],
      [q("sweep: ordering holds everywhere (proplus < pro < mid < novice)"),
        sweep.ordFails.length === 0],
      [q("sweep: monotonic — no driving upgrade ever makes a bot slower"),
        sweep.monFails.length === 0],
      [q("upgrades actually make every bot faster (they drive your car)"), faster],
    );
  }

  // ---- the three circuits reward three different upgrades ----
  // DESIGNED only: Cape Cruise is exempt from the differentiation gates (it has
  // no dominant upgrade by design), so the sensitivity / value-per-credit tables
  // and their gates iterate the three designed circuits, never the cruise.
  const ids = DESIGNED;
  const S = sensitivity(ids);
  const gain = (id, u) => S[id].gain[u];
  const boost = id => gain(id, "boostPwr") + gain(id, "boostDur");
  const others = id => ids.filter(x => x !== id);
  const speedT = T.TRACKS.find(t => t.skill === "speed").id;
  const gripT = T.TRACKS.find(t => t.skill === "grip").id;
  const boostT = T.TRACKS.find(t => t.skill === "boost").id;
  console.log(`  Top Speed lever: ${ids.map(i => `${i} ${gain(i, "speed").toFixed(1)}%`).join(",  ")}`);
  console.log(`  Grip lever:      ${ids.map(i => `${i} ${gain(i, "grip").toFixed(1)}%`).join(",  ")}`);
  console.log(`  Boost levers:    ${ids.map(i => `${i} ${boost(i).toFixed(1)}%`).join(",  ")}`);
  console.log(`  Drift line:      ${ids.map(i => `${i} ${S[i].driftGain.toFixed(1)}%`).join(",  ")}`);
  checks.push(
    [`differentiation: Grip beats Top Speed on ${gripT}, and loses to it on ${speedT}`,
      gain(gripT, "grip") > gain(gripT, "speed") && gain(speedT, "grip") < gain(speedT, "speed")],
    [`differentiation: the boost upgrades pay >= 3% on ${boostT} (the drift track)`,
      boost(boostT) >= 3],
    [`differentiation: the boost upgrades pay >= 3x more on ${boostT} than anywhere else`,
      others(boostT).every(o => boost(boostT) >= 3 * Math.max(0, boost(o)))],
    [`differentiation: the drift line itself pays most on ${boostT}`,
      others(boostT).every(o => S[boostT].driftGain > S[o].driftGain)],
  );

  // ---- ...and the same question asked the way a player asks it: PER CREDIT.
  // The specialist for each circuit must be the best thing that circuit's
  // credits can buy, at every budget — this is the gate that says Top Speed is
  // no longer the correct answer to every question.
  const V = valuePerCredit(ids);
  const SPECIALIST = { [speedT]: "speed", [gripT]: "grip", [boostT]: "boost" };
  const RIVALS = [...DRIVING_UPGRADES, "boost"];
  const vpc = (id, u, B) => V[id].rows[B][u].gain;
  for (const id of ids) {
    const want = SPECIALIST[id];
    const label = want === "boost" ? "the boost pair" : UPGRADE_BY_ID[want].name;
    checks.push([
      `value/credit: ${label} is the best buy on ${id} at every budget ` +
      `(${VPC_BUDGETS.join(", ")} cr)`,
      VPC_BUDGETS.every(B => RIVALS.every(u =>
        u === want || (want === "boost" && (u === "boostPwr" || u === "boostDur")) ||
        vpc(id, u, B) < vpc(id, want, B)))]);
    checks.push([
      `value/credit: ${label} pays more on ${id} than on either other track`,
      others(id).every(o => vpc(id, want, 3000) > vpc(o, want, 3000))]);
  }
  checks.push(
    // The point of the rebalance: Top Speed is no longer the universal answer.
    ["value/credit: Top Speed is NOT the best buy on the drift or the grip track",
      VPC_BUDGETS.every(B => vpc(boostT, "speed", B) < vpc(boostT, "boost", B) &&
        vpc(gripT, "speed", B) < vpc(gripT, "grip", B))],
    // ...but it is still a real purchase, not a trap: it wins outright on its
    // own circuit and is the second-best thing to own on the drift track.
    [`value/credit: Top Speed still pays >= 10% on ${speedT} for a mid-game budget`,
      vpc(speedT, "speed", 3000) >= 10],
    [`value/credit: Top Speed is still worth buying on ${boostT} (>= 5%, second only to boost)`,
      vpc(boostT, "speed", 3000) >= 5 &&
      ["accel", "grip"].every(u => vpc(boostT, "speed", 3000) > vpc(boostT, u, 3000))],
  );

  // ---- the fourth circuit: CAPE CRUISE, its own small (exempt) check set ----
  const maxDesignedSecs = Math.max(...summaries.map(s => s.pro ?? 0));
  checks.push(...cruiseChecks(maxDesignedSecs));

  console.log("\nAcceptance criteria:");
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) allPass = false;
  }
  console.log(`\n${checks.length} checks in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    (allPass ? "ALL CRITERIA PASS" : "SOME CRITERIA FAIL"));
  process.exitCode = allPass ? 0 : 1;
}

main();
