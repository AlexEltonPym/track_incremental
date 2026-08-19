// decor.js — PURELY COSMETIC world scenery: a DENSE FOREST band that hugs the
// track corridor, with lakes, clearings, rocks, bushes and flowers. No physics,
// no collision, no effect on the car or the bots — it just makes the off-track
// world look alive instead of flat green.
//
// THE SHAPE OF IT (all derived from geometry, never hand-placed):
//   * a GRASS CORRIDOR — a clear ring of grass of width GAP px around the road
//     edge, with NO trees, so the track visibly sits in a grassy corridor;
//   * a DENSE FOREST BAND beyond it — trees packed on a jittered grid that
//     FOLLOWS the track on both sides (the outside AND the loop interior),
//     bounded to a finite width so it hugs the corridor rather than paving the
//     whole world (which also caps the tree count);
//   * occasional grass CLEARINGS punched into the forest (blob-shaped holes);
//   * the occasional LAKE, sited inside the forest as a natural watery clearing.
//
// Everything is placed from the track's bounding box + distToTrack + indexAtArc
// using a SEEDED PRNG keyed on TRACK_SIGNATURE, so a track's scenery is
// deterministic (identical across frames and reloads), regenerated only when the
// track changes and CACHED per signature (flipping back is instant).
//
// It imports track.js at the SAME ?v=9 token every other module uses — a
// different token would split track.js into a second instance and break the
// per-track live bindings.
import * as T from "./track.js?v=9";

// ---------------------------------------------------------------- palette
//
// A calm, muted natural palette. This is BACKGROUND: the road and cars must stay
// the clear focus. Exported so main.js's draw loop and this generator agree on
// which colour index means what.
export const PALETTE = {
  trees: ["#2f4a2b", "#35512f", "#294324", "#3c5836", "#2b4b30"],
  treeShadow: "rgba(0,0,0,0.16)",
  rocks: ["#585d58", "#4c514c", "#646a63"],
  bushes: ["#3a5233", "#46603c", "#324a2e"],
  flowers: ["#c9b24a", "#c88a5e", "#b0698a", "#c7c2a0"],
  water: "#4b86ad",       // the lighter water the user set — do not revert
  waterEdge: "rgba(40,92,120,0.55)",
  shore: "#7d7856",       // muted sand ring around a lake
  island: "#33502c",
  reed: "rgba(60,86,52,0.7)",
};

// ---------------------------------------------------------------- tuning
const GAP = 175;             // grass corridor width beyond the road edge (px)
const FOREST_W = 600;        // forest band width beyond the corridor (px)
const TARGET_CAND = 14000;   // candidate trees on the biggest track -> spacing
const MIN_SP = 27;           // densest tree spacing (small tracks)
const TREE_CAP = 14000;      // hard ceiling on trees per track

// ---------------------------------------------------------------- PRNG
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

// Light per-track flavour — automatic from the track id, with a neutral default
// so any FUTURE track still gets sensible scenery. Only gentle multipliers on
// the geometry-driven counts; no coordinates here. `forest` also modulates the
// tree spacing floor (a bigger number = denser).
const FLAVOUR = {
  ember:     { forest: 0.9, lake: 0.6, rock: 1.2, bush: 1.0, flower: 1.0, clearing: 1.0 },
  longshore: { forest: 0.85, lake: 1.3, rock: 0.8, bush: 0.9, flower: 1.1, clearing: 1.1 },
  lantern:   { forest: 0.75, lake: 0.7, rock: 1.7, bush: 0.8, flower: 0.8, clearing: 0.9 },
  cruise:    { forest: 1.15, lake: 1.7, rock: 0.9, bush: 1.15, flower: 1.25, clearing: 1.3 },
  _default:  { forest: 1.0, lake: 1.0, rock: 1.0, bush: 1.0, flower: 1.0, clearing: 1.0 },
};

// ---------------------------------------------------------------- lakes

// An irregular organic lake: a jittered loop (two low harmonics + noise), NOT a
// circle. Returns the polygon, a bounding radius, an outer shore ring, an
// optional island and a few reed tufts.
function makeLake(cx, cy, baseR, rng) {
  const nv = 9 + Math.floor(rng() * 6);
  const ph1 = rng() * TAU, ph2 = rng() * TAU;
  const a1 = 0.16 + rng() * 0.18, a2 = 0.07 + rng() * 0.12;
  const poly = [], shore = [];
  const shoreW = 8 + rng() * 10;
  let maxR = 0;
  for (let i = 0; i < nv; i++) {
    const ang = (i / nv) * TAU;
    const rr = baseR * (1 + a1 * Math.sin(ang + ph1) + a2 * Math.sin(2 * ang + ph2)
      + (rng() - 0.5) * 0.12);
    const c = Math.cos(ang), s = Math.sin(ang);
    poly.push([cx + c * rr, cy + s * rr]);
    shore.push([cx + c * (rr + shoreW), cy + s * (rr + shoreW)]);
    if (rr > maxR) maxR = rr;
  }
  let island = null;
  if (baseR > 78 && rng() < 0.45) {
    const io = baseR * 0.35 * rng(), ia = rng() * TAU;
    const ir = baseR * (0.14 + rng() * 0.12);
    const iv = [], ix = cx + Math.cos(ia) * io, iy = cy + Math.sin(ia) * io;
    const n2 = 7 + Math.floor(rng() * 4);
    for (let i = 0; i < n2; i++) {
      const ang = (i / n2) * TAU;
      const rr = ir * (0.8 + rng() * 0.4);
      iv.push([ix + Math.cos(ang) * rr, iy + Math.sin(ang) * rr]);
    }
    island = iv;
  }
  const reeds = [];
  const nr = rng() < 0.6 ? 2 + Math.floor(rng() * 4) : 0;
  for (let i = 0; i < nr; i++) {
    const k = Math.floor(rng() * poly.length);
    reeds.push([poly[k][0], poly[k][1]]);
  }
  return { cx, cy, r: maxR + shoreW, poly, shore, island, reeds };
}

// ---------------------------------------------------------------- generation

function build(track) {
  const { ROAD_HALF, CENTER, N, TRACK_LEN, TRACK_SIGNATURE } = track;
  const dist = (x, y) => track.distToTrack(x, y);
  const rng = mulberry32(hashStr(TRACK_SIGNATURE));
  const fl = FLAVOUR[track.id] || FLAVOUR._default;

  const inner = ROAD_HALF + GAP;              // forest starts here
  const outer = inner + FOREST_W;             // ...and ends here
  const roadClear = ROAD_HALF + 40;           // detail may sit this far off road

  // A point somewhere in the forest band: walk to a random arc, step out along
  // the normal by an offset within the band, return it validated (distToTrack in
  // band) or null. Used to seed clearings and lakes into the forest.
  const bandPoint = (loR, hiR, tries) => {
    for (let t = 0; t < tries; t++) {
      const i = track.indexAtArc(rng() * TRACK_LEN);
      const p = CENTER[i], q = CENTER[(i + 1) % N];
      let tx = q[0] - p[0], ty = q[1] - p[1];
      const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      const side = rng() < 0.5 ? 1 : -1;
      const o = loR + rng() * (hiR - loR);
      const x = p[0] - ty * side * o, y = p[1] + tx * side * o;
      const d = dist(x, y);
      if (d >= inner && d <= outer) return [x, y, d];
    }
    return null;
  };

  // ---- clearings: blob-shaped grass holes punched into the forest.
  const clearings = [];
  const nClear = Math.max(3, Math.round(TRACK_LEN / 2500 * fl.clearing));
  for (let i = 0; i < nClear; i++) {
    const c = bandPoint(inner + 30, outer - 30, 24);
    if (!c) continue;
    clearings.push({
      cx: c[0], cy: c[1], r: 80 + rng() * 150,
      a1: 0.18 + rng() * 0.2, a2: 0.08 + rng() * 0.12,
      ph1: rng() * TAU, ph2: rng() * TAU,
    });
  }
  const inClearing = (x, y) => {
    for (const c of clearings) {
      const dx = x - c.cx, dy = y - c.cy;
      const dd = dx * dx + dy * dy;
      if (dd > c.r * c.r * 2) continue;
      const ang = Math.atan2(dy, dx);
      const rr = c.r * (1 + c.a1 * Math.sin(ang + c.ph1) + c.a2 * Math.sin(2 * ang + c.ph2));
      if (dd < rr * rr) return true;
    }
    return false;
  };

  // Soft clearing edge for the forest: instead of a hard in/out cut, thin the
  // trees through a transition band — certainly removed deep inside a clearing,
  // increasingly likely to survive toward its edge and a touch beyond it — so
  // the canopy FADES into the open grass rather than stopping at a circle.
  // Returns the probability [0,1] that a tree here should be removed.
  const clearingRemoveProb = (x, y) => {
    let best = 0;
    for (const c of clearings) {
      const dx = x - c.cx, dy = y - c.cy;
      const dd = dx * dx + dy * dy;
      if (dd > c.r * c.r * 1.6) continue;
      const ang = Math.atan2(dy, dx);
      const rr = c.r * (1 + c.a1 * Math.sin(ang + c.ph1) + c.a2 * Math.sin(2 * ang + c.ph2));
      const d = Math.sqrt(dd);
      const core = rr * 0.5, edge = rr * 1.08;   // fully clear -> full forest
      let p;
      if (d <= core) p = 1;
      else if (d >= edge) p = 0;
      else { const t = (edge - d) / (edge - core); p = t * t * (3 - 2 * t); }  // smoothstep
      if (p > best) best = p;
    }
    return best;
  };

  // ---- lakes: sited inside the forest band, well clear of the road and apart.
  const lakes = [];
  const maxLakeR = Math.max(55, Math.min(150, FOREST_W * 0.32));
  const nLakes = Math.max(1, Math.min(10, Math.round(TRACK_LEN / 5000 * fl.lake)));
  for (let i = 0; i < nLakes; i++) {
    const baseR = 40 + rng() * (maxLakeR - 40);
    let placed = null;
    for (let t = 0; t < 40; t++) {
      // centre far enough out that the whole lake clears the corridor
      const c = bandPoint(inner + baseR + 10, outer, 20);
      if (!c) continue;
      if (c[2] < inner + baseR) continue;
      let clash = false;
      for (const L of lakes) {
        if (Math.hypot(c[0] - L.cx, c[1] - L.cy) < baseR + L.r + 40) { clash = true; break; }
      }
      if (clash) continue;
      placed = makeLake(c[0], c[1], baseR, rng);
      break;
    }
    if (placed) lakes.push(placed);
  }
  const inLake = (x, y, pad) => {
    for (const L of lakes) {
      const dx = x - L.cx, dy = y - L.cy;
      const rr = L.r + pad;
      if (dx * dx + dy * dy < rr * rr) return true;
    }
    return false;
  };

  // ---- the dense forest band. Each tree gets its OWN random arc position and
  // random depth into the band, so it is a genuine 2D scatter — NOT a grid of
  // rows/columns, and not a set of shared perpendicular streaks (both of which
  // read as an orchard). Every candidate is validated against the true
  // distToTrack, so the band stays a constant-width corridor even where the
  // track loops back near itself and nothing lands in the grass gap. `cell` sets
  // the density (biggest track near TARGET_CAND, floored so small tracks stay
  // densely wooded); `target` is the resulting tree count, hard-capped.
  const cell = Math.max(MIN_SP / fl.forest,
    Math.sqrt(2 * FOREST_W * TRACK_LEN / TARGET_CAND));
  const target = Math.min(TREE_CAP,
    Math.round(2 * FOREST_W * TRACK_LEN / (cell * cell)));
  const trees = [];
  let tries = 0;
  const tryCap = target * 6;
  while (trees.length < target && tries < tryCap) {
    tries++;
    // A fresh random arc PER TREE (not a stepped walk): the tangent/normal are
    // taken where THIS tree sits, so no two trees share a perpendicular line —
    // that shared-normal grid was the orchard-row artifact. Random arc + random
    // depth = genuine 2D scatter across the band.
    const arc = rng() * TRACK_LEN;
    const i = track.indexAtArc(arc);
    const p = CENTER[i], q = CENTER[(i + 1) % N];
    let tx = q[0] - p[0], ty = q[1] - p[1];
    const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const side = rng() < 0.5 ? 1 : -1;
    const o = inner + rng() * FOREST_W;          // random depth into the band
    const x = p[0] - ty * side * o;              // out along the normal (-ty, tx)
    const y = p[1] + tx * side * o;
    const d = dist(x, y);
    if (d < inner || d > outer) continue;
    if (inLake(x, y, 6)) continue;
    const cp = clearingRemoveProb(x, y);          // fade the forest into clearings
    if (cp > 0 && rng() < cp) continue;
    // survivors near a clearing edge are smaller, softening the transition
    const r = Math.max(8, (cell * 0.42 + rng() * cell * 0.42) * (1 - 0.45 * cp));
    trees.push([x, y, r, Math.floor(rng() * PALETTE.trees.length)]);
  }

  // ---- rocks / bushes / flowers: in the GRASS CORRIDOR and the clearings,
  // where they read naturally against open grass rather than under canopy.
  // Both placers are BOUNDED (a centerline walk into the corridor, or a disc
  // inside a clearing) rather than rejection-sampling the whole padded bbox —
  // on the huge Cape Cruise a full-bbox scatter would spend most of its tries in
  // empty space far from the corridor and dominate the build time.
  const placeCorridor = (n, make) => {
    let made = 0, tries = 0, cap = n * 8;
    while (made < n && tries < cap) {
      tries++;
      const i = track.indexAtArc(rng() * TRACK_LEN);
      const p = CENTER[i], q = CENTER[(i + 1) % N];
      let tx = q[0] - p[0], ty = q[1] - p[1];
      const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      const side = rng() < 0.5 ? 1 : -1;
      const o = roadClear + 2 + rng() * (inner - roadClear - 6);
      const x = p[0] - ty * side * o, y = p[1] + tx * side * o;
      const d = dist(x, y);
      if (d <= roadClear || d >= inner) continue;   // stay in the grass corridor
      if (inLake(x, y, 4)) continue;
      make(x, y); made++;
    }
  };
  const placeClearings = (n, make) => {
    if (!clearings.length) return;
    let made = 0, tries = 0, cap = n * 10;
    while (made < n && tries < cap) {
      tries++;
      const c = clearings[Math.floor(rng() * clearings.length)];
      const ang = rng() * TAU, rad = Math.sqrt(rng()) * c.r;
      const x = c.cx + Math.cos(ang) * rad, y = c.cy + Math.sin(ang) * rad;
      if (!inClearing(x, y)) continue;
      const d = dist(x, y);
      if (d <= roadClear || inLake(x, y, 4)) continue;
      make(x, y); made++;
    }
  };
  const rocks = [], bushes = [], flowers = [];
  const mkRock = (x, y) => rocks.push([x, y, 4 + rng() * 9, Math.floor(rng() * PALETTE.rocks.length)]);
  const mkBush = (x, y) => bushes.push([x, y, 5 + rng() * 9, Math.floor(rng() * PALETTE.bushes.length)]);
  const mkFlower = (x, y) => flowers.push([x, y, Math.floor(rng() * PALETTE.flowers.length)]);
  const nRock = Math.round(TRACK_LEN / 60 * fl.rock);
  const nBush = Math.round(TRACK_LEN / 55 * fl.bush);
  const nFlower = Math.round(TRACK_LEN / 30 * fl.flower);
  // ~65% in the corridor beside the road, ~35% out in the clearings.
  placeCorridor(Math.round(nRock * 0.65), mkRock); placeClearings(nRock - Math.round(nRock * 0.65), mkRock);
  placeCorridor(Math.round(nBush * 0.65), mkBush); placeClearings(nBush - Math.round(nBush * 0.65), mkBush);
  placeCorridor(Math.round(nFlower * 0.6), mkFlower); placeClearings(nFlower - Math.round(nFlower * 0.6), mkFlower);

  return {
    sig: TRACK_SIGNATURE,
    meta: {
      gap: GAP, forestWidth: FOREST_W,
      inner, outer, spacing: +cell.toFixed(1), target,
    },
    lakes, clearings, trees, rocks, bushes, flowers,
    counts: {
      lakes: lakes.length, clearings: clearings.length, trees: trees.length,
      rocks: rocks.length, bushes: bushes.length, flowers: flowers.length,
    },
  };
}

// ---------------------------------------------------------------- cache
const _cache = new Map();

// Deterministic + cached per track signature. Pass a built-track object
// (T.TRACK); defaults to the active track.
export function getDecor(track) {
  const t = track || T.TRACK;
  const sig = t.TRACK_SIGNATURE;
  let d = _cache.get(sig);
  if (!d) { d = build(t); _cache.set(sig, d); }
  return d;
}
