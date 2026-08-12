// physics.js — pure car physics. No DOM, no canvas, no globals:
// stepCar(state, inputs, params, dt) advances one fixed tick.
// Safe to import from Node for headless testing.
//
// Units: pixels and seconds. Assumed scale: 10 px = 1 m
// (so 280 px/s = 28 m/s ~ 100 km/h, 98.1 px/s^2 = 1 g).

export const TICK = 1 / 60;      // fixed physics timestep (s)
export const PX_PER_M = 10;      // px per meter (for telemetry g conversion)
export const G_PX = 9.81 * PX_PER_M; // 1 g in px/s^2

// Car parameters derived from upgrade levels ({speed, accel, grip, payout}).
// Pass ZERO_LEVELS for the stock car.
export const ZERO_LEVELS = { speed: 0, accel: 0, grip: 0, payout: 0 };

export function carParams(levels = ZERO_LEVELS) {
  const l = levels;
  return {
    topSpeed: 280 * (1 + 0.10 * l.speed),  // px/s
    // Deliberately modest low-end punch: 0 -> 90% of top speed takes ~2.7 s
    // (with rollDrag below), which makes the drift boost worth earning.
    accel:    150 * (1 + 0.12 * l.accel),  // px/s^2
    brake:    400 * (1 + 0.08 * l.accel),  // px/s^2
    reverseMax: 110,                       // px/s
    reverseDelay: 0.35,   // s of held brake at standstill before reverse engages

    // Steering. Yaw rate is limited by BOTH a low-speed cap (maxTurn) and a
    // lateral-acceleration budget (maxLatAccel / v) — so high speed means
    // gentler steering by construction, never twitchy.
    maxTurn:     1.85 + 0.10 * l.grip,     // rad/s cap at low speed
    maxLatAccel: 460 + 55 * l.grip,        // px/s^2 (~4.7 g stock: arcade/kart grip)
    lowSpeedRef: 60,                       // px/s: full steering authority above this

    // Steering input smoothing: ramp toward target at these rates (units of
    // full-lock per second). 7/s ~ 145 ms to full lock; return-to-center is
    // faster so releasing the key settles the car quickly.
    steerRampUp:   7,
    steerRampDown: 22,

    // Lateral grip: exponential decay rate of lateral velocity (1/s).
    // First-order (no overshoot) — releasing steering can never fishtail.
    latGrip: 11 + 1.0 * l.grip,

    // Handbrake drift.
    // A steady full-lock slide turns the CAR'S PATH at latGrip * driftGrip *
    // sin(driftSlipTarget) rad/s, independent of speed — with v2's 0.25/0.60
    // that was 1.55 rad/s against grip steering's 1.85 rad/s cap, i.e. a drift
    // could never out-turn a gripped car and could only ever cost lap time.
    // v3 raises both a notch (0.30/0.64 => 1.97 rad/s) so a slide genuinely
    // rotates tighter than grip. A drift's arc still bottoms out near 100 px,
    // so THE HAIRPIN (best line ~100 px) is only flick-able on the way in,
    // not slide-able all the way round — turn 1's 228 px sweeper is where the
    // charge is banked.
    driftGrip:     0.30,  // lateral grip multiplier while sliding
    driftYawBoost: 0.85,  // extra low-speed yaw authority while sliding
    driftLatScale: 2.0,   // lat-accel budget multiplier for drift rotation
    driftAttack:   14,    // 1/s: how fast grip drops when handbrake pressed
    driftRelease:  6,     // 1/s: how fast grip recovers on release (forgiving)
    // Slide-initiation tool, NOT a brake: holding the handbrake in a straight
    // line mostly coasts (the S-brake is for slowing down).
    driftDrag:     0.12,  // 1/s extra forward drag while handbrake held

    // Drift stabilizer (Mario-style assisted slides). While the handbrake is
    // held at speed, steering selects a TARGET DRIFT ARC instead of raw yaw:
    // a soft P-controller rotates the nose so the slip angle converges on
    // steer * driftSlipTarget. Slip beyond the band is pulled back, slip
    // below it (steering held) builds; releasing steer targets 0 slip and
    // straightens the slide gradually; countersteer actively tightens.
    // First-order (no overshoot) => a drift can never diverge into a spin.
    driftSlipTarget: 0.64, // rad (~37 deg) slip at full steering lock
    driftAssist:     7,    // 1/s P-gain of the slip controller

    // Mario-style drift boost: sustained handbrake slides bank a charge that
    // pays out as a speed burst on release. Two tiers, no penalty below tier 1.
    // A charge tick requires GENUINE cornering: handbrake + real slip + real
    // yaw + steering into the turn + real speed. Whenever any condition drops
    // the charge DECAYS (boostDecay) instead of holding, so straight-line
    // wiggles and brake-stops bleed charge away rather than banking tiers.
    boostSlipMin:  0.20,  // rad (~11.5 deg) slip needed for charge to build
    boostYawMin:   0.40,  // rad/s of yaw needed (genuine cornering, not a wiggle)
    boostSteerMin: 0.25,  // steering input needed, toward the turn
    boostSpeedFrac: 0.42, // charge only above this fraction of top speed
    boostFireSpeedFrac: 0.35, // release below this fraction of top speed = no boost
    boostDecay:    2.5,   // 1/s charge decay while conditions unmet (2.5x build)
    // Tier thresholds are shorter in v3 than v2's 0.6/1.4: the hairpin arc
    // only lasts ~1 s at drift speed, and tier 2 has to be bankable in the
    // corner whose exit it is meant to pay off.
    boostTier1:    0.55,  // s of qualifying drift for tier 1
    boostTier2:    1.05,  // s for tier 2
    // v3 payout buff. v2's +22%/+38% was worth ~0.1 s a lap on a track where
    // the clean line never lifted; v3's hairpin forces everyone down to ~76%
    // of top speed, and the boost is what buys that speed back — so tier 2 is
    // now a genuine event: half again your top speed, for the best part of two
    // seconds, arriving with a ~0.9 g shove.
    boostAmt1:     0.28,  // tier 1: +28% top speed...
    boostDur1:     1.1,   // ...for 1.1 s
    boostAmt2:     0.45,  // tier 2: +45% top speed...
    boostDur2:     1.7,   // ...for 1.7 s
    boostAccel:    880,   // px/s^2 shove toward the boosted cap while active
    boostBleed:    260,   // px/s^2 the leftover overspeed bleeds off afterwards

    // Drag and off-road (gentle: grass is slow, not a wall).
    rollDrag:    0.38,    // 1/s
    offRoadDrag: 1.4,     // 1/s extra while off-road
    offRoadCap:  0.73,    // top-speed fraction off-road
    offRoadAccelScale: 1, // no stacked accel penalty

    payoutMult: 1 + 0.3 * l.payout,

    // v0 physics emulation for before/after benchmarking (test harness only).
    legacy: false,
  };
}

// Legacy (v0) constants for baseline measurement in the test harness.
export function legacyParams(levels = ZERO_LEVELS) {
  const p = carParams(levels);
  p.legacy = true;
  p.accel = 300 * (1 + 0.12 * levels.accel);
  p.brake = 520 * (1 + 0.08 * levels.accel);
  p.rollDrag = 0.7;
  p.latGrip = 8 + 1.2 * levels.grip;
  p.maxTurn = 3.2 + 0.14 * levels.grip;
  p.steerRampUp = 120;    // effectively instant (digital input)
  p.steerRampDown = 120;
  p.offRoadDrag = 3.5;
  p.offRoadCap = 0.45;
  p.offRoadAccelScale = 0.35;
  return p;
}

export function createCarState(x, y, angle) {
  return {
    x, y, angle,
    vx: 0, vy: 0,
    steer: 0,      // smoothed steering value, -1..1
    grip: 1,       // drift blend: 1 = full grip, driftGrip = full slide
    yawRate: 0,    // rad/s, last tick (telemetry)
    drifting: false,
    // Brake/reverse gate: holding brake stops the car and HOLDS it stopped;
    // reverse engages only after reverseDelay of held brake at standstill,
    // or immediately if brake was released while stopped (re-press = reverse).
    stopHold: 0,          // s spent held at standstill by the brake
    reverseArmed: true,   // brake press from standstill reverses immediately
    // Drift boost.
    driftCharge: 0,       // s of qualifying (slipping, at-speed) handbrake drift
    boostTier: 0,         // 0 none, 1, 2 — charge tier banked / boost tier firing
    boostTime: 0,         // s of boost remaining
    boostAmt: 0,          // top-speed bonus fraction of the active boost
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// inputs: { throttle: 0..1, brake: 0..1, steer: -1..1 (target),
//           handbrake: bool, offRoad: bool }
// Mutates and returns `car`. Deterministic for a fixed dt.
export function stepCar(car, inputs, p, dt) {
  if (p.legacy) return stepCarLegacy(car, inputs, p, dt);

  // Forward/lateral speed along the OLD heading, for steering effectiveness
  // and the drift stabilizer.
  const ofX = Math.cos(car.angle), ofY = Math.sin(car.angle);
  const vfOld = car.vx * ofX + car.vy * ofY;
  const vlOld = -car.vx * ofY + car.vy * ofX;

  // ---- steering input smoothing ----
  const target = clamp(inputs.steer || 0, -1, 1);
  const returning = target * car.steer < 0 || Math.abs(target) < Math.abs(car.steer);
  const rate = returning ? p.steerRampDown : p.steerRampUp;
  car.steer += clamp(target - car.steer, -rate * dt, rate * dt);

  // ---- drift grip blend ----
  const gTarget = inputs.handbrake ? p.driftGrip : 1;
  const gRate = inputs.handbrake ? p.driftAttack : p.driftRelease;
  car.grip += clamp(gTarget - car.grip, -gRate * dt, gRate * dt);
  const driftAmt = clamp((1 - car.grip) / (1 - p.driftGrip), 0, 1);

  // ---- steering -> yaw rate (curvature-limited: gentle at speed) ----
  const sp = Math.max(Math.abs(vfOld), 1);
  const eff = clamp(vfOld / p.lowSpeedRef, -1, 1);  // signed: reversing steers reversed
  const gripLimit = Math.min(p.maxTurn, p.maxLatAccel / sp);
  const driftLimit = Math.min(p.maxTurn * (1 + p.driftYawBoost),
    (p.maxLatAccel * p.driftLatScale) / sp);
  const omegaGrip = car.steer * gripLimit * eff;

  // Drift stabilizer: while sliding at speed, steering picks a target slip
  // angle (a drift arc) and a soft P-controller yaws the nose toward it.
  // Slip sign convention: slip = atan2(vl, vf); steering right (+) drifts
  // with negative slip (nose inside the corner), hence the minus sign.
  // Blends in with driftAmt so non-drift handling is completely untouched.
  let omega = omegaGrip;
  const fwdFactor = clamp((vfOld - 40) / 60, 0, 1); // needs real forward speed
  const assist = driftAmt * fwdFactor;
  if (assist > 0) {
    const slipOld = Math.atan2(vlOld, Math.max(vfOld, 1));
    const slipTarget = -car.steer * p.driftSlipTarget;
    const omegaDrift = clamp(p.driftAssist * (slipOld - slipTarget),
      -driftLimit, driftLimit);
    omega = omegaGrip * (1 - assist) + omegaDrift * assist;
  }
  car.angle += omega * dt;
  car.yawRate = omega;

  // ---- decompose the UNCHANGED velocity along the NEW heading ----
  // Rotating the nose away from the velocity vector is what creates lateral
  // slip; lateral grip then bleeds it off (first-order: never oscillates).
  const fwdX = Math.cos(car.angle), fwdY = Math.sin(car.angle);
  let vf = car.vx * fwdX + car.vy * fwdY;
  let vl = -car.vx * fwdY + car.vy * fwdX;

  // ---- drift-boost charge / release ----
  // Charge builds only during GENUINE sustained cornering: handbrake held,
  // real slip, real yaw, steering applied into the turn, at real speed.
  // Any tick that fails a condition DECAYS the charge (2.5x build rate), so
  // straight-line "drifts", steering wiggles and handbrake stops bleed the
  // charge away instead of banking tiers. Release fires the banked tier —
  // but only while still moving reasonably fast (no boosts from a
  // near-standstill). Releasing below tier 1 is a no-op (never punishes).
  const slipSigned = Math.atan2(vl, Math.abs(vf) + 1e-6);
  const slipNow = Math.abs(slipSigned);
  const spNow = Math.hypot(vf, vl);   // total speed: deep slides still charge
  if (inputs.handbrake) {
    const qualifying =
      slipNow > p.boostSlipMin &&                    // genuinely sliding
      Math.abs(car.yawRate) > p.boostYawMin &&       // genuinely cornering
      Math.abs(car.steer) > p.boostSteerMin &&       // steering applied...
      car.steer * slipSigned < 0 &&                  // ...into the turn
      spNow > p.topSpeed * p.boostSpeedFrac &&       // at real speed
      vf > 0;                                        // and moving forward
    if (qualifying) car.driftCharge += dt;
    else car.driftCharge = Math.max(0, car.driftCharge - p.boostDecay * dt);
    if (car.boostTime <= 0) {
      car.boostTier = car.driftCharge >= p.boostTier2 ? 2
        : car.driftCharge >= p.boostTier1 ? 1 : 0;
    }
  } else {
    const fastEnough = spNow > p.topSpeed * p.boostFireSpeedFrac;
    if (car.driftCharge >= p.boostTier2 && fastEnough) {
      car.boostTime = p.boostDur2; car.boostAmt = p.boostAmt2; car.boostTier = 2;
    } else if (car.driftCharge >= p.boostTier1 && fastEnough) {
      car.boostTime = p.boostDur1; car.boostAmt = p.boostAmt1; car.boostTier = 1;
    } else if (car.boostTime <= 0) {
      car.boostTier = 0;
    }
    car.driftCharge = 0;
  }

  // ---- throttle / brake / reverse (+ boost shove) ----
  // Throttle and boost never push past the current cap; overspeed left over
  // when a boost expires bleeds off further down (never snaps).
  const accelScale = inputs.offRoad ? p.offRoadAccelScale : 1;
  const cap = p.topSpeed * (1 + (car.boostTime > 0 ? car.boostAmt : 0)) *
    (inputs.offRoad ? p.offRoadCap : 1);
  if (vf < cap) vf = Math.min(cap, vf + (inputs.throttle || 0) * p.accel * accelScale * dt);
  if (car.boostTime > 0) {
    if (vf < cap) vf = Math.min(cap, vf + p.boostAccel * dt);
    car.boostTime -= dt;
    if (car.boostTime <= 0) { car.boostTime = 0; car.boostAmt = 0; }
  }

  const brk = inputs.brake || 0;
  if (brk > 0) {
    if (vf > 5) {                                    // braking down from speed
      vf = Math.max(0, vf - p.brake * brk * dt);
      car.stopHold = 0;
      car.reverseArmed = false;
    } else if (vf < -5 || car.reverseArmed || car.stopHold >= p.reverseDelay) {
      // Reversing: already rolling back, brake re-pressed at standstill,
      // or brake held through the stop delay.
      vf = Math.max(vf - p.accel * 0.6 * brk * dt, -p.reverseMax);
    } else {
      vf = 0;                                        // held stopped by the brake
      car.stopHold += dt;
    }
  } else {
    car.stopHold = 0;
    if (vf > 5) car.reverseArmed = false;
    else if (Math.abs(vf) <= 5) car.reverseArmed = true;  // released at standstill
  }

  // ---- friction ----
  vl *= Math.exp(-p.latGrip * car.grip * dt);
  vf *= Math.exp(-p.rollDrag * dt);
  if (inputs.handbrake) vf *= Math.exp(-p.driftDrag * dt);
  if (inputs.offRoad) {
    vf *= Math.exp(-p.offRoadDrag * dt);
    vl *= Math.exp(-p.offRoadDrag * dt);
  }

  // ---- top speed cap (soft against post-boost overspeed) ----
  // The leftover overspeed when a boost expires bleeds off gently, so a
  // tier-2 run keeps paying for another half second after the timer ends.
  if (vf > cap) vf = Math.max(cap, vf - (p.boostBleed ?? 300) * dt);

  // ---- recompose and integrate ----
  car.vx = fwdX * vf - fwdY * vl;
  car.vy = fwdY * vf + fwdX * vl;
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  car.drifting = (inputs.handbrake && Math.abs(vf) > 40) || Math.abs(vl) > 65;
  return car;
}

// Faithful v0 step (instant digital steering, velocity recomposed along the
// rotated heading — i.e. on rails, no slip). Baseline for the test harness.
function stepCarLegacy(car, inputs, p, dt) {
  const fwdX = Math.cos(car.angle), fwdY = Math.sin(car.angle);
  let vf = car.vx * fwdX + car.vy * fwdY;
  let vl = -car.vx * fwdY + car.vy * fwdX;

  const accelScale = inputs.offRoad ? p.offRoadAccelScale : 1;
  vf += (inputs.throttle || 0) * p.accel * accelScale * dt;
  const brk = inputs.brake || 0;
  if (brk > 0) {
    if (vf > 5) vf -= p.brake * brk * dt;
    else vf = Math.max(vf - p.accel * 0.6 * brk * dt, -p.reverseMax);
  }

  car.steer = clamp(inputs.steer || 0, -1, 1);   // instant (digital keys)
  let omega = 0;
  if (car.steer !== 0) {
    const eff = clamp(vf / 130, -1, 1) / (1 + Math.abs(vf) / 700);
    omega = car.steer * p.maxTurn * eff;
    car.angle += omega * dt;
  }
  car.yawRate = omega;

  vl *= Math.exp(-p.latGrip * dt);
  vf *= Math.exp(-p.rollDrag * dt);
  if (inputs.offRoad) { vf *= Math.exp(-p.offRoadDrag * dt); vl *= Math.exp(-p.offRoadDrag * dt); }
  const cap = p.topSpeed * (inputs.offRoad ? p.offRoadCap : 1);
  if (vf > cap) vf = cap;

  const nfX = Math.cos(car.angle), nfY = Math.sin(car.angle);
  car.vx = nfX * vf - nfY * vl;
  car.vy = nfY * vf + nfX * vl;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.drifting = false;
  return car;
}

// Angle between heading and velocity direction (rad, 0..PI). Used by the
// harness to assert "never spins out"; also handy for slip-based effects.
export function slipAngle(car) {
  const sp = Math.hypot(car.vx, car.vy);
  if (sp < 1) return 0;
  const velAng = Math.atan2(car.vy, car.vx);
  let d = velAng - car.angle;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}
