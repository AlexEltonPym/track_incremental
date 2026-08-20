// botworker.js — the bot-field simulation, off the main thread.
//
// Buying a driving upgrade re-simulates all seven reference bots' three-lap
// races on the new car spec (deriveDriftZones + raceBest for the reactive five,
// the racing-line follower for LINE/ACE): ~0.6-1.5 s of pure number-crunching.
// Run on the main thread that froze the frame the instant you bought anything.
// This module worker moves that work off the render thread so the game never
// stalls: main.js posts a job, keeps the current bots looping, and swaps in the
// fresh field a moment later when the worker replies.
//
// It is a {type:"module"} worker importing bots.js at the SAME cache-bust token
// as the main thread (?v=13) so a caching server can't pair a fresh worker with
// a stale bots.js. The worker has its OWN module instances of bots/track/physics
// /racingline — that is fine and intended: it only SIMULATES and returns plain
// data, it never shares track state with the main thread. It sets its own track
// per request (T.setTrack) before simulating.
//
// bots.js keeps its own field cache keyed on (spec + track), so a repeated
// signature is cheap here too; the main thread additionally caches recent
// fields so a re-visit never even round-trips to the worker.

import * as T from "./track.js?v=13";
import { fullBotField } from "./bots.js?v=13";

self.onmessage = (e) => {
  const { reqId, key, trackId, params, opts } = e.data;
  // Simulate on the requested track + car spec. setTrack swaps the worker's own
  // track.js live bindings; fullBotField then reads the active track.
  T.setTrack(trackId);
  const field = fullBotField(params, opts);
  // The array's custom `simMs` property does NOT survive structured clone (only
  // indexed elements do), so it rides back as a sibling field. Each entry is
  // reduced to the plain data main.js actually maps into a botGhost — samples,
  // lap ticks, colours, labels — all structured-clone-safe.
  const simMs = field.simMs || 0;
  const plain = field.map(g => ({
    key: g.key, label: g.label, short: g.short, body: g.body, text: g.text,
    samples: g.samples,
    lapTicks: g.lapTicks,
    bestFlyingTicks: g.bestFlyingTicks,
    standingTicks: g.standingTicks,
    totalTicks: g.totalTicks,
  }));
  self.postMessage({ reqId, key, trackId, field: plain, simMs });
};
