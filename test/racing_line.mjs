// racing_line.mjs — EVALUATION of the offline racing-line follower prototype
// (racingline.mjs) against the shipped reactive bots (bots.js).
//
//   node test/racing_line.mjs
//
// For EMBER, LONGSHORE, LANTERN at the stock car (and one upgraded spec):
//   * builds the min-curvature racing line + friction-limited speed profile,
//     adaptively picks the fastest ON-ROAD line/safety by racing a small ladder
//     (mirrors bots.js's own raceBest), drives the follower for a few laps and
//     reports the best FLYING lap;
//   * validates on-road (max distToTrack over the flying laps <= ROAD_HALF);
//   * compares against the current bots (NOVICE/MID/PRO/PRO+/PRO++) via
//     bots.js's own simulateBotField;
//   * prints the racing line's min radius and apex width usage (proving it is a
//     real racing line, not the centerline), plus a centerline-follow baseline
//     so the geometric contribution is separated from the speed profile.
//
// Additive only: imports the shipped modules unchanged (same ?v=11 token).

import { TICK, carParams, ZERO_LEVELS } from "../physics.js?v=11";
import { simulateBotField, BOT_TIERS } from "../bots.js?v=11";
import * as T from "../track.js?v=11";
import {
  carLimits, computeRacingLine, speedProfile, runFollower, optimizeLine,
  CAR_HALF_W,
} from "../racingline.mjs";

const TRACKS = ["ember", "longshore", "lantern"];

const SPECS = [
  { name: "stock", levels: ZERO_LEVELS },
  { name: "upgraded", levels: { speed: 6, accel: 6, grip: 6, boostPwr: 0, boostDur: 0 } },
];

const fmt = (x, d = 3) => x === null || x === undefined ? "  -  " : x.toFixed(d);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function lineMetrics(line) {
  let minR = Infinity, maxOff = 0;
  for (let i = 0; i < line.N; i++) {
    if (line.kappa[i] > 1e-9) minR = Math.min(minR, 1 / line.kappa[i]);
    maxOff = Math.max(maxOff, Math.abs(line.offsets[i]));
  }
  return { minR, maxOff, widthUsePct: 100 * maxOff / line.w };
}

function centerlineFollowSec(trackId, levels) {
  // A "line" that IS the centerline (zero offsets): isolates how much of the
  // win comes from the speed profile + faithful tracking alone.
  T.setTrack(trackId);
  const limits = carLimits(levels);
  const line = computeRacingLine(trackId, levels, { method: "taut", iters: 0 });
  let best = null;
  for (const gs of [0.98, 0.94, 0.90, 0.86, 0.82]) {
    const prof = speedProfile(line, limits, { gripSafety: gs });
    const r = runFollower(trackId, levels, { line, prof, laps: 4 });
    if (r.valid && r.maxDistFlying <= T.ROAD_HALF &&
        (!best || r.bestFlyingTicks < best)) best = r.bestFlyingTicks;
  }
  return best ? best * TICK : null;
}

function botTimes(levels) {
  const params = carParams(levels);
  const field = simulateBotField(params, { laps: 3 });
  const byKey = {};
  for (const b of field) byKey[b.key] = b.bestFlyingTicks * TICK;
  return byKey;
}

console.log("=".repeat(80));
console.log("RACING-LINE FOLLOWER PROTOTYPE — evaluation vs shipped bots");
console.log("=".repeat(80));

for (const spec of SPECS) {
  const L = carLimits(spec.levels);
  console.log(`\ncar limits [${spec.name}]  topSpeed=${fmt(L.topSpeed, 1)} px/s  ` +
    `aLatMax=${fmt(L.aLatMax, 0)}  maxTurn=${fmt(L.maxTurn, 2)} rad/s  ` +
    `aAccel~${fmt(L.aAccel, 0)} (nom ${fmt(L.aAccelNominal, 0)})  ` +
    `aBrake~${fmt(L.aBrake, 0)} (nom ${fmt(L.aBrakeNominal, 0)}) px/s^2`);
}

const summary = [];

for (const spec of SPECS) {
  console.log("\n" + "#".repeat(80));
  console.log(`# SPEC: ${spec.name}  (${JSON.stringify(spec.levels)})`);
  console.log("#".repeat(80));

  for (const trackId of TRACKS) {
    T.setTrack(trackId);
    const roadHalf = T.ROAD_HALF;

    const opt = optimizeLine(trackId, spec.levels, { laps: 4 });
    const chosen = opt.chosen;
    const line = chosen.line;
    const r = chosen.res;
    const bots = botTimes(spec.levels);
    const baseSec = centerlineFollowSec(trackId, spec.levels);

    const m = lineMetrics(line);
    const rlSec = r.bestFlyingSec;

    console.log("\n" + "-".repeat(80));
    console.log(`TRACK: ${trackId.toUpperCase()}   ROAD_HALF=${roadHalf}px  ` +
      `usableHalfWidth(w)=${fmt(line.w, 1)}px = ROAD_HALF - CAR_HALF_W(${CAR_HALF_W}) - margin`);
    console.log("-".repeat(80));

    const method = chosen.lineOpt.method === "taut"
      ? `taut(iters=${chosen.lineOpt.iters})` : chosen.lineOpt.method;
    console.log(`  chosen line:  ${method}   grip safety = ${fmt(chosen.gripSafety, 2)}` +
      `${opt.onRoad ? "" : "   (NO on-road candidate; safest valid kept)"}`);
    console.log(`  line metrics: minRadius=${fmt(m.minR, 1)}px  ` +
      `maxApexOffset=${fmt(m.maxOff, 1)}px of ${fmt(line.w, 1)}px ` +
      `(${fmt(m.widthUsePct, 0)}% of usable width)  [centerline offset = 0]`);
    console.log(`  follower:     best FLYING lap = ${fmt(rlSec, 3)} s   ` +
      `standing lap = ${fmt(r.standingSec, 3)} s`);
    console.log(`  on-road:      maxDist over flying laps = ${fmt(r.maxDistFlying, 1)}px ` +
      `(<= ROAD_HALF ${roadHalf}) -> ${r.maxDistFlying <= roadHalf ? "ON ROAD" : "WIDE"}`);
    console.log(`  baseline:     centerline-follow (same profile, offsets=0) = ` +
      `${fmt(baseSec, 3)} s  ->  racing line saves ` +
      `${baseSec && rlSec ? fmt(baseSec - rlSec, 3) : "  -  "} s`);

    console.log("\n  vs shipped bots (best flying lap, seconds):");
    console.log("    " + pad("driver", 14) + padL("lap(s)", 9) + "   " + "delta");
    const rows = [["RACING-LINE", rlSec]];
    for (const tier of BOT_TIERS) rows.push([tier.label, bots[tier.key] ?? null]);
    for (const [name, sec] of rows) {
      const delta = (sec !== null && rlSec !== null && name !== "RACING-LINE")
        ? sec - rlSec : null;
      const deltaStr = delta === null ? "" :
        (delta >= 0 ? "+" : "") + delta.toFixed(3) + "s " +
        (delta > 0 ? "(RL faster)" : "(RL slower)");
      console.log("    " + pad(name, 14) + padL(fmt(sec, 3), 9) + "   " + deltaStr);
    }

    summary.push({
      spec: spec.name, track: trackId, rl: rlSec, base: baseSec,
      pro: bots.pro, proplus: bots.proplus, proplusplus: bots.proplusplus,
      safety: chosen.gripSafety, onRoad: r.maxDistFlying <= roadHalf,
      widthUsePct: m.widthUsePct, minR: m.minR,
    });
  }
}

console.log("\n" + "=".repeat(80));
console.log("SUMMARY  (RL = racing-line follower; delta > 0 => RL faster)");
console.log("=".repeat(80));
console.log(pad("spec", 9) + pad("track", 10) + padL("RL", 7) + padL("PRO", 7) +
  padL("d(PRO)", 8) + padL("PRO+", 7) + padL("PRO++", 7) + padL("d(PRO++)", 9) +
  padL("width%", 8) + padL("safety", 7) + padL("onRoad", 8));
for (const s of summary) {
  const dPro = (s.pro != null && s.rl != null) ? s.pro - s.rl : null;
  const dPP = (s.proplusplus != null && s.rl != null) ? s.proplusplus - s.rl : null;
  console.log(
    pad(s.spec, 9) + pad(s.track, 10) +
    padL(fmt(s.rl, 3), 7) + padL(fmt(s.pro, 3), 7) +
    padL(dPro == null ? "-" : (dPro >= 0 ? "+" : "") + dPro.toFixed(3), 8) +
    padL(fmt(s.proplus, 3), 7) + padL(fmt(s.proplusplus, 3), 7) +
    padL(dPP == null ? "-" : (dPP >= 0 ? "+" : "") + dPP.toFixed(3), 9) +
    padL(s.widthUsePct.toFixed(0) + "%", 8) +
    padL(fmt(s.safety, 2), 7) + padL(s.onRoad ? "yes" : "WIDE", 8));
}
console.log("");
