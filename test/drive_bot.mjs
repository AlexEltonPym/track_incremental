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
  ZERO_LEVELS,
} from "../physics.js";
import { SKILLS, runBot, recordRace, deriveDriftZones } from "../bots.js";
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

function acceptance(results) {
  const nov = results.novice, exp = results.expert;
  const pro = results.pro, pp = results.proplus;

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

  // Shipped-ghost robustness: a race is THREE LAPS (lap 1 standing, laps 2-3
  // flying), and the exact recordings the exporter ships must stay clearly ON
  // the road for all of it — minimum distance to the road edge over the whole
  // race (ROAD_HALF minus the max centerline distance reached). Guards against
  // re-tunes that buy lap time by running the ragged edge of (or past) the
  // grip limit and scraping the grass, and against presets that only hold
  // together for one lap.
  const edgeMargin = rec => {
    let maxD = 0;
    for (const s of rec.samples) {
      const d = T.distToTrack(s[0], s[1]);
      if (d > maxD) maxD = d;
    }
    return T.ROAD_HALF - maxD;
  };
  // Every tier the game ships as a reference ghost, over the full race.
  const RACE_TIERS = [["novice", "novice"], ["mid", "expert"],
    ["pro", "pro"], ["proplus", "proplus"]];
  const races = {};
  for (const [ghost, skillName] of RACE_TIERS) {
    races[ghost] = recordRace(SKILLS[skillName], p, { laps: 3 });
  }
  const proRec = races.pro, ppRec = races.proplus;
  const proMargin = proRec ? edgeMargin(proRec) : -Infinity;
  const ppMargin = ppRec ? edgeMargin(ppRec) : -Infinity;
  // The headline drift gate stays on the STANDING-START lap (lap 1) so the
  // number is comparable across versions; the flying laps are reported too.
  const proLap = proRec ? proRec.lapTicks[0] * TICK : null;
  const ppLap = ppRec ? ppRec.lapTicks[0] * TICK : null;
  const driftGain = proLap !== null && ppLap !== null ? proLap - ppLap : null;

  console.log("\n3-lap race recordings (lap 1 standing, laps 2-3 flying):");
  console.log("  " + pad("tier", 9) + pad("lap 1", 9) + pad("lap 2", 9) +
    pad("lap 3", 9) + pad("total", 9) + pad("best fly", 10) + pad("fly gain", 10) +
    pad("margin", 9));
  for (const [ghost] of RACE_TIERS) {
    const r = races[ghost];
    if (!r) { console.log(`  ${pad(ghost, 9)}FAILED — no 3 valid laps`); continue; }
    const gain = (r.lapTicks[0] - r.bestFlyingTicks) * TICK;
    console.log("  " + pad(ghost, 9) +
      r.lapTicks.map(t => pad(f(t * TICK), 9)).join("") +
      pad(f(r.totalTicks * TICK), 9) + pad(f(r.bestFlyingTicks * TICK), 10) +
      pad(`-${gain.toFixed(2)}s`, 10) + pad(f(edgeMargin(r), 1), 9));
  }
  console.log(`  drift line pays ${driftGain === null ? "n/a" : driftGain.toFixed(2) + "s"}` +
    `${driftGain !== null && proLap ? ` (${(100 * driftGain / proLap).toFixed(1)}%)` : ""}` +
    ` on the standing lap; pro edge margin ${proMargin.toFixed(1)} px,` +
    ` proplus ${ppMargin.toFixed(1)} px`);
  // The v3 track's whole point: the optimal CLEAN lap can no longer be flat
  // out. Report where the gripped car is forced to slow down.
  if (proRec) {
    console.log(`Clean-line lift: PRO brakes for ${(proRec.brakeTicks * TICK).toFixed(2)}s` +
      ` of its race; slowest point ${proRec.minSpeed.toFixed(0)} px/s` +
      ` (${(100 * proRec.minSpeed / p.topSpeed).toFixed(0)}% of top speed)` +
      ` at ${T.sectorAt(proRec.minSpeedFrac)}`);
  }

  // ---- upgrade scaling ----
  // The bots drive the PLAYER'S CURRENT car, so every preset has to survive
  // the whole upgrade curve, not just the stock spec. Simulate the reference
  // field at several upgrade levels and require that each tier still strings
  // three valid laps together and that the skill ladder still holds. This is
  // the regression gate on the speed-scaled parts of the controller (the
  // reach of the brake planner, the yaw-rate corner limit, the reaction-
  // limited pace cap) and on the derived drift zones.
  const SCALE_LEVELS = [5, 10];
  const scale = {};
  console.log("\nUpgrade scaling (bots drive the player's upgraded car):");
  for (const lvl of SCALE_LEVELS) {
    const sp = carParams({ speed: lvl, accel: lvl, grip: lvl, payout: 0 });
    const zones = deriveDriftZones(sp, SKILLS.proplus).zones;
    const row = {};
    for (const [ghost, skillName] of RACE_TIERS) {
      row[ghost] = recordRace(SKILLS[skillName], sp, { laps: 3 });
    }
    scale[lvl] = row;
    console.log(`  Lv ${lvl} (top ${sp.topSpeed.toFixed(0)} px/s, latAcc ` +
      `${sp.maxLatAccel}, maxTurn ${sp.maxTurn.toFixed(2)}): PRO+ drift plan = ` +
      (zones.map(z => `${z.why} ${(100 * z.from).toFixed(0)}-${(100 * z.to).toFixed(0)}%`)
        .join(", ") || "(none)"));
    for (const [ghost] of RACE_TIERS) {
      const r = row[ghost];
      console.log("    " + pad(ghost, 9) + (r
        ? `${pad(f(r.bestFlyingTicks * TICK) + "s fly", 12)}` +
          `${pad(f(r.totalTicks * TICK) + "s race", 13)}` +
          `${pad("margin " + f(edgeMargin(r), 1), 14)}` +
          `off-road ${f(r.offRoadTicks * TICK)}s`
        : "FAILED — no 3 valid laps"));
    }
  }
  const scaleValid = lvl => RACE_TIERS.every(([g]) =>
    scale[lvl][g] && scale[lvl][g].lapTicks.length === 3);
  const scaleLadder = lvl => scaleValid(lvl) &&
    scale[lvl].proplus.bestFlyingTicks < scale[lvl].pro.bestFlyingTicks &&
    scale[lvl].pro.bestFlyingTicks < scale[lvl].mid.bestFlyingTicks &&
    scale[lvl].mid.bestFlyingTicks < scale[lvl].novice.bestFlyingTicks;
  // ...and the upgrades have to actually make the bots faster, or "the bots
  // mirror your car" is a lie.
  const scaleFaster = SCALE_LEVELS.every(lvl => scaleValid(lvl) &&
    RACE_TIERS.every(([g]) => scale[lvl][g].bestFlyingTicks < races[g].bestFlyingTicks));

  const checks = [
    ["novice completes >= 8/10 valid laps", nov.validLaps >= 8],
    ["novice off-road ticks < 6%", nov.offRoadPct < 6],
    // Calibrated: v0 physics measures ~5.3/s with the same keyboard novice
    // bot; ~1.7/s of the index is the bot's own bang-bang input reversals.
    ["novice wobble index < 3.8/s (v0 baseline ~5.3/s)", nov.wobble < 3.8],
    ["expert best >= 15% faster than novice mean",
      exp.bestLap !== null && nov.meanLap !== null && exp.bestLap <= nov.meanLap * 0.85],
    // Track v3 pace sanity (drift-less bots; humans go faster with boosts).
    ["expert best lap in 9..16 s (track pace sanity)",
      exp.bestLap !== null && exp.bestLap >= 9 && exp.bestLap <= 16],
    ["no bot spins out (slip < 90 deg outside drift)",
      Object.values(results).every(r => !r.spinOut)],
    ["drift boost: ~1s sustained drift banks tier 1", db.tierBanked >= 1],
    // v3 buffed the payout: tier 1 is +28% for 1.1 s (was +22%/0.9 s), so a
    // 1 s drift must now show a clearly bigger burst than it used to.
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
    // Reference-ghost tier ladder (novice < expert/MID < pro < proplus).
    // These gate the drift line itself: if a physics/track change makes
    // drifting stop paying, proplus falls behind pro and this fails loudly.
    ["pro (clean line) completes >= 8/10 valid laps", pro.validLaps >= 8],
    ["pro (clean line) best beats expert/MID best without the handbrake",
      pro.bestLap !== null && exp.bestLap !== null &&
      pro.bestLap < exp.bestLap && pro.handbrakeTicks === 0],
    ["proplus genuinely drifts: handbrake held, >= 1 boost per valid lap",
      pp.handbrakeTicks > 0 && pp.validLaps > 0 && pp.boostFires >= pp.validLaps],
    ["proplus (drift+boost) best beats pro best",
      pp.bestLap !== null && pro.bestLap !== null && pp.bestLap < pro.bestLap],
    // The design goal of track v3 + the boost buff: drifting has to be worth
    // a felt margin, not a rounding error (v2 shipped a 0.11 s / 1.2% gap).
    ["drift line pays >= 0.6s AND >= 6% over the clean line (standing start)",
      driftGain !== null && proLap !== null &&
      driftGain >= 0.6 && driftGain / proLap >= 0.06],
    // A race is THREE laps: every shipped ghost has to hold its line for all
    // of it, not just survive one hero lap.
    ["every reference bot strings 3 valid laps together (a race is 3 laps)",
      RACE_TIERS.every(([g]) => races[g] && races[g].lapTicks.length === 3)],
    // ...and the flying-lap benefit must be real, not presentational.
    ["every bot's best FLYING lap beats its standing-start lap 1",
      RACE_TIERS.every(([g]) => races[g] &&
        races[g].bestFlyingTicks < races[g].lapTicks[0])],
    ["tier ladder holds on best flying lap (proplus < pro < mid < novice)",
      RACE_TIERS.every(([g]) => races[g]) &&
      races.proplus.bestFlyingTicks < races.pro.bestFlyingTicks &&
      races.pro.bestFlyingTicks < races.mid.bestFlyingTicks &&
      races.mid.bestFlyingTicks < races.novice.bestFlyingTicks],
    // ...and the other half of the deal: the clean line can no longer be
    // flat out, so the boost has something to buy back.
    ["the flat-out clean lap is dead: PRO brakes, and drops below 85% of top",
      proRec !== null && proRec.brakeTicks > 0 &&
      proRec.minSpeed < p.topSpeed * 0.85],
    // On-road margin gates: a "faster" tune that scrapes the grass edge is
    // fragile, not faster. PRO (clean, flat-out) must keep a wide margin;
    // PRO+ (drift lines run naturally wider) a real if smaller one.
    ["pro 3-lap race stays >= 8 px inside the road edge",
      proRec !== null && proMargin >= 8],
    ["proplus 3-lap race stays >= 3 px inside the road edge",
      ppRec !== null && ppMargin >= 3],
    // ---- upgrade scaling (bots race the player's upgraded spec) ----
    [`every reference bot still strings 3 valid laps at upgrade Lv ${SCALE_LEVELS.join("/")}`,
      SCALE_LEVELS.every(scaleValid)],
    [`tier ladder still holds at upgrade Lv ${SCALE_LEVELS.join("/")} (proplus < pro < mid < novice)`,
      SCALE_LEVELS.every(scaleLadder)],
    ["upgrades actually make every bot faster (they drive your car)", scaleFaster],
  ];
  console.log("\nAcceptance criteria:");
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) allPass = false;
  }
  console.log(allPass ? "\nALL CRITERIA PASS" : "\nSOME CRITERIA FAIL");
  return allPass;
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
  console.log(`Trackcrimental bot harness  (10 lap attempts per bot, seeded PRNG)`);
  console.log(`Telemetry scale: 10 px = 1 m; 1 g = ${G_PX.toFixed(1)} px/s^2`);

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
    runSuite(() => legacyParams(ZERO_LEVELS), "BASELINE: v0 (legacy) physics");
  }

  const results = runSuite(() => carParams(ZERO_LEVELS), "CURRENT physics");
  const ok = acceptance(results);
  process.exitCode = ok ? 0 : 1;
}

main();
