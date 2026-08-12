// track.js — MULTI-TRACK module: track definitions + derived geometry +
// lap/gate logic. No DOM, no canvas: safe to import from Node for headless
// testing.
//
// ---------------------------------------------------------------- shape
//
// A track is DEFINED as a closed path of straights and arcs (the way a real
// circuit is described: "a 320 px straight, then a 165 degrees left of radius
// 180, then a 559 px straight..."). buildTrack() turns that definition into
// everything the game and the bots need: control points, a Catmull-Rom
// centerline, cumulative arc length, the start/finish gate and grid slot,
// checkpoint gates, named sectors, a broad-phase collision grid and a cache
// signature.
//
// ONE track is ACTIVE at a time. The module-level exports (CENTER, N,
// ROAD_HALF, CHECKPOINTS, START_GATE, TRACK_SIGNATURE, ...) are ES module LIVE
// BINDINGS onto the active track, so every importer — main.js, bots.js, the
// harness — sees the switch the instant setTrack() returns, with no plumbing
// and no per-call track argument. The functions (distToTrack, curvatureAt,
// nearestIndex, advanceLap, ...) delegate to the active track for the same
// reason. Switching tracks is O(1) after the first build (built tracks are
// cached), so the UI can flip between them freely.
//
// TRACK_SIGNATURE varies per track, which is what makes bots.js's memoised bot
// field re-simulate when you change circuit.

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- the tracks
//
// THREE CIRCUITS, each built so that a DIFFERENT upgrade is the dominant lever
// (test/drive_bot.mjs measures this per track and prints the table):
//
//   ember    — BOOST / DRIFT. Two long, open corners, each followed by a long
//              straight. Both are slideable at racing speed, so a drift charge
//              banked through the corner fires onto a straight where the extra
//              speed has hundreds of px to convert into lap time. (The v3
//              circuit's flaw was exactly this: its drift corner exited into
//              another corner, so extra boost speed was braked away again and
//              Boost Power bought nothing. Here turn 1 exits onto 559 px and
//              turn 3 onto 620 px.)
//   longshore— TOP SPEED. A stadium: two long straights, four wide 90 degrees
//              corners and one gentle kink. Little of the lap is grip-limited,
//              most of it is spent at whatever top speed you have bought.
//   lantern  — GRIP. A five-lobed coil: ten linked corners, none of them slow
//              enough to be a hairpin and none of them fast enough to be flat,
//              with 55-110 px of straight between them. Nothing but corner
//              speed matters here, and corner speed is grip.
//
// seg forms:  ["s", length, name?]                straight
//             ["a", radius, degrees, name?]       arc (deg > 0 = right/CW)
// `name` (when given) becomes a SECTOR, used by the harness to report where a
// bot brakes or runs wide.
export const TRACK_DEFS = [
  {
    id: "ember",
    name: "EMBER LOOP",
    short: "Ember",
    skill: "boost",
    skillLabel: "Boost / drift",
    roadHalf: 38,
    start: [480, 720], heading: 0,
    spacing: 30, samples: 6,
    // Checkpoints sit on the apex of both loops, half way down the boost
    // straight and in the kink, so no cut pays: the only shortcuts this shape
    // offers are across a loop's infield, and each one misses that loop's gate.
    checkpoints: [[1, 0.5], [2, 0.5], [3, 0.5], [5, 0.5]],
    // The kidney. Two 160 degrees loops of radius 150 — open enough to slide
    // at racing speed (a full-lock slide holds a 173 px arc at 253 px/s, which
    // is FASTER than the clean line's 248), long enough to bank a charge, and
    // each one exits onto hundreds of px of straight where the boost converts
    // into lap time instead of being braked away.
    segs: [
      ["s", 336, "the start straight"],
      ["a", 150, -160, "turn 1, the horseshoe"],
      ["s", 680, "the boost straight"],
      ["a", 150, -160, "turn 2, the launch loop"],
      ["s", 336, "the run home"],
      ["a", 220, -40, "the last kink"],
    ],
  },
  {
    id: "longshore",
    name: "LONGSHORE SPEEDWAY",
    short: "Longshore",
    skill: "speed",
    skillLabel: "Top speed",
    roadHalf: 38,
    start: [550, 850], heading: 0,
    spacing: 34, samples: 6,
    // A gate between each corner's two apexes: the only cut on a stadium is
    // straight across a corner's infield, and that misses the gate.
    checkpoints: [[2, 0.5], [6, 0.5], [10, 0.5], [14, 0.5]],
    // Every corner is a DOUBLE APEX: two 45 degrees arcs of radius 260 with a
    // 70 px link. Two things fall out of that, both deliberate:
    //   * radius 260 is fast enough that the clean line barely lifts (272 px/s
    //     against a stock top speed of 280), so buying Grip buys almost
    //     nothing here and buying Top Speed buys the whole lap;
    //   * each ARC is only 204 px long — far too short for a drift to bank a
    //     charge in (a tier-1 slide needs ~250 px at this speed, and that
    //     figure only grows as the car improves). So the corner analyser finds
    //     no drift zones at all on this circuit, at any spec. That is what
    //     keeps the speedway honest: the boost upgrades have nothing to buy,
    //     and — just as important — there is no upgrade level at which a drift
    //     plan silently appears or disappears and jolts the lap time.
    segs: [
      ["s", 340, "the main straight"],
      ["a", 260, -45, "turn 1"],
      ["s", 70],
      ["a", 260, -45],
      ["s", 220, "the east chute"],
      ["a", 260, -45, "turn 2"],
      ["s", 70],
      ["a", 260, -45],
      ["s", 560, "the back straight"],
      ["a", 260, -45, "turn 3"],
      ["s", 70],
      ["a", 260, -45],
      ["s", 220, "the west chute"],
      ["a", 260, -45, "turn 4"],
      ["s", 70],
      ["a", 260, -45],
      ["s", 220, "the run to the line"],
    ],
  },
  {
    id: "lantern",
    name: "LANTERN COIL",
    short: "Lantern",
    skill: "grip",
    skillLabel: "Grip / precision",
    // A wider road than the other two on purpose: ten corners in 2.3 km of
    // track is demanding enough without also making it narrow, and the
    // novice bot has to stay on it.
    roadHalf: 42,
    start: [293, 96], heading: 153.25,
    spacing: 26, samples: 6,
    // One gate on the apex of every lobe — cutting a lobe is the only
    // shortcut this shape offers, and each one misses its own gate.
    checkpoints: [[1, 0.5], [5, 0.5], [9, 0.5], [13, 0.5], [17, 0.5],
      [21, 0.5], [25, 0.5]],
    // The coil: seven left-handers of radius 108-140 (a clean line holds
    // ~184 px/s through them, 66% of the stock top speed — never slow enough
    // to be a hairpin, never fast enough to be flat), each separated from the
    // next by a right-handed kink and 64-91 px of straight. Nothing here is
    // long enough to accelerate down and nothing is long enough to bank a
    // drift charge in either (the tightest corner's 130 px arc is well under
    // the ~200 px a tier-1 slide needs, at every spec), so the lap is decided
    // by one thing only: how fast the car will go round a corner.
    segs: [
      ["s", 89, "the start chute"],
      ["a", 140, -54, "turn 1"],
      ["s", 77],
      ["a", 170, 9, "kink 1"],
      ["s", 78],
      ["a", 119, -63, "turn 2"],
      ["s", 70],
      ["a", 170, 15, "kink 2"],
      ["s", 73],
      ["a", 113, -67, "turn 3"],
      ["s", 73],
      ["a", 170, 14, "kink 3"],
      ["s", 74],
      ["a", 109, -69, "turn 4"],
      ["s", 67],
      ["a", 170, 19, "kink 4"],
      ["s", 64],
      ["a", 108, -69, "turn 5"],
      ["s", 67],
      ["a", 170, 18, "kink 5"],
      ["s", 73],
      ["a", 113, -67, "turn 6"],
      ["s", 78],
      ["a", 170, 10, "kink 6"],
      ["s", 76],
      ["a", 135, -56, "turn 7"],
      ["s", 91, "the run to the line"],
    ],
  },
];

// Metadata only, for the UI's track selector.
export const TRACKS = TRACK_DEFS.map(d => ({
  id: d.id, name: d.name, short: d.short, skill: d.skill, skillLabel: d.skillLabel,
}));

export const DEFAULT_TRACK = TRACK_DEFS[0].id;

// ------------------------------------------------------------- path -> points
//
// Walk the definition's straights and arcs, dropping a control point every
// ~`spacing` px (tighter inside small-radius arcs, so the uniform-parameter
// Catmull-Rom below reproduces the intended arc to within ~1 px). Also returns
// each segment's start as a FRACTION of the ideal path length, which is what
// places sectors and checkpoint gates.
function pathPoints(def) {
  const spacing = def.spacing ?? 30;
  let x = def.start[0], y = def.start[1], a = (def.heading ?? 0) * DEG;
  const control = [];
  const segFrom = [];       // ideal arc length at each segment's start
  let arc = 0;
  for (const seg of def.segs) {
    segFrom.push(arc);
    if (seg[0] === "s") {
      const len = seg[1];
      const n = Math.max(1, Math.round(len / spacing));
      for (let i = 0; i < n; i++) {
        control.push([x + Math.cos(a) * len * i / n, y + Math.sin(a) * len * i / n]);
      }
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      arc += len;
    } else {
      const r = seg[1], t = seg[2] * DEG, sign = Math.sign(t);
      const len = Math.abs(t) * r;
      const cx = x + r * sign * -Math.sin(a), cy = y + r * sign * Math.cos(a);
      const dx = x - cx, dy = y - cy;
      const step = Math.min(spacing, Math.max(11, r * 0.28));
      const n = Math.max(2, Math.round(len / step));
      for (let i = 0; i < n; i++) {
        const tt = t * i / n;
        control.push([cx + dx * Math.cos(tt) - dy * Math.sin(tt),
          cy + dx * Math.sin(tt) + dy * Math.cos(tt)]);
      }
      x = cx + dx * Math.cos(t) - dy * Math.sin(t);
      y = cy + dx * Math.sin(t) + dy * Math.cos(t);
      a += t;
      arc += len;
    }
  }
  return { control, segFrom, total: arc };
}

// Densify a closed control loop into a polyline for rendering + queries.
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

// ---------------------------------------------------------------- build
//
// Everything derived from one definition. Pure: two calls with the same
// definition produce identical data, and nothing here touches module state.
const GRID_CELL = 32;
const GRID_REACH = 80;     // px of segments kept per cell; beyond this, rescan

export function buildTrack(def) {
  const ROAD_HALF = def.roadHalf;
  const { control: CONTROL, segFrom, total } = pathPoints(def);
  const CENTER = buildCenterline(CONTROL, def.samples ?? 6);
  const N = CENTER.length;

  const CUMLEN = [0];
  for (let i = 1; i <= N; i++) {
    const a = CENTER[i - 1], b = CENTER[i % N];
    CUMLEN.push(CUMLEN[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const TRACK_LEN = CUMLEN[N];

  const indexAtFraction = f => {
    const target = (((f % 1) + 1) % 1) * TRACK_LEN;
    for (let i = 0; i < N; i++) if (CUMLEN[i + 1] >= target) return i;
    return 0;
  };
  // Index whose arc length is closest to `arc` (wraps around the lap).
  const indexAtArc = arc => {
    const a = ((arc % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
    let lo = 0, hi = N;                       // CUMLEN is monotonic
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (CUMLEN[mid + 1] >= a) hi = mid; else lo = mid + 1;
    }
    return lo % N;
  };

  // A gate is a segment across the road, plus the forward direction of travel.
  const makeGate = idx => {
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
  };

  // Segment i's span as lap fractions (the definition's ideal arc length and
  // the sampled centerline agree to well under a percent).
  const segSpan = i => {
    const from = segFrom[i] / total;
    const to = (i + 1 < segFrom.length ? segFrom[i + 1] : total) / total;
    return [from, to];
  };

  const START_GATE = makeGate(0);
  const CHECKPOINTS = def.checkpoints.map(([seg, f]) => {
    const [from, to] = segSpan(seg);
    return makeGate(indexAtFraction(from + (to - from) * f));
  });

  // Named sections, as arc-length fractions of the lap. Used by the harness to
  // report WHERE a bot brakes / runs out of road.
  const SECTORS = [];
  def.segs.forEach((seg, i) => {
    const name = seg[0] === "s" ? seg[2] : seg[3];
    if (!name) return;
    const [from] = segSpan(i);
    let to = 1.001;
    for (let j = i + 1; j < def.segs.length; j++) {
      const nm = def.segs[j][0] === "s" ? def.segs[j][2] : def.segs[j][3];
      if (nm) { to = segSpan(j)[0]; break; }
    }
    SECTORS.push([from, to, name]);
  });
  if (SECTORS.length) SECTORS[SECTORS.length - 1][1] = 1.001;
  const sectorAt = f => {
    const x = ((f % 1) + 1) % 1;
    const s = SECTORS.find(z => x >= z[0] && x < z[1]);
    return s ? s[2] : SECTORS.length ? SECTORS[0][2] : "?";
  };

  const START_POS = {
    x: START_GATE.x - START_GATE.fx * 40,
    y: START_GATE.y - START_GATE.fy * 40,
  };
  const START_ANGLE = Math.atan2(START_GATE.fy, START_GATE.fx);

  // Squared distance from a point to centerline segment i.
  const segDist2 = (i, x, y) => {
    const a = CENTER[i], b = CENTER[(i + 1) % N];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const t = Math.max(0, Math.min(1,
      ((x - a[0]) * abx + (y - a[1]) * aby) / (abx * abx + aby * aby)));
    const dx = x - (a[0] + abx * t), dy = y - (a[1] + aby * t);
    return dx * dx + dy * dy;
  };

  // Broad-phase grid for distToTrack. Simulating four bots' 3-lap races on
  // demand runs distToTrack tens of thousands of times, and a full scan of
  // every centerline segment per call dominated the whole simulation — so each
  // grid cell caches the segments that could possibly be nearest to a point
  // inside it. Queries far from the track (deep in the grass, or outside the
  // grid) fall back to the full scan, so the answer is always exactly the same.
  const GRID = (() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of CENTER) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const bounds = { minX, minY, maxX, maxY };
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
    return { minX, minY, cols, rows, cells, bounds };
  })();

  const distToTrack = (x, y) => {
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
  };

  // Nearest centerline index searched only within `window` points of a hint
  // index. Fast (O(window)) and correct as long as the query point moves
  // continuously along the track (a car does).
  const nearestIndexNear = (x, y, hint, window = 30) => {
    let best = Infinity, bi = hint;
    for (let k = -window; k <= window; k++) {
      const i = ((hint + k) % N + N) % N;
      const dx = x - CENTER[i][0], dy = y - CENTER[i][1];
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = i; }
    }
    return bi;
  };
  const nearestIndex = (x, y) => {
    let best = Infinity, bi = 0;
    for (let i = 0; i < N; i++) {
      const dx = x - CENTER[i][0], dy = y - CENTER[i][1];
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = i; }
    }
    return bi;
  };

  // Unsigned Menger curvature (1/px) at a centerline index, using points
  // `span` samples to either side.
  const curvatureAt = (idx, span = 4) => {
    const a = CENTER[((idx - span) % N + N) % N];
    const b = CENTER[idx];
    const c = CENTER[(idx + span) % N];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const denom = ab * bc * ca;
    return denom < 1e-9 ? 0 : (2 * area2) / denom;
  };

  // Cheap identity for "this track". Bot races are simulated on demand and
  // cached against (car spec + track), so the cache has to notice which track
  // it is looking at — editing a definition's geometry, its road width or its
  // sampling density all change this string.
  const TRACK_SIGNATURE = (() => {
    let h = 2166136261;
    for (const p of CONTROL) {
      for (const v of p) { h ^= Math.round(v); h = Math.imul(h, 16777619); }
    }
    return `${def.id}:${(h >>> 0).toString(36)}:${N}:${ROAD_HALF}:${Math.round(TRACK_LEN)}`;
  })();

  return {
    def, id: def.id, name: def.name, short: def.short,
    skill: def.skill, skillLabel: def.skillLabel,
    ROAD_HALF, CONTROL, CENTER, N, CUMLEN, TRACK_LEN,
    START_GATE, START_POS, START_ANGLE, CHECKPOINTS, SECTORS, TRACK_SIGNATURE,
    bounds: GRID.bounds,
    indexAtFraction, indexAtArc, makeGate, segSpan, sectorAt,
    distToTrack, nearestIndex, nearestIndexNear, curvatureAt,
    isOffRoad: (x, y) => distToTrack(x, y) > ROAD_HALF,
  };
}

// ---------------------------------------------------------------- active track

const built = new Map();
export function getTrackData(id) {
  if (!built.has(id)) {
    const def = TRACK_DEFS.find(d => d.id === id);
    if (!def) throw new Error(`unknown track: ${id}`);
    built.set(id, buildTrack(def));
  }
  return built.get(id);
}

// LIVE BINDINGS. `export let` means every importer — including
// `import { CENTER } from "./track.js"` — sees the new track the moment
// setTrack() reassigns these, with no re-import and no accessor calls.
export let TRACK = null;
export let TRACK_ID = "";
export let TRACK_NAME = "";
export let ROAD_HALF = 0;
export let CONTROL = [];
export let CENTER = [];
export let N = 0;
export let CUMLEN = [];
export let TRACK_LEN = 0;
export let START_GATE = null;
export let START_POS = null;
export let START_ANGLE = 0;
export let CHECKPOINTS = [];
export let SECTORS = [];
export let TRACK_SIGNATURE = "";

export function setTrack(id) {
  const t = getTrackData(id);
  TRACK = t;
  TRACK_ID = t.id; TRACK_NAME = t.name;
  ROAD_HALF = t.ROAD_HALF; CONTROL = t.CONTROL; CENTER = t.CENTER; N = t.N;
  CUMLEN = t.CUMLEN; TRACK_LEN = t.TRACK_LEN;
  START_GATE = t.START_GATE; START_POS = t.START_POS; START_ANGLE = t.START_ANGLE;
  CHECKPOINTS = t.CHECKPOINTS; SECTORS = t.SECTORS;
  TRACK_SIGNATURE = t.TRACK_SIGNATURE;
  return t;
}
setTrack(DEFAULT_TRACK);

// ---- geometry queries, delegated to the active track ----
export const indexAtFraction = f => TRACK.indexAtFraction(f);
export const indexAtArc = a => TRACK.indexAtArc(a);
export const makeGate = i => TRACK.makeGate(i);
export const sectorAt = f => TRACK.sectorAt(f);
export const distToTrack = (x, y) => TRACK.distToTrack(x, y);
export const isOffRoad = (x, y) => TRACK.distToTrack(x, y) > TRACK.ROAD_HALF;
export const nearestIndex = (x, y) => TRACK.nearestIndex(x, y);
export const nearestIndexNear = (x, y, hint, window = 30) =>
  TRACK.nearestIndexNear(x, y, hint, window);
export const curvatureAt = (idx, span = 4) => TRACK.curvatureAt(idx, span);

// ---------------------------------------------------------------- gates

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
// lap timing run began this tick. Uses the ACTIVE track's gates.
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
