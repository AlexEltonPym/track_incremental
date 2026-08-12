// track.js — pure track data + geometry queries + lap/gate logic.
// No DOM, no canvas: safe to import from Node for headless testing.

export const ROAD_HALF = 38;             // half road width (px) — wide: drift room

// Centerline control points, driven from the bottom straight heading east.
// Smoothed with Catmull-Rom.
//
// v3 layout — "the flat-out lap is dead". v2 was a wide, fast oval whose every
// corner could be taken at top speed with a corner-cutting line (a 76 px road
// lets a 180° corner of centerline radius R be driven at radius R + 38, and
// every v2 corner had R > 130), so the optimal clean lap never lifted and the
// drift boost was nearly worthless. v3 keeps the fast, flowing character but
// adds a corner that geometry cannot cheat:
//
//   - START STRAIGHT (E, y = 548) into TURN 1, the long ~180° SWEEPER up the
//     right side (R = 228): deliberately still flat-out — the signature
//     high-speed drift corner where a tier-2 charge is banked.
//   - TOP STRAIGHT (W) into the DESCENT ESS (two linked R = 150 arcs dropping
//     240 px): the perfect line is *just* flat out, so anything less than
//     perfect costs a lift. Great rotation zone for a drift.
//   - HAIRPIN APPROACH (W, y = 330) into THE HAIRPIN: a true 180° switchback
//     of centerline radius 62 px around (140, 392). Even the theoretical
//     outside-inside-outside line is capped at radius 62 + 38 = 100 px, i.e.
//     sqrt(maxLatAccel * 100) ~ 214 px/s = 76% of top speed. No line, no
//     bravery and no upgrade makes this corner flat: everyone brakes here.
//   - EXIT KINK back onto the start straight: a long, clean run for the
//     hairpin boost to pay off before the line.
//
// Tightening radii (not narrowing the road) was the deliberate choice: a
// narrow road punishes imprecision *everywhere* and would wreck the casual
// feel, while one genuinely slow corner on a still-76 px road only demands
// that you slow down — which is exactly the decision the drift boost exists
// to reward.
//
// Points are spaced 24-52 px apart (tighter where the radius is small) so the
// uniform-parametrisation Catmull-Rom reproduces the intended arcs to within
// ~1 px.
export const CONTROL = [
  // start / finish straight, eastward
  [460, 548], [512, 548], [564, 548], [616, 548],
  [668, 548], [720, 548], [772, 548],
  // turn 1: the long fast sweeper up the right side (R 228)
  [824, 542], [872, 524], [916, 495], [952, 458], [978, 413],
  [994, 364], [998, 312], [990, 261], [971, 212], [941, 170],
  [903, 135], [858, 110], [808, 95],
  // top straight, westward
  [756, 92], [704, 92],
  // the descent ess (two linked R 150 arcs, 240 px down)
  [652, 95], [604, 113], [564, 147], [539, 192], [523, 242],
  [494, 285], [452, 315], [402, 329],
  // hairpin approach, westward
  [350, 330], [298, 330], [246, 330], [194, 330], [142, 330],
  // THE HAIRPIN: 180° switchback, centerline radius 62
  [116, 335], [94, 351], [81, 374], [79, 401], [88, 426],
  [107, 445], [132, 454], [159, 455],
  // exit kink back onto the start straight
  [186, 458], [237, 471], [285, 492], [331, 519], [381, 537],
  [433, 547],
];

// Densify the closed control loop into a polyline for rendering + queries.
export function buildCenterline(pts, samplesPerSeg) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i];
    const p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return out;
}

export const CENTER = buildCenterline(CONTROL, 9);
export const N = CENTER.length;

// Cumulative arc length, for placing gates at fractions of the lap.
export const CUMLEN = [0];
for (let i = 1; i <= N; i++) {
  const a = CENTER[i - 1], b = CENTER[i % N];
  CUMLEN.push(CUMLEN[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
}
export const TRACK_LEN = CUMLEN[N];

export function indexAtFraction(f) {
  const target = f * TRACK_LEN;
  for (let i = 0; i < N; i++) if (CUMLEN[i + 1] >= target) return i;
  return 0;
}

// Index whose arc length is closest to `arc` (wraps around the lap).
export function indexAtArc(arc) {
  let a = ((arc % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
  // CUMLEN is monotonic: binary search.
  let lo = 0, hi = N;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (CUMLEN[mid + 1] >= a) hi = mid; else lo = mid + 1;
  }
  return lo % N;
}

// A gate is a segment across the road, plus the forward direction of travel.
export function makeGate(idx) {
  const p = CENTER[idx];
  const q = CENTER[(idx + 1) % N];
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len;       // forward (travel) direction
  const nx = -fy, ny = fx;                  // normal across the road
  const w = ROAD_HALF + 8;
  return {
    x: p[0], y: p[1], fx, fy,
    ax: p[0] + nx * w, ay: p[1] + ny * w,
    bx: p[0] - nx * w, by: p[1] - ny * w,
  };
}

export const START_GATE = makeGate(0);
// Gates sit on the sweeper apex, the middle of the descent ess, the hairpin
// apex and the exit kink, so no cut pays: skipping the infield misses the
// sweeper gate, and cutting straight across the hairpin's 48 px of infield
// grass (the switchback's two legs are only 124 px apart) misses its apex gate.
export const CHECKPOINTS = [0.27, 0.52, 0.775, 0.925].map(f => makeGate(indexAtFraction(f)));

// Named sections, as arc-length fractions of the lap. Used by the test
// harness to report WHERE a bot brakes / runs out of road.
export const SECTORS = [
  [0.000, 0.135, "the start straight"],
  [0.135, 0.445, "turn 1, the sweeper"],
  [0.445, 0.485, "the top straight"],
  [0.485, 0.662, "the descent ess"],
  [0.662, 0.769, "the hairpin approach"],
  [0.769, 0.853, "THE HAIRPIN"],
  [0.853, 1.001, "the exit kink"],
];
export function sectorAt(f) {
  const x = ((f % 1) + 1) % 1;
  const s = SECTORS.find(z => x >= z[0] && x < z[1]);
  return s ? s[2] : "?";
}

// Cheap identity for "this track". Bot races are simulated on demand and
// cached against (car spec + track), so the cache has to notice when the
// geometry changes — editing CONTROL, the road width or the sampling density
// all change this string.
export const TRACK_SIGNATURE = (() => {
  let h = 2166136261;
  for (const p of CONTROL) {
    for (const v of p) { h ^= Math.round(v); h = Math.imul(h, 16777619); }
  }
  return `t${(h >>> 0).toString(36)}:${N}:${ROAD_HALF}:${Math.round(TRACK_LEN)}`;
})();

export const START_POS = {
  x: START_GATE.x - START_GATE.fx * 40,
  y: START_GATE.y - START_GATE.fy * 40,
};
export const START_ANGLE = Math.atan2(START_GATE.fy, START_GATE.fx);

// Squared distance from a point to centerline segment i.
function segDist2(i, x, y) {
  const a = CENTER[i], b = CENTER[(i + 1) % N];
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const t = Math.max(0, Math.min(1,
    ((x - a[0]) * abx + (y - a[1]) * aby) / (abx * abx + aby * aby)));
  const dx = x - (a[0] + abx * t), dy = y - (a[1] + aby * t);
  return dx * dx + dy * dy;
}

// Broad-phase grid for distToTrack. Simulating four bots' 3-lap races on
// demand runs distToTrack tens of thousands of times, and a full 441-segment
// scan per call dominated the whole simulation — so each grid cell caches the
// segments that could possibly be nearest to a point inside it. Queries that
// land far from the track (deep in the grass, or outside the grid) fall back
// to the full scan, so the answer is always exactly the same.
const GRID_CELL = 32;
const GRID_REACH = 80;     // px of segments kept per cell; beyond this, rescan
const GRID = (() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of CENTER) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  minX -= GRID_REACH; minY -= GRID_REACH;
  const cols = Math.ceil((maxX + GRID_REACH - minX) / GRID_CELL);
  const rows = Math.ceil((maxY + GRID_REACH - minY) / GRID_CELL);
  const cells = new Array(cols * rows);
  const reach2 = (GRID_REACH + GRID_CELL) * (GRID_REACH + GRID_CELL);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = minX + (c + 0.5) * GRID_CELL, cy = minY + (r + 0.5) * GRID_CELL;
      const list = [];
      for (let i = 0; i < N; i++) if (segDist2(i, cx, cy) <= reach2) list.push(i);
      cells[r * cols + c] = list;
    }
  }
  return { minX, minY, cols, rows, cells };
})();

// Distance from a point to the nearest centerline segment (off-road test).
export function distToTrack(x, y) {
  const c = Math.floor((x - GRID.minX) / GRID_CELL);
  const r = Math.floor((y - GRID.minY) / GRID_CELL);
  if (c >= 0 && r >= 0 && c < GRID.cols && r < GRID.rows) {
    const list = GRID.cells[r * GRID.cols + c];
    let best = Infinity;
    for (let k = 0; k < list.length; k++) {
      const d = segDist2(list[k], x, y);
      if (d < best) best = d;
    }
    // Inside the cached reach the shortlist is provably complete.
    if (best <= GRID_REACH * GRID_REACH) return Math.sqrt(best);
  }
  let best = Infinity;
  for (let i = 0; i < N; i++) {
    const d = segDist2(i, x, y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export function isOffRoad(x, y) { return distToTrack(x, y) > ROAD_HALF; }

// Nearest centerline index searched only within `window` points of a hint
// index. Fast (O(window)) and correct as long as the query point moves
// continuously along the track (a car does). Returns the index.
export function nearestIndexNear(x, y, hint, window = 30) {
  let best = Infinity, bi = hint;
  for (let k = -window; k <= window; k++) {
    const i = ((hint + k) % N + N) % N;
    const dx = x - CENTER[i][0], dy = y - CENTER[i][1];
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}

// Full-scan nearest index (use when there is no hint).
export function nearestIndex(x, y) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < N; i++) {
    const dx = x - CENTER[i][0], dy = y - CENTER[i][1];
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}

// Unsigned Menger curvature (1/px) at a centerline index, using points
// `span` samples to either side (~span*6 px apart).
export function curvatureAt(idx, span = 4) {
  const a = CENTER[((idx - span) % N + N) % N];
  const b = CENTER[idx];
  const c = CENTER[(idx + span) % N];
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const denom = ab * bc * ca;
  return denom < 1e-9 ? 0 : (2 * area2) / denom;
}

// Does segment p1->p2 cross segment p3->p4?
export function segCross(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Crossed the gate in the direction of travel this tick?
export function crossedGate(gate, px, py, x, y) {
  if (!segCross(px, py, x, y, gate.ax, gate.ay, gate.bx, gate.by)) return false;
  return (x - px) * gate.fx + (y - py) * gate.fy > 0;
}

// ---- lap tracking (shared by game + bot harness) ----

export function createLap() {
  return { active: false, ticks: 0, nextCp: 0 };
}

// Advance lap state one tick given the car's previous and current position.
// Mutates `lap`. Returns { finished, started } where `finished` is
// { ticks, valid } when a start-line crossing ended an active lap
// (valid = all checkpoints hit in order), and `started` is true when a new
// lap timing run began this tick.
export function advanceLap(lap, px, py, x, y) {
  const ev = { finished: null, started: false };
  if (lap.active) {
    lap.ticks++;
    const cp = CHECKPOINTS[lap.nextCp];
    if (cp && crossedGate(cp, px, py, x, y)) lap.nextCp++;
  }
  if (crossedGate(START_GATE, px, py, x, y)) {
    if (lap.active) {
      ev.finished = { ticks: lap.ticks, valid: lap.nextCp === CHECKPOINTS.length };
    }
    lap.active = true;
    lap.ticks = 0;
    lap.nextCp = 0;
    ev.started = true;
  }
  return ev;
}
