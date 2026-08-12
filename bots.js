// bots.js — the bot drivers: skill presets, the pure-pursuit + drift
// controller, automatic drift-zone derivation from track geometry, and the
// race/telemetry runners.
//
// This module is imported by BOTH the browser game (main.js simulates the
// four reference bots' full 3-lap races on demand, at the player's CURRENT
// car spec) and the headless acceptance harness (test/drive_bot.mjs). Same
// code, same physics, same track — so the bots the harness gates are exactly
// the bots you race. No DOM, no fetch: pure ES module, deterministic (seeded
// PRNG), safe to run in Node.
//
// There is no baked bot_ghosts.json any more: positions are simulated, never
// shipped, which is what lets the bots respond to upgrades and to new maps.

import { TICK, G_PX, createCarState, stepCar, slipAngle } from "./physics.js";
import * as T from "./track.js";

// ---------------------------------------------------------------- PRNG

// mulberry32 — small seeded PRNG so every run is reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- skills

export const SKILLS = {
  novice: {
    lookAheadBase: 45,    // px: short look-ahead
    lookAheadVel: 0.14,   // + s of current speed
    decisionTicks: 12,    // 200 ms between decisions (reaction delay)
    steerNoise: 0.16,     // uniform steering wobble per decision
    steerGain: 2.2,       // steering P-gain on heading error
    latBudget: 0.55,      // fraction of maxLatAccel used for corner speed
    throttleMax: 0.80,    // partial throttle (timid)
    brakeMargin: 2,       // px of early-braking margin (small = brakes late)
    keyboard: true,       // digital inputs: steer -1/0/1, throttle 0/1
    seed: 1001,
  },
  average: {
    lookAheadBase: 75,
    lookAheadVel: 0.24,
    decisionTicks: 5,     // ~83 ms
    steerNoise: 0.06,
    steerGain: 2.6,
    latBudget: 0.75,
    throttleMax: 0.95,
    brakeMargin: 15,
    keyboard: true,
    seed: 2002,
  },
  // Shipped in game as the purple "MID" ghost: a clean, competent line that
  // never drifts and never runs out of road. Retuned for the v3 hairpin —
  // v2's latBudget 0.85 / 28 px brake margin arrives far too fast and puts
  // it in the grass for 3% of the lap.
  expert: {
    lookAheadBase: 80,
    lookAheadVel: 0.22,
    decisionTicks: 1,     // near-zero reaction delay
    steerNoise: 0.004,
    steerGain: 2.6,
    latBudget: 0.6,
    throttleMax: 1.0,
    brakeMargin: 36,      // brakes early and tidily for the hairpin
    seed: 3003,
  },
  // "PRO": the optimal CLEAN lap — no handbrake, no boost, just the best
  // racing line a gripped car can drive. On the v2 track that lap was full
  // throttle from lights to flag; on v3 it is NOT, and cannot be: a full
  // sweep of 196 flat-out tunes (latBudget disabled, every look-ahead /
  // steerGain combination) finds none that stays on the road — the best is
  // still 31 px past the edge and ~1.7 s in the grass, all of it at the
  // hairpin. So PRO now runs a real corner-speed planner: latBudget 0.6 of
  // maxLatAccel with a 46 px early-braking margin, which brakes hard for the
  // hairpin and lifts slightly through the descent ess. Tuned by coordinate
  // descent under a >= 9 px on-road margin constraint (the harness asserts
  // >= 8 px, so a future tune cannot buy time by running the ragged edge).
  pro: {
    lookAheadBase: 75,
    lookAheadVel: 0.24,
    decisionTicks: 1,
    steerNoise: 0.0,      // clean: fully deterministic line
    steerGain: 9,         // tight tracking: saturates early, apexes hard
    latBudget: 0.6,       // fraction of grip used for corner entry speed
    throttleMax: 1.0,
    brakeMargin: 46,      // px of early braking: it brakes for the hairpin
    holdThrottle: 1.0,    // flat out once the corner speed is reached
    seed: 4004,
  },
  // "PRO+": the drift demon, and the demonstration that drifting is the fast
  // way round. Same pursuit controller as PRO, but it slides the corners the
  // corner analyser marks as drift zones, banks a boost charge through the
  // arc and fires it on exit — worth ~1.5 s a lap over PRO on the v3 circuit.
  // Strip the drift zones out of this exact tune and it is both a second
  // slower AND off the road: the drift is load-bearing, not decoration.
  //
  // `drift: "auto"` means the zones are DERIVED from track geometry and the
  // car's physics at bot-construction time (see deriveDriftZones) rather than
  // hand-listed for one circuit — so PRO+ keeps drifting the right corners on
  // a new map, and re-plans when the player's upgrades change the car.
  proplus: {
    lookAheadBase: 85,
    lookAheadVel: 0.215,
    decisionTicks: 1,
    steerNoise: 0.0,
    steerGain: 12.4,
    latBudget: 0.91,      // carries more corner speed than PRO...
    throttleMax: 1.0,
    brakeMargin: 6,       // ...and brakes later, which only works sideways
    holdThrottle: 1.0,
    drift: "auto",
    seed: 5005,
  },
};

// ------------------------------------------------- automatic corner analysis
//
// PRO+'s drift zones used to be four hand-tuned arc fractions for the v3
// circuit. That does not survive a new map, and it does not survive the
// player upgrading grip (which changes how tight a slide can be) — so the
// zones are now derived from track.js's curvature data plus physics.js's
// drift constants. Every threshold below is a dimensionless ratio or a
// physics quantity; none is an arc fraction of a particular circuit.
//
// The reasoning, corner by corner:
//   * A slide's PATH turn rate is speed-independent:
//         omegaDrift = latGrip * driftGrip * sin(driftSlipTarget)
//     (physics.js derives this), so a slide at speed v traces an arc of
//     radius v / omegaDrift. That single number decides which corners can be
//     slid at racing speed and which can only be flicked on entry.
//   * A FAST corner (one a gripped car takes at near top speed) is free
//     charging: slide it, bank a tier, spend the boost down the next stretch.
//     Worth doing only if the corner is long enough to bank a tier and the
//     exit is long enough to spend one.
//   * A SLOW corner (one that forces a big lift) is too tight to slide all
//     the way round, but a short part-throttle flick on entry rotates the car
//     and doubles as the entry-speed brake cue.
//   * Everything else — kinks, linked esses with no run-off — gets nothing.

// All of it lives in one object so it can be inspected (and swept, when
// re-validating on a new map) without touching the algorithm.
export const DRIFT_TUNING = {
  // Curvature sampling span (centerline points either side). ~6 px per point.
  curvSpan: 6,
  // A corner starts when the centerline radius drops below this many road
  // half-widths, and ends when it climbs back past cornerExitHyst times that.
  cornerRoads: 8,
  cornerExitHyst: 1.6,
  // How much of the road width the racing line is assumed to use to widen a
  // corner's effective radius (outside-inside-outside). Conservative.
  lineWiden: 0.6,
  // Corner speed (as a fraction of top speed) below which a corner counts as
  // SLOW — it forces a real lift, so it gets an entry flick, not a slide.
  slowCornerFrac: 0.8,
  // A fired boost is wasted if the track ahead forces the car below this
  // fraction of top speed. Looser than slowCornerFrac: a corner can be worth
  // a small lift and still be somewhere a boost pays.
  boostSpendFrac: 0.7,
  // An entry flick only makes sense in a corner that is TIGHT relative to the
  // road itself — a hairpin, not a fast kink. Measured in road half-widths,
  // so it does not drift as the car gets grippier and faster (which would
  // otherwise reclassify half the circuit as "slow" and flick everywhere).
  flickRoads: 3,
  // Headroom over the arc-holding steering angle a slide is allowed to use.
  // Without a ceiling the pursuit term saturates at full lock and the slide
  // traces a much tighter arc than the corner, cutting the inside edge — the
  // failure mode that used to appear the moment the car got any faster.
  slideSteerCeil: 1.35,
  // A slide zone needs a corner this many times longer than the arc it takes
  // to bank tier 1 — the charge does not start until the slide is established,
  // and a slide that occupies the WHOLE corner has no grip phase to set it up.
  chargeLenSafety: 1.7,
  // ...and the corner must be followed by this fraction of a tier-1 boost's
  // worth of track that is neither a slow corner NOR a turn the other way,
  // or the boost has nowhere to go. (The direction test is what stops the
  // analyser sliding one half of a linked ess straight into the other half.)
  exitRunSafety: 0.6,
  // Slide zone length, in tier-1 charge times (1.4 => bank tier 1 with margin
  // but stop well short of tier 2, which would need a much longer corner).
  zoneLenTiers: 1.4,
  // Where the slide sits in the corner's spare length: 0 = slide the entry,
  // 1 = slide the exit. Past the middle, so the entry is driven on grip and
  // there is still corner left to pull against when the boost fires.
  zonePlace: 0.75,
  // Slides run slower than the grip-limited entry speed (drift drag + the
  // lateral scrub), so plan on this fraction of it.
  slideSpeedSafety: 0.9,
  // An entry flick is a rotation aid, not a charging slide, so it is planned
  // right on the arc the slide can actually hold (rather than the deliberately
  // tight slideSpeedSafety): arriving too slow makes the flick over-rotate and
  // costs road on the way OUT of the corner.
  flickSpeedSafety: 1.0,
  // Entry-flick length, as a fraction of the corner it turns into. Fixing it
  // to the CORNER rather than to a duration is what keeps the flick the same
  // manoeuvre on a faster car: a timed flick gets longer as speed rises and
  // ends up rotating the car past the apex and off the exit.
  flickCornerFrac: 0.26,
  // Extra depth of steering in an entry flick over the charge-qualifying
  // slip: a flick is about rotation, so it steers deeper than a charge slide.
  flickSteerMargin: 1.7,
  // Where the flick starts: the point at which the corner reaches this
  // fraction of its peak curvature (i.e. where it really bites).
  flickBiteFrac: 0.5,
  // Part throttle through an entry flick: enough to keep the slide alive,
  // little enough to hold a tight arc.
  flickThrottle: 0.25,
  // Steering floor multiplier over the bare charge-qualifying slip angle: the
  // slide has to stay comfortably inside the charging band, not skim it.
  chargeSteerMargin: 1.6,
  // A flick is pointless if the corner is so tight that even a slide at the
  // boost-charging speed floor cannot follow it.
  minFlickSpeedFrac: 0.4,
};

// Signed Menger curvature at a centerline index: |k| with the sign of the
// turn (negative = left in screen coordinates). The sign becomes the zone's
// steering direction, so a mirrored map just flips it.
export function signedCurvatureAt(idx, span = DRIFT_TUNING.curvSpan) {
  const a = T.CENTER[((idx - span) % T.N + T.N) % T.N];
  const b = T.CENTER[idx];
  const c = T.CENTER[(idx + span) % T.N];
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const k = T.curvatureAt(idx, span);
  return cross < 0 ? -k : k;
}

// Every corner on the track, as {startIdx, endIdx, startArc, endArc, len,
// peakK, dir}. A corner is a maximal run of same-sign curvature above the
// entry threshold, extended outward with hysteresis so the gentle approach
// and exit of a long sweeper belong to it.
export function findCorners(tuning = DRIFT_TUNING) {
  const kEnter = 1 / (tuning.cornerRoads * T.ROAD_HALF);
  const kExit = kEnter / tuning.cornerExitHyst;
  const K = new Float64Array(T.N);
  for (let i = 0; i < T.N; i++) K[i] = signedCurvatureAt(i, tuning.curvSpan);
  const used = new Uint8Array(T.N);
  const corners = [];
  for (let i = 0; i < T.N; i++) {
    if (used[i] || Math.abs(K[i]) < kEnter) continue;
    const dir = K[i] < 0 ? -1 : 1;
    // Walk both ways while the turn keeps going the same way.
    let lo = i, hi = i;
    const same = j => (K[j] < 0 ? -1 : 1) === dir && Math.abs(K[j]) >= kExit;
    for (let n = 1; n < T.N; n++) {
      const j = ((i - n) % T.N + T.N) % T.N;
      if (!same(j) || used[j]) break;
      lo = j;
    }
    for (let n = 1; n < T.N; n++) {
      const j = (i + n) % T.N;
      if (!same(j) || used[j]) break;
      hi = j;
    }
    let peakK = 0;
    for (let j = lo; ; j = (j + 1) % T.N) {
      used[j] = 1;
      if (Math.abs(K[j]) > Math.abs(peakK)) peakK = K[j];
      if (j === hi) break;
    }
    let len = T.CUMLEN[hi] - T.CUMLEN[lo];
    if (len < 0) len += T.TRACK_LEN;
    corners.push({ startIdx: lo, endIdx: hi, startArc: T.CUMLEN[lo],
      endArc: T.CUMLEN[hi], len, peakK, dir, K });
  }
  return corners;
}

// Grip-limited speed through a corner of effective radius r.
function gripSpeed(r, budget) { return Math.sqrt(budget * r); }

// Derive PRO+-style drift zones for `params` (the car) and `skill` (which
// supplies the lateral budget the clean planner would use). Returns the same
// shape the controller used to get hand-written: { zones: [...], minSpeedFrac }.
export function deriveDriftZones(params, skill, tuning) {
  const t = tuning ? { ...DRIFT_TUNING, ...tuning } : DRIFT_TUNING;
  const budget = (skill.latBudget ?? 0.9) * params.maxLatAccel;
  // Speed-independent path yaw rate of a full-lock slide (see physics.js).
  const omegaDrift = params.latGrip * params.driftGrip *
    Math.sin(params.driftSlipTarget);
  const corners = findCorners(t);
  const rOf = k => 1 / Math.abs(k) + T.ROAD_HALF * t.lineWiden;

  // Per centerline index: would a fired boost be wasted here (the corner
  // forces a real lift), and which way does it turn? Both are needed to
  // measure how far a fired boost can actually run.
  const slowAt = new Uint8Array(T.N);
  const dirAt = new Int8Array(T.N);
  const kMin = 1 / (t.cornerRoads * T.ROAD_HALF);
  for (let i = 0; i < T.N; i++) {
    const k = signedCurvatureAt(i, t.curvSpan);
    if (Math.abs(k) < kMin) continue;
    dirAt[i] = k < 0 ? -1 : 1;
    if (gripSpeed(rOf(k), budget) < params.topSpeed * t.boostSpendFrac) slowAt[i] = 1;
  }

  const zones = [];
  for (const c of corners) {
    const rLine = rOf(c.peakK);
    const vGrip = gripSpeed(rLine, budget);
    const vSlide = omegaDrift * rLine;      // fastest slide that holds this arc

    if (vGrip >= params.topSpeed * t.slowCornerFrac) {
      // ---- FAST corner: a full slide, banked for the boost ----
      // Plan the slide at the speed it will actually run.
      const vZone = Math.min(params.topSpeed, vSlide) * t.slideSpeedSafety;
      if (vZone < params.topSpeed * params.boostSpeedFrac) continue;  // can't charge
      if (c.len < params.boostTier1 * vZone * t.chargeLenSafety) continue;
      // How much usable track follows before the next big lift or the next
      // turn the OTHER way? (Half of a linked ess fails here: the boost would
      // fire straight into a direction change.)
      let exitRun = 0;
      const wantRun = params.boostDur1 * params.topSpeed * t.exitRunSafety;
      for (let n = 1; n < T.N; n++) {
        const j = (c.endIdx + n) % T.N;
        if (slowAt[j] || dirAt[j] === -c.dir) break;
        exitRun += T.CUMLEN[j + 1] - T.CUMLEN[j];
        if (exitRun >= wantRun) break;
      }
      if (exitRun < wantRun) continue;                  // nowhere to spend it
      // WHERE in the corner to slide. Not the whole corner: the entry is
      // needed to set the slide up under grip, and releasing at the very exit
      // fires the boost as the car straightens out of the turn — which sends
      // it wide. So the slide sits `zonePlace` of the way through the corner's
      // spare length, leaving the rest of the corner ahead of the release for
      // the boost to pull against while the car is still turning.
      const zoneLen = Math.min(c.len, params.boostTier1 * vZone * t.zoneLenTiers);
      const startArc = c.startArc + (c.len - zoneLen) * t.zonePlace;
      const hold = slideSteer(params, vZone, rLine, t);
      zones.push({
        from: frac(startArc),
        to: frac(startArc + zoneLen),
        dir: c.dir,
        minSteer: hold,
        maxSteer: Math.min(1, hold * t.slideSteerCeil),
        why: "slide",
      });
    } else {
      // ---- SLOW corner: a short entry flick ----
      // Only for corners that are tight against the ROAD, not merely tight
      // against the current top speed — otherwise every corner on the map
      // becomes a flick as soon as the player buys some speed.
      if (rLine > t.flickRoads * T.ROAD_HALF) continue;
      if (vSlide < params.topSpeed * t.minFlickSpeedFrac) continue;
      // Never plan to arrive faster than the corner can be completed at:
      // the slide's own arc, the grip limit, and — the one that bites on an
      // upgraded car — the yaw-rate ceiling on this radius. maxTurn creeps up
      // with grip while top speed climbs linearly, so on a fast car a hairpin
      // is a STEERING-limited corner and entering it at the grip speed simply
      // runs out of road on the exit.
      const vEntry = Math.min(vSlide, vGrip, params.maxTurn * rLine) *
        t.flickSpeedSafety;
      // Start where the corner really bites (half its peak curvature), which
      // for a hairpin is well after the gentle turn-in.
      let biteIdx = c.startIdx;
      for (let n = 0; n < T.N; n++) {
        const j = (c.startIdx + n) % T.N;
        if (Math.abs(c.K[j]) >= Math.abs(c.peakK) * t.flickBiteFrac) { biteIdx = j; break; }
        if (j === c.endIdx) break;
      }
      const fromArc = T.CUMLEN[biteIdx];
      zones.push({
        from: frac(fromArc),
        to: frac(fromArc + c.len * t.flickCornerFrac),
        dir: c.dir,
        minSteer: flickSteer(params, t),
        entrySpeed: vEntry,
        throttle: t.flickThrottle,
        why: "flick",
      });
    }
  }
  zones.sort((a, b) => a.from - b.from);
  // Below this speed a slide can't charge at all (physics boostSpeedFrac):
  // bail out of the drift and drive normally instead.
  return { zones, minSpeedFrac: Math.max(0.3, params.boostSpeedFrac - 0.02) };
}

// Arc length -> lap fraction in [0, 1).
function frac(arc) { return ((arc / T.TRACK_LEN) % 1 + 1) % 1; }

// Steering floor for a full slide: enough to hold the corner's arc, and never
// less than the steering/slip the boost charge needs to keep qualifying.
function slideSteer(params, v, rLine, t) {
  const hold = Math.asin(Math.min(1, v / Math.max(1, rLine * params.latGrip *
    params.driftGrip))) / params.driftSlipTarget;
  const charge = Math.max(params.boostSteerMin,
    params.boostSlipMin / params.driftSlipTarget) * t.chargeSteerMargin;
  return Math.max(0.3, Math.min(1, Math.max(hold, charge)));
}

// Entry flicks are about rotation, not charge: steer deep.
function flickSteer(params, t) {
  return Math.max(0.6, Math.min(1, (params.boostSlipMin / params.driftSlipTarget) *
    t.chargeSteerMargin * t.flickSteerMargin));
}

// Chords cut inside corners: past ~140 px of look-ahead the aim point leaves
// the road (sqrt(8 * R_min * ROAD_HALF) for this class of circuit), so cap it
// for everyone. Deliberately NOT speed-scaled — see the aim-point comment in
// makeBot.
export const LOOKAHEAD_CAP = 140;

// ---------------------------------------------------------------- bot

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Skill tunes quote lookAheadBase / brakeMargin in px at the STOCK car's top
// speed. Braking distance and reaction distance both scale with speed, so
// those constants are scaled by the car's actual top speed — at the stock
// spec the scale is exactly 1 and behaviour is bit-identical to before.
const SPEED_REF = 280;
// Road half-widths a driver may cover between decisions before their own
// reaction delay, not the car, becomes the limit on pace. 1.5 leaves the
// stock car (280 px/s, 200 ms novice reaction => 285 px/s cap) untouched.
const REACTION_ROADS = 1.5;

export function makeBot(skill, params) {
  const rng = mulberry32(skill.seed);
  let held = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  let sinceDecision = Infinity;
  let trackIdx = 0;
  let first = true;
  // Drift plan: hand-written zones, or derived from the track geometry and
  // this exact car (so it re-plans when the player upgrades).
  const drift = skill.drift === "auto"
    ? deriveDriftZones(params, skill, skill.driftTuning)
    : skill.drift || null;
  const speedScale = params.topSpeed / SPEED_REF;
  // Braking margins are quoted in px at the stock spec, so they scale with
  // top speed — plus the distance the car covers while the STEERING actuator
  // is still winding on (steerRampUp is a fixed rate: at triple the speed a
  // corner arrives three times sooner but the lock still takes 143 ms to
  // build). The extra term is exactly zero at the stock spec.
  const tunedMargin = skill.brakeMargin * speedScale +
    Math.max(0, params.topSpeed - SPEED_REF) / params.steerRampUp;
  let prevCharge = 0;      // last tick's drift charge (release-timing cue)
  let inZone = null;       // drift zone currently occupied
  let zoneSpent = false;   // this zone's charge has been cashed in already

  return function decide(car) {
    const sp = Math.hypot(car.vx, car.vy);
    trackIdx = first
      ? T.nearestIndex(car.x, car.y)
      : T.nearestIndexNear(car.x, car.y, trackIdx, 30);
    first = false;

    sinceDecision++;
    if (sinceDecision < skill.decisionTicks) {
      prevCharge = car.driftCharge;
      return { inputs: held, trackIdx };
    }
    sinceDecision = 0;

    // ---- pure-pursuit steering toward a look-ahead point ----
    const arcHere = T.CUMLEN[trackIdx];
    const offRoadNow = T.distToTrack(car.x, car.y) > T.ROAD_HALF;
    // Aim-point distance, bounded by geometry rather than by speed. A
    // look-ahead of L across a corner of radius R aims a chord L^2/(8R) inside
    // the centerline, which has to stay on the road — that is where the flat
    // LOOKAHEAD_CAP comes from, and geoCap applies the same bound to the
    // radius the car is ACTUALLY in. Both stay fixed as the car gets faster
    // ON PURPOSE: stretching the aim point with speed makes a high-gain
    // pursuit bot cut corners and wander, which is worse than being myopic.
    const kHere = T.curvatureAt(trackIdx, 4);
    const geoCap = kHere > 1e-5
      ? Math.max(40, Math.sqrt(8 * (1 / kHere) * T.ROAD_HALF)) : Infinity;
    let look = Math.min(skill.lookAheadBase + sp * skill.lookAheadVel,
      LOOKAHEAD_CAP, geoCap);
    if (offRoadNow) look = 40;                     // recover: aim back at the road
    const tgtIdx = T.indexAtArc(arcHere + look);
    const tgt = T.CENTER[tgtIdx];
    const desired = Math.atan2(tgt[1] - car.y, tgt[0] - car.x);
    const err = wrapAngle(desired - car.angle);
    let steer = skill.steerGain * err;
    steer += (rng() * 2 - 1) * skill.steerNoise;   // per-decision wobble
    steer = Math.max(-1, Math.min(1, steer));

    // ---- corner-speed anticipation ----
    // Scan curvature ahead; each upcoming corner allows a speed *now* of
    // sqrt(vCorner^2 + 2*brake*d): brake if we exceed it.
    // The scan REACH is the car's own braking distance from its current speed
    // plus the reaction margin — an upgraded car doing 800 px/s needs to see
    // three times as far ahead as the stock one, or it arrives at the hairpin
    // still flat out. At the stock spec this evaluates to the fixed 300 px /
    // 12 px grid the tunes were calibrated on.
    // A driver cannot brake sooner than their next decision, so the margin is
    // never smaller than the distance covered during one reaction delay. For
    // the 1-tick-reaction bots (MID/PRO/PRO+) this is 5 px and never binds;
    // for the 200 ms keyboard NOVICE it is what stops it arriving at a corner
    // it decided about 170 px ago once the car gets fast.
    const budget = skill.latBudget * params.maxLatAccel;
    const brakeMargin = Math.max(tunedMargin, sp * skill.decisionTicks * TICK);
    const reach = Math.max(300,
      (sp * sp) / (2 * params.brake * 0.85) + brakeMargin + 80);
    // Keep the sampling grid fine enough to see a short corner: a fast car
    // needs a LONGER scan, not a coarser one.
    const step = Math.min(reach / 25, 12);
    // A driver cannot exploit more speed than their own reaction rate allows:
    // travelling further than ~1.5 road half-widths between decisions means
    // any line error is uncorrectable by the time it is noticed. This never
    // binds for the 1-tick bots; it is what keeps the 200 ms keyboard NOVICE
    // driveable (and appropriately slow) once the player's car gets quick.
    const paceCap = (T.ROAD_HALF * REACTION_ROADS) /
      Math.max(TICK, skill.decisionTicks * TICK);
    let vAllow = Math.min(params.topSpeed, paceCap);
    for (let d = 0; d <= reach; d += step) {
      const idx = T.indexAtArc(arcHere + d);
      const k = T.curvatureAt(idx, 4);
      if (k < 1e-4) continue;
      // Corner speed is limited by grip AND by the car's yaw-rate ceiling.
      // A pursuit bot tracks the CENTERLINE, so following curvature k at
      // speed v demands a yaw rate of v*k, which maxTurn caps: v <= maxTurn/k.
      // maxTurn only creeps up with the grip upgrade while top speed climbs
      // linearly, so on an upgraded car the tightest corners are
      // STEERING-limited, not grip-limited — ignoring that is what used to
      // send a fast car straight on at the hairpin however early it braked.
      const vCorner = Math.min(Math.sqrt(budget / k), params.maxTurn / k);
      const dEff = Math.max(0, d - brakeMargin);
      const allow = d === 0 ? vCorner
        : Math.sqrt(vCorner * vCorner + 2 * params.brake * 0.85 * dEff);
      if (allow < vAllow) vAllow = allow;
    }

    // Drift-zone entry speed: a slide's arc radius grows with speed, so a
    // drift bot brakes toward zone.entrySpeed before a zone the same way it
    // brakes for a corner — otherwise the early drift runs wide off-road.
    if (drift) {
      for (const z of drift.zones) {
        if (!z.entrySpeed) continue;
        let dz = z.from * T.TRACK_LEN - arcHere;
        if (dz < 0) dz += T.TRACK_LEN;
        if (dz > reach) continue;
        const dEff = Math.max(0, dz - brakeMargin);
        const allow = Math.sqrt(z.entrySpeed * z.entrySpeed +
          2 * params.brake * 0.85 * dEff);
        if (allow < vAllow) vAllow = allow;
      }
    }

    let throttle = 0, brake = 0;
    if (sp > vAllow + 10) brake = 1;
    else if (sp < vAllow - 6) throttle = skill.throttleMax;
    else throttle = skill.holdThrottle ?? 0.35;    // hold speed through corner

    // ---- handbrake drift zones (drift-capable bots only) ----
    // Inside a zone at speed: hold the handbrake and steer into the corner
    // with a floor of minSteer, so the physics' drift stabilizer holds a
    // slip arc and the boost charge qualifies every tick (needs |steer| >
    // boostSteerMin, slip > boostSlipMin, real yaw, real speed). Steering is
    // computed in the VELOCITY frame during the slide — the nose points
    // inside the corner, so heading-frame pursuit would prematurely unwind
    // the drift. Leaving the zone releases the handbrake at speed, which
    // fires the banked boost tier down the next stretch.
    let handbrake = false;
    if (drift && !offRoadNow) {
      const frac = arcHere / T.TRACK_LEN;
      // Zones may wrap past the start/finish line on a derived plan.
      const zone = drift.zones.find(z => z.to > z.from
        ? frac >= z.from && frac < z.to
        : frac >= z.from || frac < z.to);
      if (zone !== inZone) { inZone = zone; zoneSpent = false; }
      // Bail out of a slide the moment it stops paying. Once a tier is banked
      // and the charge has begun DECAYING (the corner has run out of
      // curvature, or the slide has rotated as far as the line needs), the
      // remaining handbrake ticks bleed the charge at 2.5x the build rate —
      // so releasing right here fires the boost at its best moment. This is
      // what makes derived zones safe: the analyser only has to pick a zone
      // that is long ENOUGH, and the driver finds the exact release point.
      if (zone && car.driftCharge >= params.boostTier1 &&
          car.driftCharge < prevCharge - 1e-9) {
        zoneSpent = true;
      }
      if (zone && !zoneSpent && sp > params.topSpeed * drift.minSpeedFrac) {
        const velAng = Math.atan2(car.vy, car.vx);
        const errV = wrapAngle(desired - velAng);
        // Steering inside a slide is bounded on BOTH sides: below minSteer
        // the slip angle stops qualifying for charge, above maxSteer the
        // slide traces a tighter arc than the corner and cuts the inside.
        const hi = zone.maxSteer ?? 1;
        let s = skill.steerGain * errV;
        s = zone.dir < 0
          ? Math.max(-hi, Math.min(-zone.minSteer, s))
          : Math.min(hi, Math.max(zone.minSteer, s));
        steer = s;
        // Power through the slide. A slide's arc radius grows with speed, so
        // the tightest corners need a part-throttle drift (zone.throttle) to
        // hold the arc instead of washing out to the outside.
        throttle = zone.throttle ?? 1;
        brake = 0;
        handbrake = true;
      }
    }

    // Keyboard players have no analog stick: full-lock or nothing.
    if (skill.keyboard) {
      steer = steer > 0.12 ? 1 : steer < -0.12 ? -1 : 0;
      throttle = throttle > 0.5 ? 1 : 0;
      brake = brake > 0.5 ? 1 : 0;
    }

    held = { throttle, brake, steer, handbrake };
    prevCharge = car.driftCharge;
    return { inputs: held, trackIdx };
  };
}

// ---------------------------------------------------------------- the race

// Record a full RACE: `opts.laps` (default 3) consecutive valid laps driven
// from a standing start. The bot begins parked at START_POS (the player's
// exact grid spot, ~40 px behind the start line) at zero velocity and drives
// without interruption until the race distance is done. Samples
// [x, y, angle] are recorded every physics tick FROM t=0 (at rest) for the
// WHOLE run, so sample[0] is the grid pose, the recording includes the
// accelerate-from-zero run-up, and laps 2..n are genuine FLYING laps (the
// car crosses the line already at speed) — which is exactly why they are
// faster than lap 1. This is what lets the in-game bot ghosts race the
// player over three laps from a fair dead-stop start.
//
// Returns null unless EVERY lap is valid (all checkpoints hit in order).
// On success:
//   lapTicks      [t1, t2, t3]  per-lap ticks. t1 = rest -> the crossing that
//                 completes lap 1 (so it includes the standing-start run-up);
//                 t2/t3 are line-to-line flying laps.
//   totalTicks    ticks from rest to the final line crossing (= sum lapTicks)
//   bestFlyingTicks / standingTicks   convenience scalars (min of laps 2..n /
//                 lapTicks[0])
//   samples       [x, y, angle] per tick, length totalTicks + 1
//   perLap        per-lap telemetry objects (same fields as the totals below)
//   handbrakeTicks, boostFires, maxTierFired, offRoadTicks, brakeTicks,
//   minSpeed, minSpeedFrac    run totals / extrema.
// The drift telemetry lets the exporter assert that a drift bot's shipped
// recording GENUINELY drifted and boosted (not just out-drove the clean
// bots); brakeTicks / minSpeed(Frac) let the harness assert that the clean
// line is NOT flat out, and name the corner that forces the lift.
export function recordRace(skill, params, opts = {}) {
  const laps = opts.laps ?? 3;
  const maxTicks = opts.maxTicks ?? 60 * 120 * laps;   // 2 min budget per lap
  const car = createCarState(T.START_POS.x, T.START_POS.y, T.START_ANGLE);
  const lap = T.createLap();
  const bot = makeBot(skill, params);
  const samples = [[car.x, car.y, car.angle]];     // t=0: parked on the grid
  const blank = () => ({ handbrakeTicks: 0, boostFires: 0, maxTierFired: 0,
    offRoadTicks: 0, brakeTicks: 0, minSpeed: Infinity, minSpeedFrac: 0 });
  const tot = blank();
  const perLap = [];
  let cur = blank();
  const lapTicks = [];
  let lastFinish = 0;
  let prevBoostTime = 0;
  for (let t = 1; t <= maxTicks; t++) {
    const { inputs, trackIdx } = bot(car);
    inputs.offRoad = T.distToTrack(car.x, car.y) > T.ROAD_HALF;
    if (inputs.handbrake) { tot.handbrakeTicks++; cur.handbrakeTicks++; }
    if (inputs.offRoad) { tot.offRoadTicks++; cur.offRoadTicks++; }
    if (inputs.brake > 0) { tot.brakeTicks++; cur.brakeTicks++; }
    // Slowest point of the lap, ignoring the launch (the standing start is
    // trivially the slowest part of lap 1).
    const sp = Math.hypot(car.vx, car.vy);
    if (lap.active && lap.ticks > 30) {
      const frac = T.CUMLEN[trackIdx] / T.TRACK_LEN;
      if (sp < cur.minSpeed) { cur.minSpeed = sp; cur.minSpeedFrac = frac; }
      if (sp < tot.minSpeed) { tot.minSpeed = sp; tot.minSpeedFrac = frac; }
    }
    const px = car.x, py = car.y;
    stepCar(car, inputs, params, TICK);
    if (prevBoostTime <= 0 && car.boostTime > 0) {
      tot.boostFires++; cur.boostFires++;
      if (car.boostTier > tot.maxTierFired) tot.maxTierFired = car.boostTier;
      if (car.boostTier > cur.maxTierFired) cur.maxTierFired = car.boostTier;
    }
    prevBoostTime = car.boostTime;
    samples.push([car.x, car.y, car.angle]);
    const ev = T.advanceLap(lap, px, py, car.x, car.y);
    if (ev.finished) {
      // Lap 1: the first line crossing (just after launch) started the lap
      // and this one finishes it, so lap 1 is measured from rest. Later laps
      // are line-to-line, i.e. flying.
      if (!ev.finished.valid) return null;          // a dirty lap voids the race
      lapTicks.push(t - lastFinish);
      lastFinish = t;
      perLap.push(cur);
      cur = blank();
      if (lapTicks.length >= laps) {
        const flying = lapTicks.slice(1);
        return {
          lapTicks, totalTicks: t, samples, perLap,
          standingTicks: lapTicks[0],
          bestFlyingTicks: flying.length ? Math.min(...flying) : lapTicks[0],
          ...tot,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- telemetry

// Run one bot for `opts.laps` lap attempts, gathering telemetry. With
// opts.record: true, also keeps the per-tick [x, y, angle] samples of the
// best valid lap (same format/cadence as the in-game ghost recorder) in
// m.bestLapSamples / m.bestLapTicks.
export function runBot(skillName, skill, params, opts = {}) {
  const lapsWanted = opts.laps ?? 10;
  const maxTicks = opts.maxTicks ?? 60 * 60 * 12;  // 12 min sim budget
  const car = createCarState(T.START_POS.x, T.START_POS.y, T.START_ANGLE);
  const lap = T.createLap();
  const bot = makeBot(skill, params);

  const m = {
    skill: skillName,
    attempts: 0, validLaps: 0, lapTicks: [],
    ticks: 0, offRoadTicks: 0, movingTicks: 0,
    steerReversals: 0, yawReversals: 0,
    sumYawAcc2: 0, yawAccTicks: 0,
    peakLatG: 0, sumLatG2: 0,
    sumTraction: 0, tractionTicks: 0,
    maxSlipDeg: 0, spinOut: false,
    handbrakeTicks: 0, boostFires: 0,
    bestLapSamples: null, bestLapTicks: null,
  };

  let lastSteerSign = 0;      // sign of last significant steering input
  let lastYawSign = 0;        // sign of last significant yaw rate
  let prevVf = 0, prevYaw = 0, prevBoostTime = 0;
  let lapRec = null;          // current-lap ghost samples (opts.record)

  while (m.attempts < lapsWanted && m.ticks < maxTicks) {
    const { inputs } = bot(car);
    inputs.offRoad = T.distToTrack(car.x, car.y) > T.ROAD_HALF;
    if (inputs.handbrake) m.handbrakeTicks++;

    const px = car.x, py = car.y;
    stepCar(car, inputs, params, TICK);
    if (prevBoostTime <= 0 && car.boostTime > 0) m.boostFires++;
    prevBoostTime = car.boostTime;
    m.ticks++;

    const sp = Math.hypot(car.vx, car.vy);
    const atSpeed = sp > 100;
    if (inputs.offRoad) m.offRoadTicks++;
    if (sp > 30) m.movingTicks++;

    // Steering-direction sign reversals (input wobble).
    const ss = inputs.steer > 0.06 ? 1 : inputs.steer < -0.06 ? -1 : 0;
    if (ss !== 0) {
      if (lastSteerSign !== 0 && ss !== lastSteerSign) m.steerReversals++;
      lastSteerSign = ss;
    }

    // Yaw-rate zero crossings at speed (dynamic wobble) + yaw jerkiness.
    if (atSpeed) {
      const ys = car.yawRate > 0.22 ? 1 : car.yawRate < -0.22 ? -1 : 0;
      if (ys !== 0) {
        if (lastYawSign !== 0 && ys !== lastYawSign) m.yawReversals++;
        lastYawSign = ys;
      }
      const yawAcc = (car.yawRate - prevYaw) / TICK;
      m.sumYawAcc2 += yawAcc * yawAcc;
      m.yawAccTicks++;
    }
    prevYaw = car.yawRate;

    // Lateral g + traction circle (a_lat = v * yaw_rate).
    const fwdX = Math.cos(car.angle), fwdY = Math.sin(car.angle);
    const vf = car.vx * fwdX + car.vy * fwdY;
    const aLat = vf * car.yawRate;                 // px/s^2
    const aLong = (vf - prevVf) / TICK;            // px/s^2 (incl. drag)
    prevVf = vf;
    const latG = Math.abs(aLat) / G_PX;
    if (atSpeed) {
      if (latG > m.peakLatG) m.peakLatG = latG;
      m.sumLatG2 += latG * latG;
      m.sumTraction += Math.hypot(aLat, aLong) / params.maxLatAccel;
      m.tractionTicks++;
    }

    // Spin-out check: heading vs velocity angle must stay < 90 deg.
    if (sp > 60 && !inputs.handbrake) {
      const slipDeg = slipAngle(car) * 180 / Math.PI;
      if (slipDeg > m.maxSlipDeg) m.maxSlipDeg = slipDeg;
      if (slipDeg >= 90) m.spinOut = true;
    }

    const ev = T.advanceLap(lap, px, py, car.x, car.y);
    if (ev.finished) {
      m.attempts++;
      if (ev.finished.valid) {
        m.validLaps++;
        m.lapTicks.push(ev.finished.ticks);
        if (opts.record && lapRec &&
            (m.bestLapTicks === null || ev.finished.ticks < m.bestLapTicks)) {
          m.bestLapTicks = ev.finished.ticks;
          m.bestLapSamples = lapRec.slice();
        }
      }
    }
    // Ghost recording, mirroring main.js exactly: the starting tick seeds the
    // recording, in-lap ticks append, the finishing tick belongs to the next
    // lap (so samples.length === lap ticks).
    if (opts.record) {
      if (ev.started) lapRec = [[car.x, car.y, car.angle]];
      else if (lap.active && lapRec) lapRec.push([car.x, car.y, car.angle]);
    }
  }

  const secs = m.ticks * TICK;
  const times = m.lapTicks.map(t => t * TICK);
  m.bestLap = times.length ? Math.min(...times) : null;
  m.meanLap = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  m.offRoadPct = 100 * m.offRoadTicks / m.ticks;
  m.steerRevPerS = m.steerReversals / secs;
  m.yawRevPerS = m.yawReversals / secs;
  m.wobble = m.steerRevPerS + m.yawRevPerS;
  m.rmsLatG = m.tractionTicks ? Math.sqrt(m.sumLatG2 / m.tractionTicks) : 0;
  m.rmsYawAcc = m.yawAccTicks ? Math.sqrt(m.sumYawAcc2 / m.yawAccTicks) : 0;
  m.traction = m.tractionTicks ? m.sumTraction / m.tractionTicks : 0;
  m.lapTimes = times;
  return m;
}

// --------------------------------------------------------- the reference field
//
// The four bot tiers the game races you against, and the on-demand simulation
// that produces them. This is what replaced bot_ghosts.json: instead of
// shipping positions baked offline against one car spec and one track, the
// game simulates each bot's whole 3-lap race at load — and again whenever the
// player's car or the track changes — and plays the resulting samples back.
//
// Cost is trivial (a few thousand pure physics ticks per bot, low tens of ms
// for the field) and it buys two things a baked file cannot: the bots drive
// the PLAYER'S CURRENT upgraded spec, so racing them stays about driving
// rather than about hardware, and their lap times are known up front for the
// HUD.

export const BOT_TIERS = [
  { key: "novice", skill: "novice", label: "NOVICE", short: "Nov",
    body: "#6fe08b", text: "rgba(111,224,139,0.75)" },
  { key: "mid", skill: "expert", label: "MID", short: "Mid",
    body: "#b48cff", text: "rgba(180,140,255,0.8)" },
  { key: "pro", skill: "pro", label: "PRO", short: "Pro",
    body: "#4fb8ff", text: "rgba(79,184,255,0.85)" },
  { key: "proplus", skill: "proplus", label: "PRO+", short: "Pro+",
    body: "#ffd23f", text: "rgba(255,210,63,0.85)" },
];

// Seed offsets tried in order. The first is the canonical harness seed, so a
// given (car spec, track, tier) always simulates to the same race; the rest
// are only reached if a preset cannot string three clean laps together on
// this spec, which keeps one bad tier from emptying the grid.
const SEED_FALLBACKS = [0, 101, 202, 303];

// Everything the simulation depends on, as a string. Params covers the
// upgrade levels (topSpeed, grip, brake, boost constants...); the track
// signature covers the geometry.
export function fieldSignature(params) {
  const keys = Object.keys(params).sort();
  return T.TRACK_SIGNATURE + "|" +
    keys.map(k => `${k}=${params[k]}`).join(",");
}

// Simulate every tier's 3-lap race on `params`. Returns an array of
// { ...tier, samples, lapTicks, bestFlyingTicks, standingTicks, totalTicks }
// plus a `simMs` on the array for reporting. Tiers that cannot produce three
// valid laps on this spec are simply absent (the grid shrinks, nothing
// breaks).
export function simulateBotField(params, opts = {}) {
  const laps = opts.laps ?? 3;
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();
  const field = [];
  for (const tier of BOT_TIERS) {
    const base = SKILLS[tier.skill];
    for (const off of SEED_FALLBACKS) {
      const rec = recordRace(off ? { ...base, seed: base.seed + off } : base,
        params, { laps });
      if (rec) { field.push({ ...tier, ...rec }); break; }
    }
  }
  field.simMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
  return field;
}

// Memoised wrapper: re-grids and repeated calls with an unchanged car and
// track reuse the simulation instead of redoing it. One slot is enough —
// the player's spec only moves forward.
let cachedKey = null, cachedField = null;
export function botField(params, opts = {}) {
  const key = fieldSignature(params) + "|laps=" + (opts.laps ?? 3);
  if (key !== cachedKey) {
    cachedField = simulateBotField(params, opts);
    cachedKey = key;
  } else {
    cachedField.simMs = 0;      // served from cache
  }
  return cachedField;
}
