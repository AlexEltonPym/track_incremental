// decor.js — PURELY COSMETIC world scenery: lakes, forests, rocks, bushes and
// flowers scattered in the grass AROUND the track. No physics, no collision,
// no effect on the car or the bots — it just makes the off-track world look
// alive instead of flat green.
//
// Everything here is DERIVED FROM GEOMETRY (the track's bounding box +
// distToTrack) and a SEEDED PRNG keyed on the track signature, so a track's
// scenery is deterministic: identical across frames and across reloads, and
// regenerated only when the track (its signature) actually changes. Results are
// CACHED per signature, so flipping back to a track you were just on is instant.
//
// It imports track.js at the SAME ?v=9 token every other module uses — a
// different token would split track.js into a second instance and break the
// per-track live bindings.
import * as T from "./track.js?v=9";

// ---------------------------------------------------------------- palette
//
// A calm, muted natural palette. This is BACKGROUND: the road and cars must stay
// the clear focus, so nothing here is saturated or bright. Exported so main.js's
// draw loop and this generator agree on which colour index means what.
export const PALETTE = {
  // Canopy greens, all darker/greyer than the pure road-side greens so a forest
  // reads as depth rather than noise.
  trees: ["#2f4a2b", "#35512f", "#294324", "#3c5836", "#2b4b30"],
  treeShadow: "rgba(0,0,0,0.16)",
  rocks: ["#585d58", "#4c514c", "#646a63"],
  bushes: ["#3a5233", "#46603c", "#324a2e"],
  flowers: ["#c9b24a", "#c88a5e", "#b0698a", "#c7c2a0"],
  water: "#2e4d66",
  waterEdge: "rgba(20,36,50,0.55)",
  shore: "#7d7856",       // muted sand ring around a lake
  island: "#33502c",
  reed: "rgba(60,86,52,0.7)",
};

// ---------------------------------------------------------------- PRNG
// mulberry32 — tiny, fast, deterministic. Seeded from a string hash of the
// track signature so each track gets its own stable layout.
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
// so any FUTURE track still gets sensible scenery. These are only gentle
// multipliers on top of the geometry-driven counts; no coordinates here.
const FLAVOUR = {
  ember:     { forest: 0.9, lake: 0.15, rock: 1.2, bush: 1.0, flower: 1.0 },
  longshore: { forest: 0.8, lake: 1.25, rock: 0.8, bush: 0.9, flower: 1.1 },
  lantern:   { forest: 0.7, lake: 0.4,  rock: 1.7, bush: 0.8, flower: 0.8 },
  cruise:    { forest: 1.2, lake: 1.7,  rock: 0.9, bush: 1.15, flower: 1.25 },
  _default:  { forest: 1.0, lake: 1.0,  rock: 1.0, bush: 1.0, flower: 1.0 },
};

// ---------------------------------------------------------------- generation

// Rejection-sample a point in the padded bbox that clears the road by `roadClear`.
// Density RAMPS UP with distance from the road (clear margin near the tarmac,
// denser out in the grass), so decoration never crowds the racing surface.
function samplePoint(rng, bb, distFn, roadClear, ramp, minP, tries) {
  for (let t = 0; t < tries; t++) {
    const x = bb.x0 + rng() * bb.w;
    const y = bb.y0 + rng() * bb.h;
    const d = distFn(x, y);
    if (d <= roadClear) continue;
    const p = Math.min(1, Math.max(minP, (d - roadClear) / ramp));
    if (rng() < p) return [x, y, d];
  }
  return null;
}

// An irregular organic lake: a jittered loop (two low harmonics + a little
// noise), NOT a circle. Returns the polygon, a bounding radius, an outer shore
// ring, an optional island and a few reed tufts.
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
  // A tiny island in bigger lakes.
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
  // A few reed tufts poking up from the shore of some lakes.
  const reeds = [];
  const nr = rng() < 0.6 ? 2 + Math.floor(rng() * 4) : 0;
  for (let i = 0; i < nr; i++) {
    const k = Math.floor(rng() * poly.length);
    reeds.push([poly[k][0], poly[k][1]]);
  }
  return { cx, cy, r: maxR + shoreW, poly, shore, island, reeds };
}

function build(track) {
  const { ROAD_HALF, bounds, TRACK_SIGNATURE } = track;
  const distFn = (x, y) => track.distToTrack(x, y);
  const rng = mulberry32(hashStr(TRACK_SIGNATURE));
  const fl = FLAVOUR[track.id] || FLAVOUR._default;

  const bw = bounds.maxX - bounds.minX, bh = bounds.maxY - bounds.minY;
  const pad = Math.max(300, Math.min(bw, bh) * 0.18);
  const bb = { x0: bounds.minX - pad, y0: bounds.minY - pad, w: bw + 2 * pad, h: bh + 2 * pad };
  const area = bb.w * bb.h;

  const roadClear = ROAD_HALF + 46;   // comfortable clear margin around the road
  const ramp = 260;                    // px over which density climbs to full
  const minP = 0.22;                   // floor acceptance just past the margin

  const lakes = [];
  const trees = [];
  const rocks = [];
  const bushes = [];
  const flowers = [];

  // ---- lakes: a few, in the deep grass, well clear of the road and each other.
  const maxLakeR = Math.max(60, Math.min(240, Math.min(bw, bh) * 0.06));
  const nLakes = Math.min(16, Math.round(area / 5.2e6 * fl.lake));
  for (let i = 0; i < nLakes; i++) {
    const baseR = 42 + rng() * (maxLakeR - 42);
    let placed = null;
    for (let t = 0; t < 40; t++) {
      const x = bb.x0 + rng() * bb.w, y = bb.y0 + rng() * bb.h;
      const need = roadClear + baseR * 1.25 + 24;
      if (distFn(x, y) < need) continue;
      // keep lakes apart
      let clash = false;
      for (const L of lakes) {
        if (Math.hypot(x - L.cx, y - L.cy) < baseR + L.r + 40) { clash = true; break; }
      }
      if (clash) continue;
      placed = makeLake(x, y, baseR, rng);
      break;
    }
    if (placed) lakes.push(placed);
  }
  const inLake = (x, y, pad2) => {
    for (const L of lakes) if (Math.hypot(x - L.cx, y - L.cy) < L.r + pad2) return true;
    return false;
  };

  // ---- forests: CLUSTERS, not a uniform sprinkle. Pick cluster centres in the
  // grass, then scatter N trees of varied size around each.
  const nClusters = Math.max(4, Math.min(240, Math.round(area / 1.2e6 * fl.forest)));
  for (let c = 0; c < nClusters; c++) {
    const centre = samplePoint(rng, bb, distFn, roadClear + 24, ramp, minP, 30);
    if (!centre) continue;
    const [ccx, ccy] = centre;
    if (inLake(ccx, ccy, 40)) continue;
    const clusterR = 55 + rng() * 120;
    const nTrees = 6 + Math.floor(rng() * 12);
    for (let k = 0; k < nTrees; k++) {
      const ang = rng() * TAU, rad = Math.sqrt(rng()) * clusterR;
      const x = ccx + Math.cos(ang) * rad, y = ccy + Math.sin(ang) * rad;
      const r = 9 + rng() * 12 + (rng() < 0.12 ? 6 : 0);
      if (distFn(x, y) <= roadClear + r) continue;     // canopy fully off road
      if (inLake(x, y, r + 4)) continue;
      trees.push([x, y, r, Math.floor(rng() * PALETTE.trees.length)]);
    }
  }

  // ---- rocks / boulders: individual scatter, some larger.
  const nRocks = Math.round(area / 5.5e5 * fl.rock);
  for (let i = 0; i < nRocks; i++) {
    const p = samplePoint(rng, bb, distFn, roadClear, ramp, minP, 20);
    if (!p) continue;
    const r = 4 + rng() * 8 + (rng() < 0.15 ? 5 : 0);
    if (p[2] <= roadClear + r || inLake(p[0], p[1], r + 3)) continue;
    rocks.push([p[0], p[1], r, Math.floor(rng() * PALETTE.rocks.length)]);
  }

  // ---- bushes / shrubs: individual scatter.
  const nBushes = Math.round(area / 4.5e5 * fl.bush);
  for (let i = 0; i < nBushes; i++) {
    const p = samplePoint(rng, bb, distFn, roadClear, ramp, minP, 20);
    if (!p) continue;
    const r = 5 + rng() * 9;
    if (p[2] <= roadClear + r || inLake(p[0], p[1], r + 3)) continue;
    bushes.push([p[0], p[1], r, Math.floor(rng() * PALETTE.bushes.length)]);
  }

  // ---- flowers: small PATCHES of tiny dots, sparse.
  const nPatches = Math.round(area / 7.0e5 * fl.flower);
  for (let i = 0; i < nPatches; i++) {
    const p = samplePoint(rng, bb, distFn, roadClear, ramp, minP, 18);
    if (!p) continue;
    if (inLake(p[0], p[1], 20)) continue;
    const dots = 3 + Math.floor(rng() * 5);
    for (let k = 0; k < dots; k++) {
      const x = p[0] + (rng() - 0.5) * 26, y = p[1] + (rng() - 0.5) * 26;
      if (distFn(x, y) <= roadClear + 3 || inLake(x, y, 4)) continue;
      flowers.push([x, y, Math.floor(rng() * PALETTE.flowers.length)]);
    }
  }

  return {
    sig: TRACK_SIGNATURE,
    bounds: { ...bb },
    lakes, trees, rocks, bushes, flowers,
    counts: {
      lakes: lakes.length, trees: trees.length, rocks: rocks.length,
      bushes: bushes.length, flowers: flowers.length,
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
