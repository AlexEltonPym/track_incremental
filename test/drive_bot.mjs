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

import {
  TICK, G_PX, carParams, legacyParams, createCarState, stepCar, slipAngle,
  ZERO_LEVELS, DRIVING_UPGRADES,
} from "../physics.js";
import {
  SKILLS, runBot, recordRace, raceBest, deriveDriftZones, mulberry32,
} from "../bots.js";
import * as T from "../track.js";

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

// ---------------------------------------------------------------- reporting

const f = (v, d = 2) => v === null || v === undefined ? "  –  " : v.toFixed(d);

function printRun(m, perLap = true) {
  console.log(`\n  [${m.skill}]  valid laps ${m.validLaps}/${m.attempts}` +
    `  best ${f(m.bestLap)}s  mean ${f(m.meanLap)}s`);
  if (perLap && m.lapTimes.length) {
    console.log(`    laps: ${m.lapTimes.map(t => t.toFixed(2)).join("  ")}`);
  }
  console.log(`    off-road ${f(m.offRoadPct, 1)}%  |  wobble ${f(m.wobble)}/s` +
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

function physicsChecks() {
  const p = carParams(ZERO_LEVELS);
  const db = driftBoostTest(p);
  const dc = driftControlTest(p);
  const xs = exploitStraightTest(p);
  const xp = exploitStopTest(p);
  const bg = brakeGateTest(p);
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
  ];
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
  const edgeMargin = rec => {
    let maxD = 0;
    for (const s of rec.samples) {
      const d = T.distToTrack(s[0], s[1]);
      if (d > maxD) maxD = d;
    }
    return T.ROAD_HALF - maxD;
  };
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
    [q("every reference bot strings 3 valid laps together (a race is 3 laps)"),
      RACE_TIERS.every(([g]) => races[g] && races[g].lapTicks.length === 3)],
    [q("every bot's best FLYING lap beats its standing-start lap 1"),
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
  const summaries = [];
  for (const meta of T.TRACKS) {
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
  for (const meta of T.TRACKS) {
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
  const ids = T.TRACKS.map(t => t.id);
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
    [`differentiation: Top Speed is the biggest lever on ${speedT} (the speed track)`,
      DRIVING_UPGRADES.every(u => u === "speed" || gain(speedT, u) < gain(speedT, "speed"))],
    [`differentiation: Top Speed pays more on ${speedT} than on either other track`,
      others(speedT).every(o => gain(speedT, "speed") > gain(o, "speed"))],
    [`differentiation: Grip is the biggest lever on ${gripT} (the technical track)`,
      DRIVING_UPGRADES.every(u => u === "grip" || gain(gripT, u) < gain(gripT, "grip"))],
    [`differentiation: Grip pays more on ${gripT} than on either other track`,
      others(gripT).every(o => gain(gripT, "grip") > gain(o, "grip"))],
    [`differentiation: Grip beats Top Speed on ${gripT}, and loses to it on ${speedT}`,
      gain(gripT, "grip") > gain(gripT, "speed") && gain(speedT, "grip") < gain(speedT, "speed")],
    [`differentiation: the boost upgrades pay >= 3% on ${boostT} (the drift track)`,
      boost(boostT) >= 3],
    [`differentiation: the boost upgrades pay >= 3x more on ${boostT} than anywhere else`,
      others(boostT).every(o => boost(boostT) >= 3 * Math.max(0, boost(o)))],
    [`differentiation: the boost upgrades beat Grip on ${boostT}`,
      boost(boostT) > gain(boostT, "grip")],
    [`differentiation: the drift line itself pays most on ${boostT}`,
      others(boostT).every(o => S[boostT].driftGain > S[o].driftGain)],
  );

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
