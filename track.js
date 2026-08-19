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

// ---------------------------------------------------------------- CAPE CRUISE
//
// THE FOURTH CIRCUIT — deliberately in a different class from the other three:
// much LONGER, much WINDIER and far more RELAXED. A scenic coastal cruise, not
// a technical circuit: a wide road, occasional straights and big gentle
// sweepers (every radius >= 660 px, nothing tight or technical), so the timid
// NOVICE bot laps it comfortably and there is no dominant upgrade to express —
// it is a place to drive, not an income source (see README). Because a lap is
// several times longer than the others, it is EXEMPT from the specialist-
// differentiation gates and gets only a small, cheap check set in the harness,
// and the bot field records FEWER, longer laps (see bots.js fieldLaps()).
//
// HOW IT CLOSES — an ORGANIC solved-closure loop, not a mirror.
//
// The old cruise was one windy half duplicated under a 180-degrees rotation, so
// the whole track was point-symmetric — and that perfect rotational symmetry is
// exactly what read as artificial. This one is a single, ASYMMETRIC, meandering
// coastal loop with no repeating or mirror structure. An asymmetric meander does
// not return to its own start, so the closure is SOLVED rather than tricked:
//
//   * HEADING closes because every arc's degrees sum to exactly -360 (one full
//     loop) — the last arc's angle is set to whatever makes the total -360.
//   * POSITION closes through the STRAIGHTS. Seven straights sit around the loop;
//     the endpoint offset that remains once the arcs are laid down is distributed
//     across them by a least-norm solve (extras = D^T (D D^T)^-1 (-residual),
//     D the matrix of the straights' unit headings), so the closing translation
//     is shared out and every straight keeps a sane positive length.
//
// The seg list below is the solved result of that search (scratch generator,
// seed 26216): a mostly-convex coastal outline — heading trending once around
// with gentle counter-curves for bays — chosen from thousands of candidates for
// a chill profile (min radius 660 px, arc ~84%, ~27.6 k px / ~2.8 min lap) that
// never comes within ~2.4 road-widths of itself (min self-distance ~230 px, so
// the road never crosses or near-touches). Every radius is far too large to bank
// a drift charge at any spec, so PRO+ plans no drift and no upgrade dominates —
// the point of a chill cruise. It reuses every piece of the derived machinery
// for free: centerline, gates, sectors, F1 grid slots and the runoff.
const CRUISE = {
  id: "cruise",
  name: "CAPE CRUISE",
  short: "Cruise",
  skill: "cruise",
  skillLabel: "Scenic cruise",
  // Wide and forgiving — the widest road on any circuit.
  roadHalf: 52,
  start: [1200, 4200], heading: 0,
  // Coarser sampling than the others (the large radii need no dense control
  // points), which keeps the centerline point count — and with it the
  // broad-phase grid build and the per-tick nearest-point search — modest
  // despite the length.
  spacing: 60, samples: 4,
  // Six gates spread around the loop, each on a sweeper apex (these flat-list
  // indices are all arcs, roughly evenly spaced around the lap).
  checkpoints: [[1, 0.5], [5, 0.5], [9, 0.5], [13, 0.5], [17, 0.5], [21, 0.5]],
  // The solved organic loop: 20 sweeping arcs (radius 660-5950, degrees summing
  // to exactly -360) and 7 straights (296-874 px) whose lengths the least-norm
  // solve set to close the loop's position. Scenic coastal sector names.
  segs: [
    ["a", 1360, -21, "Sea Point sweep"],
    ["a", 780, -24, "Gull curve"],
    ["s", 609, "the causeway"],
    ["a", 1020, 36, "the inlet"],
    ["a", 5950, -44, "the long reach"],
    ["a", 910, 33, "Smugglers bend"],
    ["s", 764, "the promenade"],
    ["a", 660, -20, "the cove"],
    ["a", 1570, -41, "the dune sweep"],
    ["a", 4230, -16, "the marsh arc"],
    ["a", 3280, -22, "the lagoon bend"],
    ["s", 296],
    ["a", 930, -29, "the bluffs"],
    ["a", 1380, -38, "the cliff sweep"],
    ["s", 457],
    ["a", 1580, 36, "the estuary"],
    ["a", 1000, -33, "Heron curve"],
    ["a", 1850, -26, "the sands"],
    ["a", 670, -18, "Pelican bend"],
    ["s", 703, "the boardwalk"],
    ["a", 3970, -40, "the headland"],
    ["a", 2470, 35, "Tern sweep"],
    ["s", 734],
    ["a", 970, 27, "the anchorage"],
    ["a", 4050, -29, "Lighthouse reach"],
    ["a", 920, -126, "the marina curve"],
    ["s", 874, "the harbour front"],
  ],
};

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
  CRUISE,
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
const GRID_CELL = 32;      // the SHORT tracks' cell size (also the floor)
const GRID_REACH = 80;     // px of segments kept per cell; beyond this, rescan
// Target broad-phase cell count. On a small circuit the 32 px floor wins and
// the grid is unchanged; on the huge cape cruise (a bounding box tens of times
// larger) the cell GROWS so the cell count — and thus buildTrack's grid pass —
// stays bounded instead of ballooning into millions of cells. Cell size never
// changes a query's answer (within GRID_REACH the shortlist is provably
// complete; beyond it there is an exact full-scan fallback), so the short
// tracks stay byte-identical.
const GRID_TARGET_CELLS = 9000;

// F1 STARTING-GRID spacing (see gridSlot). Single-file staggered: each car a
// car-length-plus-gap further back than the one ahead, with a lateral zigzag.
const GRID_STEP = 40;      // px between consecutive grid positions along the straight
const GRID_LAT = 11;       // px lateral left/right stagger

// ------------------------------------------------------- the concrete runoff
//
// A THIRD SURFACE, placed the way a real circuit places it: a concrete skirt on
// the OUTSIDE of the corners cars actually run wide at, tapering in and out,
// and nowhere else. It is derived from the geometry — curvature magnitude says
// how demanding the corner is, curvature SIGN says which side is the outside —
// so it keeps working on a circuit nobody has drawn yet, and there is not one
// hand-placed skirt anywhere in the track definitions.
//
// The model, in one line: a corner's demand is the speed a reference car can
// carry through it, as a fraction of a reference top speed. A corner taken at
// 97% of top speed (Longshore's radius-260 sweepers) is where a car leaves the
// road at 250 px/s and needs somewhere to go; a 65%-of-top-speed corner
// (Lantern's radius-110 lobes) is one you arrive at slowly and only trickle
// off. Faster corner => wider skirt, exactly as at a real track.
export const RUNOFF_TUNING = {
  // Curvature sampling span (centerline points either side) — matches the
  // corner analyser in bots.js so both agree on where the corners are.
  curvSpan: 6,
  // A corner begins when the centerline radius drops below this many road
  // half-widths, and ends when it climbs back past cornerExitHyst x that.
  cornerRoads: 8,
  cornerExitHyst: 1.6,
  // ...and it only counts as a corner worth protecting if it actually changes
  // direction this much. This is what keeps a gentle linking kink (Lantern's
  // 9-19 degrees kinks) from collecting a skirt and turning "runoff at the
  // corners" into "runoff everywhere".
  minTurnDeg: 25,
  // Pricing a corner's demand: a reference lateral budget (px/s^2) and the
  // reference top speed the resulting corner speed is compared against. Both
  // are FIXED, not the player's current car: the concrete does not get poured
  // again when someone buys an upgrade.
  latRef: 300,
  vRef: 280,
  // Only corners above this demand get concrete at all (below it, the corner
  // is slow enough that going off costs you the corner, not the race).
  demandFloor: 0.55,
  // Skirt width in road half-widths, at demandFloor and at demand 1.0.
  widthMin: 0.45,
  widthMax: 1.30,
  // Where the skirt runs. Cars run wide from about the apex onwards and the
  // classic place to find one is the corner EXIT, but a skirt that only spans
  // that reads as a parking bay rather than a runoff: real ones start near the
  // turn-in (where a missed brake point puts you off) and run well down the
  // following straight. So the band opens just after the corner starts and
  // continues for most of another corner length past its end.
  fromFrac: 0.16,       // of the corner's length, from its start
  exitFrac: 1.00,       // extra length past the corner's end, in corner lengths
  // ...but the exit tail is also capped against the straight it runs down, as
  // a fraction of the gap to the next corner. Without this the extent has to
  // be tuned for the tightest circuit and everywhere else gets stubby bays:
  // a coil whose corners are 90 px apart pours into one unbroken ring long
  // before a track with real straights gets a tail worth the name. Capping
  // per-gap lets the fraction stay generous and keeps bare track before the
  // next turn-in, which is what makes the concrete read as runoff at all.
  exitMaxRoads: 6.0,    // hard ceiling on the tail, in road half-widths
  exitGapFrac: 0.55,    // ...and never more than this much of the gap ahead
  // Taper at each end, as a fraction of the band's own length: concrete never
  // starts with a step. Applied to the MERGED run, and capped so a very long
  // skirt doesn't spend its whole length ramping.
  taper: 0.28,
  taperMaxRoads: 2.2,   // longest ramp, in road half-widths
  // No stubs: a skirt shorter than this is stretched up to it. A few metres of
  // concrete is decoration, not somewhere you can actually gather the car up.
  // Kept off a cliff: on a tight coil the skirts merge into one unbroken ring
  // somewhere past ~4.5, which would pave the whole lap. 4.0 sits on the
  // stable side of that.
  minLenRoads: 4.0,     // minimum skirt length, in road half-widths
  // Two skirts separated by less than this many road half-widths are one
  // skirt. A double-apex corner (Longshore's are two 45 degrees arcs with a
  // 70 px link) is a single place a car runs wide, and paving it as two slabs
  // with a metre of grass between them would be both ugly and a trap.
  gapCloseRoads: 3,
};

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
  // `wPos` / `wNeg` are its half-widths on the +normal and -normal sides; they
  // default to the old symmetric "road plus a bit". Checkpoint gates override
  // them (see cpGate) to reach well out into the runoff and the grass on the
  // OUTSIDE of the corner while staying tight on the inside.
  const makeGate = (idx, wPos, wNeg) => {
    const p = CENTER[idx];
    const q = CENTER[(idx + 1) % N];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    const fx = dx / len, fy = dy / len;       // forward (travel) direction
    const nx = -fy, ny = fx;                  // normal across the road
    const wp = wPos ?? (ROAD_HALF + 8), wn = wNeg ?? (ROAD_HALF + 8);
    return {
      x: p[0], y: p[1], fx, fy, idx,
      ax: p[0] + nx * wp, ay: p[1] + ny * wp,
      bx: p[0] - nx * wn, by: p[1] - ny * wn,
    };
  };

  // Signed Menger curvature (1/px) at a centerline index. The SIGN is the one
  // fact everything about runoff and gate placement turns on: it is positive
  // when the track bends toward +normal (normal = (-fy, fx) of the direction of
  // travel), so the OUTSIDE of the corner — where a car runs wide — is the
  // -normal side, and vice versa.
  const curvSigned = (idx, span = RUNOFF_TUNING.curvSpan) => {
    const a = CENTER[((idx - span) % N + N) % N];
    const b = CENTER[idx];
    const c = CENTER[(idx + span) % N];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const denom = ab * bc * ca;
    if (denom < 1e-9) return 0;
    return (2 * cross) / denom;               // magnitude 2*area/(abc), signed
  };

  // Segment i's span as lap fractions (the definition's ideal arc length and
  // the sampled centerline agree to well under a percent).
  const segSpan = i => {
    const from = segFrom[i] / total;
    const to = (i + 1 < segFrom.length ? segFrom[i + 1] : total) / total;
    return [from, to];
  };

  // The START/FINISH line stays the old narrow, symmetric, DIRECTIONAL gate:
  // it is the one gate a lap can be completed on, so it must not be reachable
  // from the runoff or crossable backwards (see advanceLap).
  const START_GATE = makeGate(0);

  // CHECKPOINT GATES REACH PAST THE ROAD, ASYMMETRICALLY.
  //
  // Why past the road: a checkpoint you can miss by putting two wheels on the
  // concrete is a checkpoint that punishes the exact mistake the runoff exists
  // to forgive. So on the OUTSIDE of the corner the gate runs CP_OUT road
  // half-widths beyond the road edge — clear of the widest skirt, out into the
  // grass.
  //
  // Why asymmetrically: the gates exist to make cutting unprofitable, and a
  // cut goes across the INSIDE of the corner. Extending the inside end is the
  // one change that could hand a cheater a gate they never earned, so the
  // inside end grows barely at all (CP_IN, ~half a road half-width, against
  // the old flat 8 px). On a gate that sits on a straight there is no inside
  // or outside, so both ends get CP_MID and the widening is symmetric.
  const CP_OUT = 2.0, CP_IN = 0.5, CP_MID = 1.0;
  const cpGate = idx => {
    const k = curvSigned(idx);
    // 0 on a straight, 1 in a corner as tight as the corner threshold.
    const t = Math.min(1, Math.abs(k) * RUNOFF_TUNING.cornerRoads * ROAD_HALF);
    const eOut = ROAD_HALF * (CP_MID + (CP_OUT - CP_MID) * t);
    const eIn = ROAD_HALF * (CP_MID + (CP_IN - CP_MID) * t);
    // k > 0 bends toward +normal, so +normal is the INSIDE of the corner.
    return makeGate(idx, ROAD_HALF + (k > 0 ? eIn : eOut),
      ROAD_HALF + (k > 0 ? eOut : eIn));
  };
  const CHECKPOINTS = def.checkpoints.map(([seg, f]) => {
    const [from, to] = segSpan(seg);
    return cpGate(indexAtFraction(from + (to - from) * f));
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

  // F1 GRID SLOTS, derived from the track geometry so the field lines up on
  // every circuit. Slot 0 is POLE (40 px behind the line, ~= START_POS); each
  // further slot steps GRID_STEP px further back ALONG THE CENTERLINE (so the
  // grid follows the track round a corner behind the line rather than running
  // straight off into the grass), with a small left/right zigzag the way a real
  // grid staggers. The game grids the player on pole and the four bots on slots
  // 1..4 (NOVICE, MID, PRO, PRO+); each bot's simulated run STARTS from its
  // slot, so the further-back cars have a longer run to the line and the F1
  // spread falls out of the launch rather than being animated.
  const gridSlot = k => {
    const back = 40 + k * GRID_STEP;
    const lat = k === 0 ? 0 : (k % 2 === 1 ? GRID_LAT : -GRID_LAT);
    const arc = ((-back) % TRACK_LEN + TRACK_LEN) % TRACK_LEN;   // startArc(0) - back
    const i = indexAtArc(arc);
    const p = CENTER[i], q = CENTER[(i + 1) % N];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const L = Math.hypot(dx, dy) || 1;
    const fx = dx / L, fy = dy / L;           // forward tangent; normal (-fy, fx)
    return { x: p[0] - fy * lat, y: p[1] + fx * lat, angle: Math.atan2(fy, fx) };
  };

  // Squared distance from a point to centerline segment i. `HIT` carries the
  // parameter along the segment and the SIDE the point is on out of the hot
  // loop without allocating (this runs millions of times in a sweep).
  const HIT = { t: 0, side: 0 };
  const segDist2 = (i, x, y) => {
    const a = CENTER[i], b = CENTER[(i + 1) % N];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const t = Math.max(0, Math.min(1,
      ((x - a[0]) * abx + (y - a[1]) * aby) / (abx * abx + aby * aby)));
    const dx = x - (a[0] + abx * t), dy = y - (a[1] + aby * t);
    HIT.t = t;
    // Sign of (p - a) . normal, normal = (-aby, abx): +1 = the +normal side.
    HIT.side = ((x - a[0]) * -aby + (y - a[1]) * abx) >= 0 ? 1 : -1;
    return dx * dx + dy * dy;
  };

  // Broad-phase grid for distToTrack. Simulating four bots' 3-lap races on
  // demand runs distToTrack tens of thousands of times, and a full scan of
  // every centerline segment per call dominated the whole simulation — so each
  // grid cell caches the segments that could possibly be nearest to a point
  // inside it. Queries far from the track (deep in the grass, or outside the
  // grid) fall back to the full scan, so the answer is always exactly the same.
  // Bounding box first, then an adaptive cell size (see GRID_TARGET_CELLS).
  let _minX = Infinity, _minY = Infinity, _maxX = -Infinity, _maxY = -Infinity;
  for (const p of CENTER) {
    if (p[0] < _minX) _minX = p[0];
    if (p[0] > _maxX) _maxX = p[0];
    if (p[1] < _minY) _minY = p[1];
    if (p[1] > _maxY) _maxY = p[1];
  }
  const CELL = Math.max(GRID_CELL, 8 * Math.round(
    Math.sqrt((_maxX - _minX + 2 * GRID_REACH) * (_maxY - _minY + 2 * GRID_REACH) /
      GRID_TARGET_CELLS) / 8));
  const GRID = (() => {
    let minX = _minX, minY = _minY, maxX = _maxX, maxY = _maxY;
    const bounds = { minX, minY, maxX, maxY };
    minX -= GRID_REACH; minY -= GRID_REACH;
    const cols = Math.ceil((maxX + GRID_REACH - minX) / CELL);
    const rows = Math.ceil((maxY + GRID_REACH - minY) / CELL);
    const cells = new Array(cols * rows);
    const reach2 = (GRID_REACH + CELL) * (GRID_REACH + CELL);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = minX + (c + 0.5) * CELL, cy = minY + (r + 0.5) * CELL;
        const list = [];
        for (let i = 0; i < N; i++) if (segDist2(i, cx, cy) <= reach2) list.push(i);
        cells[r * cols + c] = list;
      }
    }
    return { minX, minY, cols, rows, cells, bounds };
  })();

  // Nearest point on the centerline: distance, which segment, how far along it
  // and which side of it. Written into a reused object (NEAR) rather than
  // returned fresh, because this is the single hottest function in the whole
  // simulation. distToTrack and surfaceAt are both thin wrappers over it, so
  // they can never disagree about where the edge of the road is.
  const NEAR = { dist: 0, idx: 0, t: 0, side: 1 };
  const closest = (x, y) => {
    let best = Infinity, bi = 0, bt = 0, bs = 1, done = false;
    const c = Math.floor((x - GRID.minX) / CELL);
    const r = Math.floor((y - GRID.minY) / CELL);
    if (c >= 0 && r >= 0 && c < GRID.cols && r < GRID.rows) {
      const list = GRID.cells[r * GRID.cols + c];
      for (let k = 0; k < list.length; k++) {
        const d = segDist2(list[k], x, y);
        if (d < best) { best = d; bi = list[k]; bt = HIT.t; bs = HIT.side; }
      }
      // Inside the cached reach the shortlist is provably complete.
      if (best <= GRID_REACH * GRID_REACH) done = true;
    }
    if (!done) {
      best = Infinity;
      for (let i = 0; i < N; i++) {
        const d = segDist2(i, x, y);
        if (d < best) { best = d; bi = i; bt = HIT.t; bs = HIT.side; }
      }
    }
    NEAR.dist = Math.sqrt(best);
    NEAR.idx = bi; NEAR.t = bt; NEAR.side = bs;
    return NEAR;
  };

  const distToTrack = (x, y) => closest(x, y).dist;

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

  // ------------------------------------------------- the runoff, derived
  //
  // Two width arrays, one per side of the centerline, in px BEYOND the road
  // edge. Everything about them falls out of the geometry: which runs of
  // centerline are corners (curvature magnitude + hysteresis), how much
  // direction each one actually changes (so a linking kink is not a corner),
  // how demanding it is (the speed a reference car carries through it) and
  // which side is the outside (curvature sign).
  const RUNOFF_POS = new Float32Array(N);
  const RUNOFF_NEG = new Float32Array(N);
  const RUNOFF_CORNERS = [];         // reporting: one entry per skirt
  (() => {
    const t = RUNOFF_TUNING;
    const kEnter = 1 / (t.cornerRoads * ROAD_HALF);
    const kExit = kEnter / t.cornerExitHyst;
    const K = new Float64Array(N);
    for (let i = 0; i < N; i++) K[i] = curvSigned(i, t.curvSpan);
    const used = new Uint8Array(N);
    const corners = [];
    for (let i = 0; i < N; i++) {
      if (used[i] || Math.abs(K[i]) < kEnter) continue;
      const dir = K[i] < 0 ? -1 : 1;
      const same = j => (K[j] < 0 ? -1 : 1) === dir && Math.abs(K[j]) >= kExit;
      let lo = i, hi = i;
      for (let s = 1; s < N; s++) {
        const j = ((i - s) % N + N) % N;
        if (!same(j) || used[j]) break;
        lo = j;
      }
      for (let s = 1; s < N; s++) {
        const j = (i + s) % N;
        if (!same(j) || used[j]) break;
        hi = j;
      }
      let peakK = 0, peakIdx = lo, turn = 0, len = 0;
      for (let j = lo; ; j = (j + 1) % N) {
        used[j] = 1;
        if (Math.abs(K[j]) > Math.abs(peakK)) { peakK = K[j]; peakIdx = j; }
        const dl = CUMLEN[j + 1] - CUMLEN[j];
        turn += Math.abs(K[j]) * dl;      // integrated |curvature| = radians turned
        len += dl;
        if (j === hi) break;
      }
      corners.push({ lo, hi, peakIdx, len, peakK, turnDeg: turn * 180 / Math.PI });
    }

    for (let ci = 0; ci < corners.length; ci++) {
      const c = corners[ci];
      if (c.turnDeg < t.minTurnDeg) continue;      // a kink, not a corner
      // Distance from this corner's exit to where the next one starts — the
      // straight the tail runs down. Wraps at the line.
      const next = corners[(ci + 1) % corners.length];
      const gapAhead = corners.length < 2 ? TRACK_LEN
        : ((CUMLEN[next.lo] - CUMLEN[c.hi]) % TRACK_LEN + TRACK_LEN) % TRACK_LEN;
      // ...and the straight behind, which is where a too-short skirt grows.
      const prev = corners[(ci - 1 + corners.length) % corners.length];
      const gapBehind = corners.length < 2 ? TRACK_LEN
        : ((CUMLEN[c.lo] - CUMLEN[prev.hi]) % TRACK_LEN + TRACK_LEN) % TRACK_LEN;
      const radius = 1 / Math.abs(c.peakK);
      // How fast a reference car goes round here, as a fraction of a reference
      // top speed. THIS is the "how much runoff is warranted" number: a corner
      // you take at 97% of top speed throws a car a long way; one you take at
      // 60% barely throws it at all.
      const demand = Math.min(t.vRef, Math.sqrt(t.latRef * radius)) / t.vRef;
      if (demand < t.demandFloor) continue;
      const u = (demand - t.demandFloor) / (1 - t.demandFloor);
      const w = ROAD_HALF * (t.widthMin + (t.widthMax - t.widthMin) * u);
      // The outside of the corner: curvature > 0 bends toward +normal, so the
      // car runs out toward -normal.
      const side = c.peakK > 0 ? -1 : 1;
      const arr = side > 0 ? RUNOFF_POS : RUNOFF_NEG;
      const exitLen = Math.min(c.len * t.exitFrac, t.exitMaxRoads * ROAD_HALF,
        gapAhead * t.exitGapFrac);
      let bandLen = c.len * (1 - t.fromFrac) + exitLen;
      // Too short to be useful? Grow BACKWARDS toward turn-in rather than
      // further down the exit: the exit is already capped against the straight
      // ahead, so lengthening there would close the gap to the next corner and
      // pave the lap. The entry side is capped the same way against the
      // straight behind, so a tight coil grows a little and no more.
      const growBack = Math.min(Math.max(0, t.minLenRoads * ROAD_HALF - bandLen),
        gapBehind * t.exitGapFrac);
      const fromArc = CUMLEN[c.lo] + c.len * t.fromFrac - growBack;
      bandLen += growBack;
      // Poured FLAT here; the taper is applied at the end, once neighbouring
      // bands have been merged. Tapering during the pour makes a band's ends
      // near-zero, and the merge step then has only those near-zero values to
      // join with — which is what produced pinched notches between skirts.
      let idx = indexAtArc(fromArc), gone = 0;
      while (gone <= bandLen) {
        if (w > arr[idx]) arr[idx] = w;
        gone += CUMLEN[idx + 1] - CUMLEN[idx];
        idx = (idx + 1) % N;
      }
      RUNOFF_CORNERS.push({
        from: (fromArc % TRACK_LEN) / TRACK_LEN,
        to: ((fromArc + bandLen) % TRACK_LEN) / TRACK_LEN,
        len: bandLen, width: w, radius, demand, side,
        turnDeg: c.turnDeg, sector: sectorAt((CUMLEN[c.peakIdx] / TRACK_LEN) % 1),
      });
    }

    // Bridge short gaps: a double-apex corner is one place a car runs wide, so
    // paving it as two slabs with a strip of grass between them is both ugly
    // and a trap. Bands are still flat here, so the join is at full width.
    const gapMax = t.gapCloseRoads * ROAD_HALF;
    for (const arr of [RUNOFF_POS, RUNOFF_NEG]) {
      for (let i = 0; i < N; i++) {
        if (arr[i] > 0) continue;
        let gone = 0, j = i, n = 0;
        while (arr[j] <= 0 && gone <= gapMax && n < N) {
          gone += CUMLEN[j + 1] - CUMLEN[j];
          j = (j + 1) % N; n++;
        }
        if (n >= N || gone > gapMax) continue;             // not a short gap
        const before = arr[((i - 1) % N + N) % N], after = arr[j];
        if (before <= 0 || after <= 0) continue;           // not between skirts
        // Carry the WIDER neighbour across: the gap is inside one continuous
        // run-off area, and stepping in and out of a narrow throat mid-corner
        // is the shape this whole pass exists to avoid.
        const fill = Math.max(before, after);
        for (let k = 0, m = i; k < n; k++, m = (m + 1) % N) arr[m] = fill;
      }
    }

    // Taper, last: walk each merged run and ramp its two outer ends. Doing it
    // here means the ramps belong to the final shape rather than to whichever
    // bands happened to be poured, so a merged double-apex reads as one skirt
    // that opens once and closes once.
    for (const arr of [RUNOFF_POS, RUNOFF_NEG]) {
      const seen = new Uint8Array(N);
      for (let s = 0; s < N; s++) {
        if (arr[s] <= 0 || seen[s]) continue;
        if (arr[((s - 1) % N + N) % N] > 0) continue;      // not a run start
        const run = [];
        let runLen = 0;
        for (let k = 0, m = s; k < N && arr[m] > 0; k++, m = (m + 1) % N) {
          run.push(m); seen[m] = 1;
          runLen += CUMLEN[m + 1] - CUMLEN[m];
        }
        if (!run.length) continue;
        const ramp = Math.max(1, Math.min(runLen * t.taper, t.taperMaxRoads * ROAD_HALF));
        let along = 0;
        for (const m of run) {
          const dl = CUMLEN[m + 1] - CUMLEN[m];
          const f = Math.min(1, Math.min(along, runLen - along) / ramp);
          arr[m] *= f;
          along += dl;
        }
      }
    }
  })();

  // Fraction of the lap that has concrete on at least one side, and the total
  // skirt area — both are reported by the harness so "at the corners, not
  // everywhere" is a measured claim rather than an intention.
  const RUNOFF_COVERAGE = (() => {
    let covered = 0;
    for (let i = 0; i < N; i++) {
      if (RUNOFF_POS[i] > 0 || RUNOFF_NEG[i] > 0) covered += CUMLEN[i + 1] - CUMLEN[i];
    }
    return covered / TRACK_LEN;
  })();

  // Width of the skirt (px beyond the road edge) at a point on the centerline,
  // linearly interpolated between samples so the boundary is smooth.
  const runoffWidth = (idx, t2, side) => {
    const arr = side > 0 ? RUNOFF_POS : RUNOFF_NEG;
    const a = arr[idx], b = arr[(idx + 1) % N];
    return a + (b - a) * t2;
  };

  // THE SURFACE QUERY. `probe` answers "where am I and what am I standing on"
  // in one pass — callers that need both (the bot race recorder wants the
  // surface for the physics AND the distance for its on-road margin) must not
  // pay for two nearest-point searches per tick.
  const probe = (x, y) => {
    const p = closest(x, y);
    p.surface = p.dist <= ROAD_HALF ? 0
      : p.dist <= ROAD_HALF + runoffWidth(p.idx, p.t, p.side) ? 1 : 2;
    return p;
  };
  const surfaceAt = (x, y) => probe(x, y).surface;

  // Renderable runoff bands: closed polygons hugging the road edge on the
  // inside and the skirt's outer boundary on the outside. Built here rather
  // than in main.js so the picture is generated from the same arrays the
  // physics reads — a band you can see is a band you can drive on.
  const RUNOFF_BANDS = (() => {
    const bands = [];
    const vnorm = i => {
      const a = CENTER[(i - 1 + N) % N], b = CENTER[(i + 1) % N];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      return [-dy / L, dx / L];
    };
    for (const [arr, sgn] of [[RUNOFF_POS, 1], [RUNOFF_NEG, -1]]) {
      let start = -1;
      for (let k = 0; k < N; k++) if (arr[k] <= 0) { start = k; break; }
      if (start < 0) continue;                 // never happens: see coverage
      let run = null;
      for (let k = 0; k <= N; k++) {
        const i = (start + k) % N;
        if (arr[i] > 0) { (run || (run = [])).push(i); continue; }
        if (!run) continue;
        const inner = [], outer = [];
        for (const j of run) {
          const [nx, ny] = vnorm(j);
          inner.push([CENTER[j][0] + sgn * nx * ROAD_HALF,
            CENTER[j][1] + sgn * ny * ROAD_HALF]);
          const o = ROAD_HALF + arr[j];
          outer.push([CENTER[j][0] + sgn * nx * o, CENTER[j][1] + sgn * ny * o]);
        }
        outer.reverse();
        bands.push(inner.concat(outer));
        run = null;
      }
    }
    return bands;
  })();

  // Cheap identity for "this track". Bot races are simulated on demand and
  // cached against (car spec + track), so the cache has to notice which track
  // it is looking at — editing a definition's geometry, its road width or its
  // sampling density all change this string.
  const TRACK_SIGNATURE = (() => {
    let h = 2166136261;
    for (const p of CONTROL) {
      for (const v of p) { h ^= Math.round(v); h = Math.imul(h, 16777619); }
    }
    // The runoff changes how the car behaves, so it belongs in the key the bot
    // field is cached under.
    return `${def.id}:${(h >>> 0).toString(36)}:${N}:${ROAD_HALF}:` +
      `${Math.round(TRACK_LEN)}:r${Math.round(1000 * RUNOFF_COVERAGE)}`;
  })();

  return {
    def, id: def.id, name: def.name, short: def.short,
    skill: def.skill, skillLabel: def.skillLabel,
    ROAD_HALF, CONTROL, CENTER, N, CUMLEN, TRACK_LEN,
    START_GATE, START_POS, START_ANGLE, gridSlot, CHECKPOINTS, SECTORS, TRACK_SIGNATURE,
    bounds: GRID.bounds,
    RUNOFF_POS, RUNOFF_NEG, RUNOFF_BANDS, RUNOFF_CORNERS, RUNOFF_COVERAGE,
    indexAtFraction, indexAtArc, makeGate, segSpan, sectorAt,
    distToTrack, nearestIndex, nearestIndexNear, curvatureAt, curvSigned,
    surfaceAt, runoffWidth, closest, probe,
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
export let RUNOFF_BANDS = [];
export let RUNOFF_CORNERS = [];
export let RUNOFF_COVERAGE = 0;

export function setTrack(id) {
  const t = getTrackData(id);
  TRACK = t;
  TRACK_ID = t.id; TRACK_NAME = t.name;
  ROAD_HALF = t.ROAD_HALF; CONTROL = t.CONTROL; CENTER = t.CENTER; N = t.N;
  CUMLEN = t.CUMLEN; TRACK_LEN = t.TRACK_LEN;
  START_GATE = t.START_GATE; START_POS = t.START_POS; START_ANGLE = t.START_ANGLE;
  CHECKPOINTS = t.CHECKPOINTS; SECTORS = t.SECTORS;
  TRACK_SIGNATURE = t.TRACK_SIGNATURE;
  RUNOFF_BANDS = t.RUNOFF_BANDS; RUNOFF_CORNERS = t.RUNOFF_CORNERS;
  RUNOFF_COVERAGE = t.RUNOFF_COVERAGE;
  return t;
}
setTrack(DEFAULT_TRACK);

// ---- geometry queries, delegated to the active track ----
// Grid slot k (0 = pole == START_POS): { x, y, angle }. Derived from the active
// track's start-straight geometry, so the field lines up on every circuit.
export const gridSlot = k => TRACK.gridSlot(k);
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
export const curvSigned = (idx, span) => TRACK.curvSigned(idx, span);
// The three-surface query: SURFACE.ROAD / RUNOFF / GRASS (physics.js).
export const surfaceAt = (x, y) => TRACK.surfaceAt(x, y);
export const runoffWidth = (idx, t, side) => TRACK.runoffWidth(idx, t, side);
export const closestOnTrack = (x, y) => TRACK.closest(x, y);
// One nearest-point search, answering distance + surface together.
export const probeTrack = (x, y) => TRACK.probe(x, y);

// ---------------------------------------------------------------- gates

// Does segment p1->p2 cross segment p3->p4?
export function segCross(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Crossed the gate in the direction of travel this tick? Used for the
// START/FINISH line, which is DIRECTIONAL on purpose — see advanceLap.
export function crossedGate(gate, px, py, x, y) {
  if (!segCross(px, py, x, y, gate.ax, gate.ay, gate.bx, gate.by)) return false;
  return (x - px) * gate.fx + (y - py) * gate.fy > 0;
}

// Touched the gate at all, in EITHER direction. This is how CHECKPOINTS are
// tested: a driver who spins, or who has to reverse out of a mistake, can
// still pick their checkpoint back up on the way through rather than losing
// the lap for a crossing that happened to be nose-first the wrong way.
export function crossedGateEither(gate, px, py, x, y) {
  return segCross(px, py, x, y, gate.ax, gate.ay, gate.bx, gate.by);
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
//
// THE TWO RULES, and why they are different:
//
//   * CHECKPOINTS count in EITHER DIRECTION, but still strictly IN ORDER: only
//     `CHECKPOINTS[nextCp]` is ever tested. Bidirectional is pure leeway —
//     spin, reverse out of the grass, cross the gate nose-first backwards, and
//     the lap survives. It cannot be farmed, because re-crossing a gate you
//     have already banked is not the gate being tested any more, so no amount
//     of shuttling back and forth over one gate advances you past it; the only
//     way to reach checkpoint n+1 is to physically drive to it.
//   * THE START/FINISH LINE STAYS DIRECTIONAL. It is the gate that ends a lap,
//     so a bidirectional one would let a car park on the line and saw back and
//     forth. Reversing back over the line is simply not a crossing, and a lap
//     that ends without every checkpoint banked is invalid — so the "cross,
//     reverse, cross again" lap ends immediately and scores nothing.
export function advanceLap(lap, px, py, x, y) {
  const ev = { finished: null, started: false };
  if (lap.active) {
    lap.ticks++;
    const cp = CHECKPOINTS[lap.nextCp];
    if (cp && crossedGateEither(cp, px, py, x, y)) lap.nextCp++;
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
