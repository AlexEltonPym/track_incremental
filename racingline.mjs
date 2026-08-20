// racingline.mjs — EVALUATION PROTOTYPE (additive, ships nothing).
//
// A different bot-driving architecture from bots.js's reactive pure-pursuit on
// the CENTERLINE: here we compute, OFFLINE and per track,
//
//   1. a minimum-curvature RACING LINE that uses the width of the road
//      (hugs the inside of corners, opens the entry/exit),
//   2. a friction-limited SPEED PROFILE along that line from the car's real
//      limits (apex speed = sqrt(aLat/kappa), plus a backward braking pass and
//      a forward acceleration pass),
//
// and then drive physics.js's stepCar with a simple follower (pure-pursuit
// toward a lookahead point ON THE RACING LINE, throttle/brake toward the local
// target speed).
//
// It imports the SHIPPED physics.js and track.js unchanged (same ?v=11 token
// as everyone else, so it shares the single active-track module instance) and
// touches no game state. Nothing here is imported by main.js or the shipped
// harness.

import { TICK, SURFACE, carParams, createCarState, stepCar } from "./physics.js?v=11";
import * as T from "./track.js?v=11";

// The car's body half-width (matches bots.js CAR_HALF_W): the racing line must
// keep the CAR on the road, not merely its centre, so the usable half-width is
// the road half-width minus this minus a small margin.
export const CAR_HALF_W = 6;
const EDGE_MARGIN = 2;         // px extra keep-off from the road edge

// ------------------------------------------------------------- car limits
//
// Extract the limits the car ACTUALLY obeys from physics.js. carParams gives
// the nominal constants; we also MEASURE accel and braking empirically by
// stepping the car (throttle floor, brake from top speed) because the nominal
// `accel`/`brake` are pre-drag figures and the real net values are what decide
// where the profile has to brake.
export function carLimits(levels) {
  return carLimitsFor(carParams(levels));
}

// Same, but from an already-built params object (what bots.js / the game hold).
// The line is car-independent; the profile + follower are not, so the bot
// pipeline needs the limits straight from `params` without re-deriving them.
export function carLimitsFor(p) {
  const topSpeed = p.topSpeed;
  const aLatMax = p.maxLatAccel;     // px/s^2, the lateral (grip) budget
  const maxTurn = p.maxTurn;         // rad/s low-speed yaw ceiling

  // Measure net forward acceleration on road from a standing start: average
  // over the run up toward ~85% of top speed (where most corner exits live).
  const meas = measureAccelBrake(p);
  return {
    p, topSpeed, aLatMax, maxTurn,
    aAccel: meas.aAccel,             // net accel (px/s^2), drag included
    aBrake: meas.aBrake,             // net braking decel (px/s^2), drag included
    aAccelNominal: p.accel, aBrakeNominal: p.brake,
  };
}

function measureAccelBrake(p) {
  // Accel: floor throttle from rest, record time to cross speed gates.
  const car = createCarState(0, 0, 0);
  let tTo = null, prevSp = 0;
  const target = 0.85 * p.topSpeed;
  for (let i = 0; i < 60 * 30; i++) {
    stepCar(car, { throttle: 1, surface: 0 }, p, TICK);
    const sp = Math.hypot(car.vx, car.vy);
    if (tTo === null && sp >= target) { tTo = (i + 1) * TICK; break; }
    prevSp = sp;
  }
  // Average accel from 0 to target (secant): conservative vs the low-speed
  // punch, which is what we want for the forward pass out of slow corners.
  const aAccel = tTo ? target / tTo : p.accel;

  // Brake: from (near) top speed, full brake, average decel down to ~90 px/s.
  const car2 = createCarState(0, 0, 0);
  for (let i = 0; i < 60 * 40; i++) stepCar(car2, { throttle: 1, surface: 0 }, p, TICK);
  const vHi = Math.hypot(car2.vx, car2.vy);
  let tBr = null;
  for (let i = 0; i < 60 * 20; i++) {
    stepCar(car2, { throttle: 0, brake: 1, surface: 0 }, p, TICK);
    const sp = Math.hypot(car2.vx, car2.vy);
    if (sp <= 90) { tBr = (i + 1) * TICK; break; }
  }
  const aBrake = tBr ? (vHi - 90) / tBr : p.brake;
  return { aAccel, aBrake };
}

// ------------------------------------------------------------- geometry
//
// Unit normals along the active centerline (perpendicular to the local
// tangent, pointing to the +normal side (-ty, tx) — same convention as
// track.js's gates and curvature sign).
function centerlineNormals() {
  const C = T.CENTER, N = T.N;
  const nrm = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = C[(i - 1 + N) % N], b = C[(i + 1) % N];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    nrm[i] = [-dy / L, dx / L];
  }
  return nrm;
}

// Menger curvature (1/px, unsigned) of three points.
function menger(a, b, c) {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const denom = ab * bc * ca;
  if (denom < 1e-9) return 0;
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(2 * cross) / denom;
}

// ------------------------------------------------- minimum-curvature line
//
// Minimum-curvature racing line on the closed loop. Each point
// p_i = c_i + e_i * n_i with e_i in [-w, +w]; we minimise the TRUE curvature
// energy Σ_i κ_i^2 (κ = Menger curvature = 1/R, scale-correct) by coordinate
// descent: for each i, golden-section search e_i over [-w, w] to minimise the
// local contribution κ_{i-1}^2 + κ_i^2 + κ_{i+1}^2, holding the neighbours.
//
// Why the true curvature and NOT the raw second difference |p_{i-1}-2p_i+
// p_{i+1}|^2: on a densely, fixed-N sampled closed loop that raw objective is
// degenerate — it rewards the SHORTEST inner path (a point on a circle of
// radius R contributes R^2*(2π/N)^4, so shrinking R lowers it), so run to
// convergence it collapses the whole line onto the inside edge with jagged,
// higher real curvature. Dividing by ds^2 (which is what turns a second
// difference into an actual 1/R) removes that bias, so the minimiser is the
// genuine racing line: it hugs the inside at the apex (offsets hit the bound)
// and OPENS the corner radius above the centerline's, and the curvature
// actually drops. A cheap projected-Laplacian warm start gets it close first.
// The racing LINE depends only on the track geometry and the corridor width
// (ROAD_HALF - CAR_HALF_W - margin), NOT on the car — so it is cached per
// (track, solver opts). Only the speed profile + follower recompute per spec.
// This is what keeps re-grids and upgrade purchases cheap: buying an upgrade
// re-races the profile against the SAME cached line ladder.
const LINE_CACHE = new Map();

export function computeRacingLine(trackId, levels, opts = {}) {
  T.setTrack(trackId);
  const key = trackId + "|" + T.N + "|" + T.ROAD_HALF + "|" +
    (opts.method ?? "taut") + "|" + (opts.iters ?? 160) + "|" +
    (opts.taut ?? opts.relax ?? 0.35) + "|" + (opts.warm ?? 40);
  const hit = LINE_CACHE.get(key);
  if (hit) return hit;
  const C = T.CENTER, N = T.N, ROAD_HALF = T.ROAD_HALF;
  const nrm = centerlineNormals();
  const w = ROAD_HALF - CAR_HALF_W - EDGE_MARGIN;   // usable half-width (px)
  const warm = opts.warm ?? 40;                     // projected-Laplacian warm start
  const iters = opts.iters ?? 160;                  // coordinate-descent sweeps
  const relax = opts.relax ?? 0.35;

  const e = new Float64Array(N);          // offset along normal, per point
  const px = i => C[i][0] + e[i] * nrm[i][0];
  const py = i => C[i][1] + e[i] * nrm[i][1];

  // Two objectives are useful on THIS class of track (narrow corridor relative
  // to corner radius), selected by opts.method:
  //   "taut"    — projected-Laplacian / taut-string flow: each point moves to
  //               the projection of its neighbours' midpoint, clamped to the
  //               corridor. This pulls the line to the INSIDE of corners and
  //               uses the full width at the apex (the geometric racing line).
  //               `taut` in [0,1] blends toward it (1 = full pull per pass);
  //               a modest iteration count keeps it smooth.
  //   "mincurv" — global min-curvature QP (Σ κ_i^2 L_i), coordinate descent.
  //               Textbook, but on a narrow corridor it barely uses the width
  //               (the curvature integral is insensitive to small shifts), so
  //               it does NOT hit the apex bound. Kept for comparison.
  const method = opts.method ?? "taut";

  if (method === "taut") {
    const pull = opts.taut ?? relax;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < N; i++) {
        const ip = (i - 1 + N) % N, in_ = (i + 1) % N;
        const mx = 0.5 * (px(ip) + px(in_)), my = 0.5 * (py(ip) + py(in_));
        const eStar = (mx - C[i][0]) * nrm[i][0] + (my - C[i][1]) * nrm[i][1];
        let ne = e[i] + pull * (eStar - e[i]);
        if (ne > w) ne = w; else if (ne < -w) ne = -w;
        e[i] = ne;
      }
    }
    const out = materialise(C, N, ROAD_HALF, w, e, nrm, trackId);
    LINE_CACHE.set(key, out);
    return out;
  }

  // ---- warm start: a few projected-Laplacian passes (fast, gets the shape) ----
  for (let it = 0; it < warm; it++) {
    for (let i = 0; i < N; i++) {
      const ip = (i - 1 + N) % N, in_ = (i + 1) % N;
      const mx = 0.5 * (px(ip) + px(in_)), my = 0.5 * (py(ip) + py(in_));
      const eStar = (mx - C[i][0]) * nrm[i][0] + (my - C[i][1]) * nrm[i][1];
      let ne = e[i] + relax * (eStar - e[i]);
      if (ne > w) ne = w; else if (ne < -w) ne = -w;
      e[i] = ne;
    }
  }

  // ---- refine: global min-curvature QP via coordinate descent ----
  // Linearise the curvature at each point as an affine function of the offset
  // vector e (Braghin/Kapania min-curvature). With p_j = c_j + e_j n_j and the
  // second-difference along the normal,
  //   κ_i ≈ (a_i e_{i-1} - 2 e_i + g_i e_{i+1} + d_i) / L_i^2
  // where a_i = n_{i-1}·n_i, g_i = n_{i+1}·n_i, d_i = (c_{i-1}-2c_i+c_{i+1})·n_i
  // (the centerline curvature term) and L_i is the local sample spacing. We
  // minimise the arc-length-weighted energy Σ_i κ_i^2 L_i over -w ≤ e ≤ w by
  // projected gradient descent — a smooth global solve (unlike greedy per-point
  // descent, which sawtooths), giving the genuine racing line.
  const a = new Float64Array(N), g = new Float64Array(N);
  const d = new Float64Array(N), L2 = new Float64Array(N), Lw = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const im = (i - 1 + N) % N, ip = (i + 1) % N;
    a[i] = nrm[im][0] * nrm[i][0] + nrm[im][1] * nrm[i][1];
    g[i] = nrm[ip][0] * nrm[i][0] + nrm[ip][1] * nrm[i][1];
    d[i] = (C[im][0] - 2 * C[i][0] + C[ip][0]) * nrm[i][0] +
           (C[im][1] - 2 * C[i][1] + C[ip][1]) * nrm[i][1];
    const dl = 0.5 * (Math.hypot(C[i][0] - C[im][0], C[i][1] - C[im][1]) +
                      Math.hypot(C[ip][0] - C[i][0], C[ip][1] - C[i][1]));
    L2[i] = dl * dl; Lw[i] = dl;
  }
  // κ_i as a function of the current offsets (linearised).
  const kAt = i => {
    const im = (i - 1 + N) % N, ip = (i + 1) % N;
    return (a[i] * e[im] - 2 * e[i] + g[i] * e[ip] + d[i]) / L2[i];
  };
  // Coordinate descent on the convex quadratic F = Σ κ_i^2 L_i: for each j,
  // solve dF/de_j = 0 in closed form (e_j appears in κ_{j-1}, κ_j, κ_{j+1}),
  // then clamp to the corridor. Monotone and stable on every track.
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < N; j++) {
      const jm = (j - 1 + N) % N, jp = (j + 1) % N;
      // "rest" = each κ with e_j's own contribution removed.
      const restJ  = kAt(j)  - (-2 / L2[j]) * e[j];
      const restJp = kAt(jp) - (a[jp] / L2[jp]) * e[j];
      const restJm = kAt(jm) - (g[jm] / L2[jm]) * e[j];
      const cj = -2 / L2[j], cjp = a[jp] / L2[jp], cjm = g[jm] / L2[jm];
      // A e_j + B = 0, from dF/de_j = 0 with F = Σ κ_i^2 L_i (weight L_i).
      const A = cj * cj * Lw[j] + cjp * cjp * Lw[jp] + cjm * cjm * Lw[jm];
      const B = cj * restJ * Lw[j] + cjp * restJp * Lw[jp] + cjm * restJm * Lw[jm];
      let ne = A > 1e-12 ? -B / A : e[j];
      if (ne > w) ne = w; else if (ne < -w) ne = -w;
      e[j] = ne;
    }
  }

  return materialise(C, N, ROAD_HALF, w, e, nrm, trackId);
}

// Turn an offset array into the full line record (points, arc length,
// curvature). Shared by both solver methods.
function materialise(C, N, ROAD_HALF, w, e, nrm, trackId) {
  const points = new Array(N);
  for (let i = 0; i < N; i++) {
    points[i] = [C[i][0] + e[i] * nrm[i][0], C[i][1] + e[i] * nrm[i][1]];
  }
  const ds = new Float64Array(N);         // ds[i] = |p_i -> p_{i+1}|
  for (let i = 0; i < N; i++) {
    const a = points[i], b = points[(i + 1) % N];
    ds[i] = Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + ds[i];
  const length = cum[N];
  const kappa = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    kappa[i] = menger(points[(i - 1 + N) % N], points[i], points[(i + 1) % N]);
  }
  return { trackId, N, ROAD_HALF, w, points, offsets: e, ds, cum, length, kappa, nrm };
}

// ------------------------------------------------- friction-limited profile
//
// v_apex from grip AND the yaw-rate ceiling, then a backward braking pass and a
// forward acceleration pass around the closed loop. `gripSafety` scales aLatMax
// so the follower can actually hold the line (report the value used).
export function speedProfile(line, limits, opts = {}) {
  const N = line.N;
  const gripSafety = opts.gripSafety ?? 0.90;
  const turnSafety = opts.turnSafety ?? 0.95;
  const aLat = limits.aLatMax * gripSafety;
  const aBrake = limits.aBrake * (opts.brakeSafety ?? 0.95);
  const aAccel = limits.aAccel;
  const vMax = limits.topSpeed;
  const eps = 1e-6;

  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const k = Math.max(line.kappa[i], eps);
    const r = 1 / k;
    const vGrip = Math.sqrt(aLat * r);            // lateral-grip limit
    const vYaw = turnSafety * limits.maxTurn * r; // yaw-rate ceiling limit
    v[i] = Math.min(vMax, vGrip, vYaw);
  }

  // Backward pass (braking): loop the closed track a few times to converge.
  for (let pass = 0; pass < 3; pass++) {
    for (let s = 0; s < N; s++) {
      const i = (N - 1 - s + N) % N;          // walk backwards
      const j = (i + 1) % N;
      const cand = Math.sqrt(v[j] * v[j] + 2 * aBrake * line.ds[i]);
      if (cand < v[i]) v[i] = cand;
    }
  }
  // Forward pass (acceleration).
  for (let pass = 0; pass < 3; pass++) {
    for (let s = 0; s < N; s++) {
      const i = s % N;
      const h = (i - 1 + N) % N;
      const cand = Math.sqrt(v[h] * v[h] + 2 * aAccel * line.ds[h]);
      if (cand < v[i]) v[i] = cand;
    }
  }
  return { v, gripSafety, turnSafety, aLat, aBrake, aAccel, vMax };
}

// ------------------------------------------------- adaptive line selection
//
// The best amount of width to use is track- AND car-dependent (a fast open
// sweeper wants almost the whole road; a tight linked corner wants only about
// half, because riding the very inside makes the entry/exit transitions too
// sharp and actually SLOWER). Rather than bake a magic constant, mirror the
// shipped bots' own philosophy (raceBest): build a small ladder of candidate
// lines at increasing width usage plus a grip-safety sweep, RACE each with the
// follower, and keep the fastest one that stays on the road (max distToTrack
// over the flying laps <= ROAD_HALF). Deterministic.
export const LINE_LADDER = [
  { method: "mincurv" },
  { method: "taut", iters: 250, taut: 0.35 },
  { method: "taut", iters: 450, taut: 0.35 },
  { method: "taut", iters: 700, taut: 0.35 },
  { method: "taut", iters: 1100, taut: 0.35 },
];
export const SAFETY_LADDER = [0.98, 0.94, 0.90, 0.86, 0.82, 0.78];

export function optimizeLine(trackId, levels, opts = {}) {
  T.setTrack(trackId);
  const limits = opts.limits ?? carLimits(levels);
  const roadHalf = T.ROAD_HALF;
  const laps = opts.laps ?? 4;
  let onRoad = null, anyValid = null;
  const tried = [];
  for (const lineOpt of (opts.lineLadder ?? LINE_LADDER)) {
    const line = computeRacingLine(trackId, levels, lineOpt);
    for (const gripSafety of (opts.safetyLadder ?? SAFETY_LADDER)) {
      const prof = speedProfile(line, limits, { gripSafety, ...opts });
      const res = runFollower(trackId, levels, { line, prof, limits, laps });
      if (!res.valid) continue;
      const rec = { line, prof, lineOpt, gripSafety, res };
      tried.push(rec);
      if (!anyValid || res.bestFlyingTicks < anyValid.res.bestFlyingTicks) anyValid = rec;
      if (res.maxDistFlying <= roadHalf &&
          (!onRoad || res.bestFlyingTicks < onRoad.res.bestFlyingTicks)) onRoad = rec;
    }
  }
  const chosen = onRoad || anyValid;
  return { chosen, onRoad: !!onRoad, tried, limits };
}

// ------------------------------------------------------------- follower
//
// Drive stepCar to track the racing line at the profile speed. Deterministic,
// fixed 60 Hz. Pure-pursuit steering toward a lookahead point ON THE LINE
// (lookahead scales with speed); throttle if under the local target, brake if
// over. No handbrake, no boost — this tests the CLEAN racing line only.

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Point on the racing line at arc distance `arc` (wraps), by walking segments.
function pointAtArc(line, arc) {
  const L = line.length;
  let a = ((arc % L) + L) % L;
  // Binary search cum for the segment.
  let lo = 0, hi = line.N;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (line.cum[mid + 1] >= a) hi = mid; else lo = mid + 1;
  }
  const i = lo % line.N;
  const seg = line.ds[i] || 1;
  const t = Math.max(0, Math.min(1, (a - line.cum[i]) / seg));
  const p0 = line.points[i], p1 = line.points[(i + 1) % line.N];
  return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
}

// Nearest line index within a window of a hint (car moves continuously).
function nearestLineIdx(line, x, y, hint, window = 40) {
  let best = Infinity, bi = hint;
  for (let k = -window; k <= window; k++) {
    const i = ((hint + k) % line.N + line.N) % line.N;
    const dx = x - line.points[i][0], dy = y - line.points[i][1];
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}

// Pure-pursuit steering command as a fraction of the yaw rate the car can
// currently deliver, times an aggression multiplier. Mirrors bots.js's law so
// the racing-line follower and the reactive bots steer to the same physics.
function pursuitSteer(err, sp, look, p, aggr = 1) {
  const v = Math.max(sp, 90);
  const omegaWant = 2 * v * Math.sin(Math.max(-1.4, Math.min(1.4, err))) /
    Math.max(30, look);
  const omegaCan = Math.min(p.maxTurn, p.maxLatAccel / v);
  return (aggr * omegaWant) / omegaCan;
}

export function makeFollower(line, prof, limits, opts = {}) {
  const lookBase = opts.lookBase ?? 34;
  const lookVel = opts.lookVel ?? 0.16;
  const lookMin = opts.lookMin ?? 26;
  const lookMax = opts.lookMax ?? 120;
  const steerGain = opts.steerGain ?? 1.15;
  const p = limits.p;
  // Optional DRIFT overlay (ACE): a { zones, minSpeed } plan derived by bots.js
  // (deriveDriftZones) over the SAME geometry. The clean follower (LINE) passes
  // no drift, so its behaviour is bit-identical to the prototype.
  const drift = opts.drift || null;
  let idx = 0, first = true;
  let cHint = 0;                 // centerline index hint (for zone lookup)
  let prevCharge = 0;            // last tick's drift charge (release-timing cue)
  let inZone = null;             // drift zone currently occupied
  let zoneSpent = false;         // this zone's charge has been cashed in

  return function decide(car) {
    const sp = Math.hypot(car.vx, car.vy);
    idx = first ? nearestLineIdx(line, car.x, car.y, 0, line.N >> 1)
                : nearestLineIdx(line, car.x, car.y, idx, 40);
    cHint = first ? T.nearestIndex(car.x, car.y)
                  : T.nearestIndexNear(car.x, car.y, cHint, 40);
    first = false;

    // ---- steering: pure pursuit toward a lookahead point ON THE LINE ----
    let look = lookBase + sp * lookVel;
    if (look < lookMin) look = lookMin; else if (look > lookMax) look = lookMax;
    const aim = pointAtArc(line, line.cum[idx] + look);
    const desired = Math.atan2(aim[1] - car.y, aim[0] - car.x);
    const err = wrapAngle(desired - car.angle);
    let steer = pursuitSteer(err, sp, look, p, steerGain);
    if (steer > 1) steer = 1; else if (steer < -1) steer = -1;

    // ---- speed: target the friction-limited profile, braking ahead ----
    // Reconstruct the safe speed over a short reach so the follower brakes in
    // time even between profile samples: min over d of sqrt(v_prof^2 + 2 a d).
    const reach = (sp * sp) / (2 * prof.aBrake) + 40;
    let vTarget = prof.v[idx];
    let d = 0, k = idx;
    while (d <= reach) {
      const cand = Math.sqrt(prof.v[k] * prof.v[k] + 2 * prof.aBrake * d);
      if (cand < vTarget) vTarget = cand;
      d += line.ds[k];
      k = (k + 1) % line.N;
    }
    // Is a corner (not just the top-speed cap) limiting us right now? If not and
    // a boost is lit, ride it: braking against your own burst throws it away
    // (physics.js cancels the shove under braking), which is the same trap the
    // reactive bots avoid. Corner limits still bite — a boosting car still slows
    // for the next corner.
    const cornerLimited = vTarget < prof.vMax * 0.985;
    if (car.boostTime > 0 && !cornerLimited) {
      vTarget = Math.max(vTarget, p.topSpeed * (1 + car.boostAmt));
    }

    // Drift zones also set a braking target: a slide holds its arc at ONE speed,
    // so arriving too fast washes it wide. Brake toward the nearest upcoming
    // zone's entrySpeed just as for a corner.
    const cArc = T.CUMLEN[cHint];
    if (drift) {
      for (const z of drift.zones) {
        if (!z.entrySpeed) continue;
        let dz = z.from * T.TRACK_LEN - cArc;
        if (dz < 0) dz += T.TRACK_LEN;
        if (dz > reach) continue;
        const cand = Math.sqrt(z.entrySpeed * z.entrySpeed + 2 * prof.aBrake * dz);
        if (cand < vTarget) vTarget = cand;
      }
    }

    let throttle = 0, brake = 0;
    const dv = vTarget - sp;
    if (dv < -6) brake = Math.min(1, (-dv - 6) / 20);
    else if (dv > 6) throttle = 1;
    else throttle = Math.max(0, Math.min(1, 0.4 + dv / 12));

    // ---- handbrake drift zones (ACE only) ----
    // Inside a zone at speed: hold the handbrake and steer into the corner in
    // the VELOCITY frame so the drift stabilizer banks a boost charge; release
    // at the zone end (or the moment the tier is banked) to fire the burst down
    // the following straight. This is the reactive drift controller's logic,
    // applied to the racing line instead of the centerline.
    let handbrake = false;
    const offRoad = T.surfaceAt(car.x, car.y) !== SURFACE.ROAD;
    if (drift && !offRoad) {
      const frac = ((cArc / T.TRACK_LEN) % 1 + 1) % 1;
      const zone = drift.zones.find(z => z.to > z.from
        ? frac >= z.from && frac < z.to
        : frac >= z.from || frac < z.to);
      if (zone !== inZone) { inZone = zone; zoneSpent = false; }
      if (zone && zone.targetCharge && car.driftCharge >= zone.targetCharge) zoneSpent = true;
      if (zone && car.driftCharge >= p.boostTier1 &&
          car.driftCharge < prevCharge - 1e-9) zoneSpent = true;
      if (zone && !zoneSpent && sp > (drift.minSpeed ?? p.boostSpeedMin)) {
        const velAng = Math.atan2(car.vy, car.vx);
        const errV = wrapAngle(desired - velAng);
        const hi = zone.maxSteer ?? 1;
        let s = pursuitSteer(errV, sp, look, p, steerGain);
        s = zone.dir < 0
          ? Math.max(-hi, Math.min(-zone.minSteer, s))
          : Math.min(hi, Math.max(zone.minSteer, s));
        steer = s;
        throttle = zone.throttle ?? (zone.entrySpeed
          ? Math.max(0, Math.min(1, (zone.entrySpeed * 1.02 - sp) / 12))
          : 1);
        brake = 0;
        handbrake = true;
      }
    }

    prevCharge = car.driftCharge;
    return { throttle, brake, steer, handbrake, idxLine: idx };
  };
}

// ------------------------------------------------------------- run a race
//
// Standing start from the pole, `laps` laps; returns per-lap ticks, the best
// FLYING lap, the max distToTrack over the flying laps (on-road validity), and
// the driven path (for the visual).
export function runFollower(trackId, levels, opts = {}) {
  T.setTrack(trackId);
  const limits = opts.limits ?? carLimits(levels);
  const line = opts.line ?? computeRacingLine(trackId, levels, opts);
  const prof = opts.prof ?? speedProfile(line, limits, opts);
  const follow = makeFollower(line, prof, limits, opts);

  const laps = opts.laps ?? 4;
  const maxTicks = opts.maxTicks ?? 60 * 120 * laps;
  // Standing start from `opts.start` (an F1 grid slot) if given, else the pole,
  // exactly like bots.js recordRace — so the racing-line bots grid up and their
  // launch spreads the field the same way.
  const start = opts.start || T.START_POS;
  const car = createCarState(start.x, start.y, start.angle ?? T.START_ANGLE);
  const lap = T.createLap();

  const path = [[car.x, car.y, car.angle]];   // sample[0] = the grid pose
  const lapTicks = [];
  let lastFinish = 0;
  let maxDistFlying = 0, maxDistAll = 0;
  let lapMaxDist = 0;
  const lapMaxDists = [];
  // Drift/off-road telemetry, so a racing-line recording is a drop-in for a
  // reactive-bot recording (raceBest / the game / the harness all read these).
  let boostFires = 0, maxTierFired = 0, prevBoostTime = 0;
  let handbrakeTicks = 0, offRoadTicks = 0, grassTicks = 0, brakeTicks = 0;

  for (let t = 1; t <= maxTicks; t++) {
    const inp = follow(car);
    const pr = T.probeTrack(car.x, car.y);
    inp.surface = pr.surface;
    if (pr.dist > maxDistAll) maxDistAll = pr.dist;
    if (lap.active) lapMaxDist = Math.max(lapMaxDist, pr.dist);
    if (inp.handbrake) handbrakeTicks++;
    if (inp.surface !== SURFACE.ROAD) offRoadTicks++;
    if (inp.surface === SURFACE.GRASS) grassTicks++;
    if (inp.brake > 0) brakeTicks++;

    const px = car.x, py = car.y;
    stepCar(car, inp, limits.p, TICK);
    if (prevBoostTime <= 0 && car.boostTime > 0) {
      boostFires++;
      if (car.boostTier > maxTierFired) maxTierFired = car.boostTier;
    }
    prevBoostTime = car.boostTime;
    path.push([car.x, car.y, car.angle]);

    const ev = T.advanceLap(lap, px, py, car.x, car.y);
    if (ev.finished) {
      if (!ev.finished.valid) return { valid: false, trackId, reason: "dirty lap",
        line, prof, limits, path };
      lapTicks.push(t - lastFinish);
      lastFinish = t;
      lapMaxDists.push(lapMaxDist);
      lapMaxDist = 0;
      if (lapTicks.length >= laps) break;
    }
    if (ev.started && lapTicks.length === 0) lapMaxDist = 0;
  }

  const flyingTicks = lapTicks.slice(1);           // laps 2..n are flying
  const flyingDists = lapMaxDists.slice(1);
  const bestFlyingTicks = flyingTicks.length ? Math.min(...flyingTicks) : null;
  maxDistFlying = flyingDists.length ? Math.max(...flyingDists) : maxDistAll;

  // Line metrics.
  let minR = Infinity, maxOff = 0;
  for (let i = 0; i < line.N; i++) {
    if (line.kappa[i] > 1e-9) minR = Math.min(minR, 1 / line.kappa[i]);
    maxOff = Math.max(maxOff, Math.abs(line.offsets[i]));
  }

  return {
    valid: lapTicks.length >= laps,
    trackId, levels, limits, line, prof, path,
    lapTicks, lapMaxDists,
    bestFlyingTicks,
    bestFlyingSec: bestFlyingTicks ? bestFlyingTicks * TICK : null,
    standingSec: lapTicks.length ? lapTicks[0] * TICK : null,
    standingTicks: lapTicks.length ? lapTicks[0] : null,
    totalTicks: lastFinish,
    maxDistFlying, maxDistAll, maxDist: maxDistAll,
    boostFires, maxTierFired, handbrakeTicks, offRoadTicks, grassTicks, brakeTicks,
    // A game/harness recording reads these names (see bots.js recordRace):
    samples: path,
    minRadius: minR, maxOffset: maxOff, usableHalfWidth: line.w,
  };
}

// ------------------------------------------------- visual export
//
// Everything a renderer needs to draw the racing line vs the centerline vs the
// driven path for a track.
export function getVisualData(trackId, levels, opts = {}) {
  // Use the adaptively-chosen best on-road line (same one the evaluation
  // reports), unless the caller passed an explicit line/prof.
  let line = opts.line, prof = opts.prof, res;
  if (!line || !prof) {
    const o = optimizeLine(trackId, levels, opts);
    line = o.chosen.line; prof = o.chosen.prof;
    res = o.chosen.res;
  } else {
    res = runFollower(trackId, levels, { line, prof, ...opts });
  }
  T.setTrack(trackId);
  return {
    trackId,
    roadHalf: T.ROAD_HALF,
    centerline: T.CENTER.map(p => [p[0], p[1]]),
    racingLine: line.points.map(p => [p[0], p[1]]),
    drivenPath: res.path.map(s => [s[0], s[1]]),
    speed: Array.from(prof.v),
    curvature: Array.from(line.kappa),
    offsets: Array.from(line.offsets),
    bestFlyingSec: res.bestFlyingSec,
  };
}
