# Trackcrimental

Incremental top-down 2D drift racer prototype. Line up on an F1 grid, launch at
GO, and lap **endlessly** against a five-bot pace field. Your **ranked best
laps** each replay forever as earning ghosts — ghost #1 is your best lap, #2
your second best, and so on — paying credits that buy car upgrades and unlock
more circuits, each of which then earns income at the same time.

**Three designed circuits**, each built so a *different* upgrade is the dominant
lever: EMBER LOOP rewards the drift boost, LONGSHORE SPEEDWAY rewards top speed,
LANTERN COIL rewards grip. That is measured, not asserted — see
*[The three circuits](#the-three-circuits)*.

…plus a **fourth, in a different class entirely: CAPE CRUISE** — a much longer,
windier, more relaxed scenic loop (a ~1.7-minute bot lap against the others'
~10–13 s), unlocked from the start, deliberately with *no* dominant upgrade. It
is a place to drive, not a circuit to master. See *[Cape Cruise, the fourth
circuit](#cape-cruise-the-fourth-circuit)*.

Plain HTML + JS + canvas. No dependencies, no build step.

## Run

```
python -m http.server 8123
```

Then open http://localhost:8123 in a browser. (Any static file server works.
The game is ES modules, so it must be served over http, not file://.)

### Persistence is OFF (prototyping mode)

`main.js` starts with

```js
const PERSISTENCE = false;
```

While that is false the game **never reads or writes localStorage, and clears
every `trackcrimental_*` key at boot** — so a page refresh resets everything:
zero credits, all upgrades back to Lv 0, no best lap and no earning ghost *on
any track*, back to the default circuit, default zoom, default toggles. That is
deliberate: every test of a balance change starts from the same clean slate,
and a stale save from before the change cannot leak in.

The save/load code is intact and correct (**schema v6**). The shape is a clean
split of global and per-track state:

```
{ version: 6, credits, drivingLevels: {speed,accel,grip,boostPwr,boostDur},
  currentTrack, unlocked: [trackId, ...],
  tracks: { trackId: { lapPayoutLvl, ghostFleetLvl,
                       rankedLaps: [{ ticks, samples }, ...] } } }
```

so the map unlocks, the per-track economy levels and each track's **ranked list
of best laps** (with their recordings) all round-trip; unknown track ids are
ignored, and a track with no entry simply starts blank. Flip the one constant
back to `true` and saving works exactly as before.

## Controls

- **WASD / arrow keys** — accelerate, brake/reverse, steer. Holding brake
  stops the car and *holds* it stopped; reverse engages only after holding
  brake ~0.35 s at a standstill, or on a fresh brake press while stopped
  (no more accidental reversing mid-corner)
- **Space or Shift** — handbrake drift, Mario-style: hold the slide *through
  a corner* to charge a boost. After ~0.55 s of genuine cornering the tire
  marks turn **blue** (tier 1: +28% top speed for 1.1 s on release); after
  ~1.05 s they turn **orange** (tier 2: +45% for 1.7 s, arriving with a
  ~0.9 g shove). Release while still moving fast to fire the boost. Letting
  go early is a no-op — drifting never punishes. While drifting, steering
  picks the drift arc (the car assists the slide into a stable ~25° angle);
  countersteer or release steering to straighten out. A full-lock slide now
  rotates the car *faster* than gripped steering can (1.97 vs 1.85 rad/s), so
  drifting is a genuine cornering technique, not just a boost ritual.
  Charging requires actually cornering at speed — straight-line slides and
  handbrake stops bleed charge away instead of banking it, and the handbrake
  barely slows the car (use the brake to slow down)
- **R** — re-grid: the whole field back on the F1 grid and the **3‑2‑1‑GO
  countdown** re-run (aborts the current lap and resets the endless lap tally)
- **G** — toggle the NOVICE/MID/PRO/PRO+/PRO++ bot reference ghosts
- **Mouse scroll wheel** (over the track) — zoom out to survey most of the
  track, or back in (reset by a refresh while persistence is off)
- **Track buttons** (top of the side panel: Ember / Longshore / Lantern /
  Cruise) — switch circuit, or **unlock** a locked one. Ember **and Cape Cruise**
  are unlocked from the start; Longshore (**4,000 cr**) and Lantern (**15,000
  cr**) show a 🔒 and their unlock price until bought, greying out until you can
  afford them. Switching an
  unlocked circuit re-simulates its bot field (cached per track, so flipping
  back is instant), re-grids + counts you in, and shows that circuit's own
  records, ghosts and per-track upgrades

## How it plays

**Start menu, countdown, F1 grid.** On load (and after a full reset) a dark
START overlay sits over the canvas: a title and a **GO** button. Pressing GO
runs a **3‑2‑1‑GO countdown** on the canvas (~1 s each), and at GO the whole
field launches **automatically, even with no player input** — everyone
accelerates off the grid together. **R** re-grids and re-runs the countdown at
any time.

The field lines up like an F1 grid, staggered back along the start straight:
**player on POLE, then NOVICE 2nd, MID 3rd, PRO 4th, PRO+ 5th, PRO++ 6th**, each
a car-length-and-gap further back than the one ahead with a slight left/right
zigzag. The slots are derived from the start-straight geometry (walked backward
along the centerline, so they follow the track round a corner behind the line
rather than running off into the grass) and each bot's simulated run *starts
from its own slot* — so the further-back cars have a longer run to the line and
the F1 spread falls out of the launch, not from an animation.

**Then it is endless.** There is no fixed race length. After GO the player
drives freely forever while the five bots loop their flying lap continuously as
the pace reference. The side panel's *Laps* row is an endless tally. Each lap
must still hit every checkpoint gate in order (4 gates on Ember and Longshore, 7
on Lantern) to count — though the gates are generous about *how* you hit them,
see *[Checkpoints](#checkpoints-bidirectional-wide-and-still-uncuttable)*. Your
first lap from the grid carries the accelerate-from-zero run-up; every lap after
crosses the line already at speed and is a **flying lap**, worth ~1.1–1.5 s.
That is why the panel compares you against the bots' best *flying* laps.

### Getting paid — your ranked best laps

Each circuit keeps a **ranked list of your best distinct valid laps**
(fastest-first, capped at 12), each a full per-tick recording. Two things pay
credits:

- **Driving a valid lap yourself.** Every clean lap pays immediately —
  `round(720 / lapSeconds) x payoutMult x 2.5` credits — and is inserted into
  the ranked list.
- **The earning ghosts.** Ghost #1 replays your **best** lap, #2 your **2nd
  best**, #3 your 3rd best, and so on down the list. Each earns on **its own**
  lap time — `round(720 / lapSeconds) x payoutMult` per loop — so a slower
  ghost further down the list pays less per loop *and* loops less often. They
  are staggered around the circuit (a golden-ratio offset of each ghost's own
  length) so they spread out rather than stacking, and they are income and
  scenery only — they never collide and never score a lap time.

**Fleet size** on a track is `min(1 + GhostFleetLevel, rankedLaps.length)` —
your best lap is ghost #1 for free at Ghost Fleet Lv 0. **The Ghost Fleet buy is
gated on having driven enough laps**: you can only buy the next level once you
have another distinct recorded lap to fill the new ghost, so the button is
disabled (with a *set another lap time* hint) whenever `rankedLaps.length` is
not greater than the current fleet size — you may be able to *afford* it and
still be blocked.

**Every UNLOCKED track's fleet keeps paying, all the time**, whichever circuit
you are currently driving — only the active track's ghosts are drawn. So
unlocking a map and setting laps on it is a permanent income increase, and
*Income* (the panel row) is every unlocked track's fleets summed, while *Ghost
payout* is just this track's ghost #1.

### Three surfaces, none of them a trap

There are no walls, no gravel and nothing that stops you. There are **three
surfaces**, and the middle one is the point:

| | speed you settle at, flat out | what it feels like |
|---|---|---|
| **road** (tarmac) | 278 px/s | the racing surface |
| **runoff** (concrete) | 255 px/s — **92%** | you ran a bit wide. Carry on. |
| **grass** | 83 px/s — **30%** | you have lost the corner |

Run wide at 270 px/s and a second later you still have **92%** of your speed on
the concrete against **39%** in the grass. The concrete skirt is leeway: it
costs a tenth of a second, not the lap. The HUD says so too — grass gets the
red `OFF ROAD — ease back on`, the concrete gets a quiet grey `runoff — off
the racing line`, because a warning that fires for a harmless mistake is a
warning people learn to ignore.

**Where the concrete is** is derived from the track's own geometry, F1-style —
on the outside of the corners cars actually run wide at, and nowhere else. See
*[Where the runoff comes from](#where-the-runoff-comes-from)*.

### Checkpoints: bidirectional, wide, and still uncuttable

Every lap must hit every checkpoint gate **in order**. Two rules make that
forgiving without making it exploitable:

- **Checkpoints count in EITHER direction.** Spin, reverse out of a mistake,
  cross the gate nose-first backwards — the lap survives. Only the *next*
  checkpoint is ever tested, so shuttling back and forth over one gate never
  advances you past it; the only way to reach checkpoint *n+1* is to drive to
  it.
- **Checkpoint gates reach well past the road edge** — out to 107 px from the
  centerline on Ember and 118 px on Lantern, against road half-widths of 38
  and 42 px. You can be deep in the grass, let alone on the concrete, and
  still bank the checkpoint. They are widened **asymmetrically**: the outside
  end (where a car runs wide) grows to 2 road half-widths past the edge, the
  inside end (where a *cutter* goes) grows to half of one, because the gates
  exist to make cutting unprofitable.
- **The start/finish line stays directional.** It is the gate that ends a lap,
  so reversing back over it is simply not a crossing — and crossing it forward
  again ends the lap with the checkpoints unbanked, i.e. invalid. There is no
  "saw across the line" lap.

Cutting is still hopeless, and the harness measures it rather than asserting
it: it solves for the **shortest possible gate-legal path** on each circuit
(coordinate descent on where each gate is crossed) and then drives it with an
absurdly generous cheater — no cornering limit at all, instant direction
changes, full throttle everywhere, only the surface slowing it down. On Ember
that path is 1 856 px (79% of the lap) but **entirely on grass**, so the best
conceivable time on it is **22.0 s** against PRO's real **9.78 s** lap. Same
story on the other two (33.5 s vs 12.75 s; 21.5 s vs 10.83 s).

### World / scenery

Every track sits in a **grassy corridor inside a dense forest**, all **purely
decorative** — no physics, no collision, no effect on driving or the bots.
Around the road is a clear **grass corridor** (a tree-free ring, `GAP` = 175 px
beyond the road edge), and beyond it a **dense forest band** of finite width
(`FOREST_W` = 600 px) of packed, shaded canopies with a soft offset shadow. The
band **follows the track on both sides** — the outside *and* the loop interior —
so the world hugs the corridor rather than filling the whole map, which also
bounds the tree count. Punched into the forest are occasional blob-shaped grass
**clearings**, and the odd **lake** (an organic jittered blob with a sand shore,
sometimes an island and reeds) sited out in the forest as a natural watery
clearing. **Rocks, bushes and flowers** dress the grass corridor and the
clearings.

It is **procedural per track** (`decor.js`): trees are laid on a jittered grid
walked along the centerline and offset out into the band, every position
**validated against `distToTrack`** so the corridor stays a constant-width ring
even where a track loops back near itself and **nothing lands in the grass gap**
(measured: every sampled tree centre clears `ROAD_HALF + GAP`, zero violations on
all four circuits). Everything is seeded on `TRACK_SIGNATURE`, so a track's
scenery is identical across frames and reloads, regenerated only on a track
change and **cached per signature** (flipping back is instant). Tree **spacing is
chosen from track length** so the biggest circuit lands near a target candidate
count and small circuits stay densely wooded, with a hard **cap (≤ 14 000
trees)**; a light automatic per-track flavour tunes density, lakes and clearings
(cruise gets the most). Rough per-track counts: **Ember ~1 650 trees / 3
clearings / 1 lake, Longshore ~3 100 / 3 / 1, Lantern ~940 / 3 / 1, Cape Cruise
~12 900 / 14 / 9**. Generation is bounded and fast (Cape Cruise builds in
~430 ms, once, then cached), and the draw loop is **viewport-culled** — only
items within the visible radius are drawn, so even ~13 000 trees cost ~0.1 ms a
frame. The minimap is left clean.

## The three circuits

Each one is defined in `track.js` as a closed path of straights and arcs — the
way a circuit is actually described ("a 336 px straight, then 160° of radius
150 left, then 680 px…") — and built into a centerline, gates, sectors and a
collision grid at load. All three are casual-friendly: the timid keyboard
NOVICE bot completes 10/10 valid laps on every one of them with **0.00%** of
its time off-road.

| | EMBER LOOP | LONGSHORE SPEEDWAY | LANTERN COIL |
|---|---|---|---|
| rewards | **Boost Power / Duration** | **Top Speed** | **Grip** |
| length | 2 344 px | 3 473 px | 2 222 px |
| road width | 76 px | 76 px | 84 px |
| corners / gates | 3 / 4 | 8 / 4 | 13 / 7 |
| MID's flying lap | 10.23 s | 13.12 s | 11.17 s |
| PRO's slowest point | 73% of top speed | 95% | 62% |

**EMBER LOOP — the kidney.** A 336 px start straight into **turn 1, the
horseshoe** (160° of radius 150), then a **680 px boost straight**, then **turn
2, the launch loop** (another 160°/150 px), then 336 px + a fast 40° kink back
to the line. Both loops are open enough to *slide at racing speed* — a
full-lock drift holds their 173 px racing-line arc at 253 px/s, which is
actually **faster** than the clean line's 248 px/s — long enough to bank a
charge in, and each one exits onto hundreds of px of straight where the boost
converts into lap time. That last clause is the whole point, and the thing the
old v3 circuit got wrong: its drift corner exited *into another corner*, so a
stronger boost was simply braked away again and Boost Power bought nothing.
Here PRO+ fires two boosts a lap and the drift line is worth **1.30 s (11.7%)**
over PRO's best clean lap.

**LONGSHORE SPEEDWAY — the stadium.** Two long straights (560 px and
340 + 220 px through the line), two 220 px chutes, and four **double-apex**
corners: each 90° direction change is two 45° arcs of radius 260 with a 70 px
link. Two things fall out of that, both deliberate:

- radius 260 is fast enough that the clean line barely lifts (272 px/s against
  a stock top speed of 280), so buying Grip buys almost nothing here and buying
  Top Speed buys the whole lap;
- each *arc* is only 193 px long — far short of the ~250 px a tier-1 drift
  charge needs at that speed, and that requirement only grows as the car gets
  quicker. So the corner analyser finds **no drift zones at all here, at any
  spec**, which also means there is no upgrade level at which a drift plan
  silently appears or disappears and jolts the lap time.

**LANTERN COIL — the coil.** Seven left-handers of radius 108–140 px (a clean
line holds ~184 px/s through them, 66% of stock top speed — never slow enough
to be a hairpin, never fast enough to be flat), each separated from the next by
a right-handed kink and 64–91 px of straight. Nothing is long enough to
accelerate down and nothing is long enough to bank a drift charge in either, so
the lap is decided by one thing: how fast the car will go round a corner.

### The proof that they differ — measured PER CREDIT

`node test/drive_bot.mjs` measures it rather than claiming it. The measurement
used to buy **8 levels of one upgrade alone** and compare lap times, and that
measurement was half a decision: *levels are not what you spend*. By it, Top
Speed was the biggest lever on two circuits out of three and looked like a
design failure. Some of that was a real balance problem (fixed — see *[The Top
Speed rebalance](#the-top-speed-rebalance)*), and some of it was measuring the
wrong thing.

So the differentiation gates now give every upgrade **the same pile of
credits**, let it buy as many levels as that affords, and compare the lap time
each pile bought — the choice a player is actually making. Three budgets,
because "which upgrade first" must not depend on being early or late in the
run. `boost` is that budget split across Boost Power + Boost Duration, since a
stronger burst that lasts no longer is half a plan.

```
VALUE PER CREDIT — same credits on each upgrade, % off PRO+'s best flying lap.
  track      budget            speed          accel           grip       boostPwr       boostDur          boost
  ember      1200 cr      9.66% (3)      1.97% (6)      5.33% (6)     4.73% (10)     6.31% (11)   11.64% (8+8)*
  ember      3000 cr     11.44% (5)      1.97% (8)      5.52% (8)     5.33% (13)     7.10% (14) 13.41% (11+12)*
  ember      8000 cr     12.23% (6)     1.97% (10)     5.72% (11)     5.92% (17)     7.50% (18) 14.00% (14+15)*
  longshore  1200 cr     16.09% (3)*     0.00% (6)      0.54% (6)     0.00% (10)     0.00% (11)    0.00% (8+8)
  longshore  3000 cr     16.22% (5)*     0.00% (8)      0.54% (8)     0.00% (13)     0.00% (14)  0.00% (11+12)
  longshore  8000 cr     16.22% (6)*    0.00% (10)     0.67% (11)     0.00% (17)     0.00% (18)  0.00% (14+15)
  lantern    1200 cr      0.00% (3)      7.26% (6)     18.32% (6)*    0.00% (10)     0.00% (11)    0.00% (8+8)
  lantern    3000 cr     -0.17% (5)      8.25% (8)     21.45% (8)*    0.00% (13)     0.00% (14)  0.00% (11+12)
  lantern    8000 cr     -0.17% (6)     9.24% (10)    23.76% (11)*    0.00% (17)     0.00% (18)  0.00% (14+15)
            (levels the budget buys in brackets; * = best value on that row)
```

**Every circuit's specialist is the best thing that circuit's credits can buy,
at every budget** — and that is nine acceptance gates, not a claim:

- the **boost pair** wins on Ember (11.6 / 13.4 / 14.0% against Top Speed's
  9.7 / 11.4 / 12.2%);
- **Top Speed** wins on Longshore (16.1–16.2%, against ~0% for everything
  else);
- **Grip** wins on Lantern (18.3–23.8%, against Acceleration's 7.3–9.2% and
  Top Speed's nothing at all);
- each specialist pays more on its own circuit than on either other one;
- Top Speed is **not** the best buy on the drift or the grip circuit — the
  whole point of the rebalance;
- ...but it is still a real purchase, not a trap: ≥ 10% on its own circuit,
  and still the second-best thing to own on Ember, ahead of Grip and
  Acceleration.

Neither boost upgrade *alone* out-earns Top Speed on Ember (7.1% for Boost
Duration against 11.4%), and that is deliberate rather than a miss: they are
two halves of one purchase, and the pair — the way anyone actually buys them —
beats it comfortably at every budget.

The older per-level table is still printed, because it says something the
per-credit one hides: what each circuit is physically *sensitive* to, with
price taken out.

```
UPGRADE SENSITIVITY — % off PRO+'s best flying lap for 8 levels of one upgrade, per track.
  track       designed for     base lap     speed     accel      grip  boostPwr  boostDur  drift line
  ember       Boost / drift       8.45s    12.82%     1.97%     5.52%     4.14%     5.33%       13.6%
  longshore   Top speed          12.43s    16.22%     0.00%     0.54%     0.00%     0.00%        2.5%
  lantern     Grip / precision   10.10s    -0.17%     8.25%    21.45%     0.00%     0.00%        6.8%
```

- **Grip** is worth 21.5% on the coil and **0.5%** on the speedway — corners
  that are already flat out cannot be taken faster.
- **The boost upgrades** are worth 9.5% combined on Ember and **exactly zero**
  anywhere else, because nowhere else has a corner you can bank a charge in.
- **The drift line itself** (PRO+ against PRO on the same car) is worth 13.6%
  on Ember against 6.8% and 2.5% elsewhere.

### The Top Speed rebalance

Top Speed used to be a flat **+10% per level, forever**, at the same x1.6 price
growth as almost everything else. Measured per level it was the biggest lever
on *every* circuit — 14.2% on the drift track, 16.2% on the speedway — and it
was useful everywhere, so there was never a reason to buy anything else first.
That kills the premise that different tracks reward different builds.

Three changes, all of them in `physics.js`:

1. **Diminishing returns with a soft cap.** Each level now buys 10% of the
   *remaining headroom* toward +72%: `speedBonus(l) = 0.72 * (1 - e^(-0.10 l /
   0.72))`. Level 1 is still worth ~+10%, so nothing about the early game
   changed; level 8 is worth +48% instead of +80%, and level 20 is +67%
   instead of +200%. The curve is continuous and strictly increasing, so the
   bots' monotonicity invariant is untouched — and a Lv 20 car doing 468 px/s
   instead of 840 px/s is a car the corner planners can still drive.
2. **A steeper price.** x1.95 per level against x1.6 for Acceleration and x1.5
   for Grip, from a base of 90 cr — the priciest thing in the shop, because it
   is the one upgrade that is useful everywhere.
3. **Cheaper, stronger specialists.** Boost Power and Boost Duration were
   90 / 80 cr at x1.65 for +9% / +10% a level; they are now **25 / 20 cr at
   x1.30** for a soft-capped +14% a level. 3 000 credits used to buy six levels
   of Boost Power; it now buys thirteen. Grip's growth dropped x1.6 → x1.5.

Brakes still ride the speed curve (+26% of whatever the speed bonus is), so a
faster car can still stop: the "an upgrade is never a downgrade" invariant that
rule exists for is unchanged.

The result is the table above. Top Speed is still a strong, obvious buy, it
still wins outright on the circuit built for it, and it is no longer the
correct first purchase everywhere.

### Where the runoff comes from

The concrete skirt is **derived from the geometry**, not hand-placed per
circuit — there is not one runoff coordinate in any track definition, and a
fourth circuit gets its concrete for free. `buildTrack()` does this
(`RUNOFF_TUNING` holds every constant):

1. **Find the corners.** Maximal runs of same-sign curvature whose radius drops
   below 8 road half-widths, with hysteresis — the same test the drift-zone
   analyser uses, so both agree on where the corners are.
2. **Throw out the kinks.** A run only counts if it actually changes direction
   by ≥ 25°. That is what stops Lantern's 9–19° linking kinks from collecting a
   skirt and turning "runoff at the corners" into "runoff everywhere".
3. **Price the corner's demand.** How fast a *reference* car (a fixed lateral
   budget and a fixed reference top speed — not the player's current car; the
   concrete is not re-poured when someone goes shopping) carries through it, as
   a fraction of that top speed. Longshore's radius-251 sweepers come out at
   **0.98**, Ember's loops at **0.74**, Lantern's lobes at **0.63–0.72**.
4. **Width follows demand**, 0.45 → 1.30 road half-widths across the range, so
   a corner you take at 98% of top speed gets 48 px of concrete and one you
   take at 63% gets 25 px. Exactly the way a real circuit is built: the
   quicker the corner, the further the car goes when it lets go.
5. **Place it on the OUTSIDE, from the apex to past the exit.** The curvature's
   *sign* says which side the car runs out to. The band starts 35% into the
   corner (cars run wide from the apex onwards) and continues for another 40%
   of the corner's length past its end — the corner exit is the classic place
   to find a car on the concrete — with a taper at each end so the surface
   never starts with a step.
6. **Bridge short gaps.** Two skirts less than 3 road half-widths apart are one
   skirt, so Longshore's double-apex corners (two 45° arcs with a 70 px link)
   get one continuous slab instead of two with a metre of grass between them.

What that produces:

| circuit | lap with concrete on one side | skirts | where, and how wide |
|---|---|---|---|
| **EMBER** | 46% | 3 | both 158° loops (31 px each) and the last kink (42 px) |
| **LONGSHORE** | 55% | 4 | the outside of all four double-apex corners, 48 px — the widest on any circuit, because they are the fastest |
| **LANTERN** | 51% | 7 | the outside of all seven lobes, 25–32 px, widest at the fastest (turn 1) |

The straights stay bare: Ember's longest unbroken stretch with no concrete at
all is 27% of the lap, Longshore's 16%, and on the coil — which has no straight
longer than 91 px — 7%. Three acceptance gates check this from the width
arrays themselves rather than from the derivation: every skirt must peak at a
real corner, must sit on the *outside* of it, and at least a quarter of the lap
must have no concrete anywhere.

### Designing a fourth track

Two rules kept the invariants green, both learned the hard way:

1. **A corner must be comfortably slideable or comfortably not — never near
   the boundary.** The corner analyser needs `cornerLength ≥ 0.935 x vZone` to
   plan a drift charge, and `vZone` *grows* with the car's speed and grip. A
   corner that is feasible at Lv 0 and infeasible at Lv 8 loses PRO+ its boost
   at some upgrade level, which reads as "an upgrade made the bot slower" and
   fails the monotonicity gate. Ember's loops clear the bar by 28–86% *at every
   spec*; Longshore's and Lantern's corners miss it by 15–65% at every spec.
2. **The start line wants a straight either side of it.** The grid slot sits
   40 px behind the line, so a line placed in a corner starts everyone
   mid-apex.

The corner-feasibility numbers are easy to check: `findCorners()` and
`deriveDriftZones()` in `bots.js` are pure functions of the active track and a
car spec, so a scratch script can print every corner's arc length against its
tier-1 charge requirement across the whole upgrade range.

## Cape Cruise, the fourth circuit

The other three are ~2.2–3.5 k px with 10–13 s bot laps, each a tight little
skill-expression track. **CAPE CRUISE is the opposite of all of that**: a
**27,607 px** scenic coastal loop with a **~1.7-minute** bot lap (99 s for PRO,
102 s for NOVICE), a **wide 104 px road**, occasional straights and twenty big
gentle sweepers — every radius ≥ 660 px, nothing tight or technical. It exists
to be *cruised*: the timid NOVICE bot laps it with **0.00 %** of its time
off-road, and there is **no dominant upgrade to express** — the corners are all
far too open to reward a specialist lever. It is unlocked from the start.

**How it is shaped — an organic solved-closure loop, not a mirror.** The old
cruise was one windy half *duplicated under a 180° rotation*, so the whole track
was point-symmetric — and that perfect rotational symmetry is exactly what read
as artificial. This one is a single, **asymmetric, meandering coastal outline**
with no repeating or mirror structure. An asymmetric meander does not return to
its own start, so the closure is **solved**, not tricked:

- **Heading** closes because every arc's degrees sum to exactly **−360°** (one
  full loop) — the last arc's angle is set to whatever makes the total −360.
- **Position** closes through the **straights**: seven straights sit around the
  loop, and the endpoint offset that remains once the arcs are laid down is
  distributed across them by a **least-norm solve** (`extras = Dᵀ(DDᵀ)⁻¹(−residual)`,
  `D` the matrix of the straights' unit headings), so the closing translation is
  shared out and every straight keeps a sane positive length.

The seg list in `track.js` is the solved result of a seeded search (thousands of
candidates), picked for a chill profile — a mostly-convex coastal outline with
gentle counter-curve bays, **min radius 660 px, arc ~84 %, ~27.6 k px / ~1.7 min
lap** — that **never comes within ~2.4 road-widths of itself** (the road never
crosses or near-touches; genuinely distant sections stay > 1 000 px apart). It
reuses every piece of the derived machinery for free: centerline, gates,
sectors, F1 grid slots and the runoff. (Because every radius clears the corner
threshold — 8 road half-widths ≈ 416 px — the geometry-derived analysers find
**no corner at all** here, so there is no drift zone to plan and no concrete
runoff: a wide, open, uniformly gentle road, exactly as a chill cruise wants.)

### Why a 12×-longer track needed engineering, not just geometry

A ~100-second lap breaks assumptions that were safe on a 12-second one:

- **Recording caps.** `main.js`'s lap-recording abort (`maxLapTicks()`) and
  `bots.js`'s `recordRace` budget were fixed 5-minute / 2-minute-per-lap
  constants that a long lap would blow. Both are now **track-aware** (scaled to
  `TRACK_LEN`), so a full lap records end-to-end — the player's earning-ghost
  lap *and* the bot recordings. The short circuits are dominated by the old
  floors, so their behaviour is unchanged.
- **First-visit field sim.** `simulateBotField` runs five bots' whole race on
  the first visit (then caches). On a ~1.7-min lap a 3-lap field would be a
  multi-second freeze, so a long track records **2 laps, not 3** (a standing
  launch + one flying lap to loop — a chill cruise does not need the extra
  flying lap; `bots.fieldLaps()`). Measured **~275 ms in Node, ~350 ms in the
  browser** — well under a ~2 s budget. There is also **no drift plan to race**
  here (every radius is too open to bank a charge at any spec), which
  keeps PRO+ to a single simulated variant.
- **Broad-phase grid build.** The circuit's bounding box is ~9.3 k × 8.4 k px; a
  fixed 32 px collision-grid cell would build millions of cells. The cell size
  is now **adaptive** (`GRID_TARGET_CELLS`), sized to keep the cell *count*
  bounded, which cut the build from ~770 ms to ~200 ms. Cell size never changes
  a query's answer, so the short tracks (whose small bbox still yields the 32 px
  cell) stay byte-identical.

### Exempt from the differentiation gates — and the economy caveat

Cape Cruise is **exempt from the specialist-differentiation gates** (the
sensitivity / value-per-credit tables that assert "Top Speed is the biggest
lever on Longshore", etc.) and from the heavy per-track upgrade-space sweep.
Those gates assert a *dominant upgrade*, and this track deliberately has none —
it is a cruise, not a skill-expression circuit. The harness iterates the three
**designed** circuits (ember/longshore/lantern) for all of that, so adding the
cruise cannot perturb them; the cruise instead gets a **small, cheap check set**
(friendliness, tier-ladder ordering, basic monotonicity on a handful of specs,
a length check, a full-lap-records check, and a field-sim-budget check) so the
whole suite stays fast despite a multi-minute lap.

**The economy caveat, stated plainly:** payout is `round(720 / lapSeconds) ×
mult`, which for a ~100 s lap **rounds to only a handful of credits per loop**
(against ~85 for an Ember loop). Cape Cruise is therefore **not an income
source** — it is a test/cruise level, a place to drive. That is expected and
intentional.

## The bot ghosts (an endless pace field, simulated live)

Five translucent **bot reference ghosts** lap alongside you forever, so you can
calibrate "is it just me". They are **not** a baked recording: `bots.js`
simulates each bot's whole standing-start race *from its own grid slot*
headlessly in the browser at load, and again whenever your car changes. The game
then plays the **standing launch once** (spreading the F1 grid) and **loops the
first flying lap forever** — both ends of that lap are on the start line, so the
wrap is seamless. That costs **~60-160 ms for the whole five-bot field** and it
buys two things a baked file cannot:

- **The bots drive YOUR car.** They use the same `carParams(state.levels)` you
  do, so buying an upgrade makes them quicker too and the race stays a test of
  driving rather than of hardware. Their HUD times update on the spot.
- **The bots survive a new map.** Nothing about them is tied to this circuit's
  arc-length fractions - including PRO+'s drift zones, which are derived from
  track curvature (below).

Times on the stock car (lap 1 standing / lap 2 / lap 3 - total, best flying):

| tier | lap 1 | lap 2 | lap 3 | race | best flying |
|------|-------|-------|-------|------|-------------|
| green **NOVICE** - sloppy keyboard driver, slow reactions | 13.12 | 12.03 | 12.03 | 37.18 | **12.03** |
| purple **MID** - clean, competent line; never drifts | 11.58 | 10.23 | 10.23 | 32.05 | **10.23** |
| cyan **PRO** - the optimal *clean* lap | 11.15 | 9.78 | 9.80 | 30.73 | **9.78** |
| gold **PRO+** - the drift bot (banks tier 1) | 9.85 | 8.45 | 8.45 | 26.75 | **8.45** |
| magenta **PRO++** - the fastest bot; banks **tier 2** here | 9.60 | 8.18 | 8.18 | 25.97 | **8.18** |

(EMBER LOOP, stock car. Each circuit has its own field: see the per-track
summary the harness prints.)

PRO is a real corner-speed planner: on Ember it brakes for both loops (slowest
flying-lap point 73% of top speed) and keeps a >= 8 px on-road margin. Beating
MID with tidy driving is realistic; beating PRO cleanly is very hard. PRO+
handbrake-slides both loops, banks a charge through each arc and fires the
boost onto the straight that follows - worth **1.30 s (11.7%)** over PRO on the
standing lap.
Watch it for a live demo of where and how drifting pays.

### PRO++ — the fastest bot, and the tier-2 boost proven

**PRO++** is a clear step above PRO+ on every circuit, and it is the tier that
actually spends the **full boost (tier 2 / orange)**. It keeps PRO+'s proven-safe
cornering *base* — the same corner-entry grip budget, brake margin and look-ahead,
so its line never leaves the road across the whole upgrade space — and adds only
what buys time without ever running wide:

- **It races a forced tier-2 drift plan** (`tryTier2`) as one of its
  `raceBest` variants, and keeps it only where the bigger burst actually beats
  the tier-1 line on the exit that follows. `deriveDriftZones` grew a
  `targetTier` knob for this; PRO+ and every other tier still plan exactly as
  before.
- **A slightly more aggressive line** — `steerGain` 1.6 (vs 1.45), which cuts a
  little more line, and `turnUse` 0.95 (vs the default 0.85), which banks more
  of the car's yaw-rate ceiling. Those two are per-skill overrides on the corner
  planner; it deliberately leaves `latBudget` / `brakeMargin` / `lineWiden`
  alone, because pushing *those* carried Ember's drift off the road on an
  upgraded car (which then lost the boost and inverted the ladder).

**Where its time comes from, and the honest per-track tier-2 verdict** (stock
car, best flying lap; PRO++'s margin over PRO+ in brackets):

| circuit | PRO+ | PRO++ | gain | tier 2 pays? | where the gain comes from |
|---|---|---|---|---|---|
| **EMBER** (drift) | 8.45 | **8.18** | **-0.27 s (3.2%)** | **YES — banks tier 2** | both loops exit onto a long straight, so the bigger orange burst has room to run. This is the headline: PRO++ shows an **orange** flame here. |
| **LANTERN** (grip) | 10.10 | **9.32** | **-0.78 s (7.8%)** | no chargeable corner | `turnUse` — the coil is *steering*-limited, and PRO+ leaves ~28 px of road unused, so banking more of the yaw ceiling is worth a lot. |
| **LONGSHORE** (top speed) | 12.43 | **12.40** | **-0.03 s (0.3%)** | no chargeable corner | almost nothing: the speedway lap is `length / top speed` (top-speed-bound), so with the same car the only lever is a fractionally tighter line. |

So **tier 2 pays on EMBER only**, and PRO++ is honest about it: on Longshore and
Lantern *no corner is long enough to bank a charge in at any spec* (the same
reason PRO+ never drifts there), so there is nothing to escalate to tier 2 —
PRO++ falls back to the fastest clean/aggressive line rather than forcing a
slower tier-2 slide. **Longshore is the weak spot**: it is genuinely
top-speed-bound, so PRO++ can only edge PRO+ by a hair (~2 ticks). *What would
let tier 2 shine on more tracks:* a slideable sweeper (radius ~150, ≥ 25° of
turn) exiting onto a long straight — Ember's launch loop → boost straight is
exactly that shape. Longshore's radius-260 corners are too open to bank a charge
and its straights already run at top speed; a tighter corner feeding a longer
straight would give PRO++ an orange boost to spend there too.

PRO++'s speed comes from the boost and the yaw ceiling, **not** from riding the
edge: it keeps a healthy on-road margin on every circuit (stock car ~20 px on
Ember, ~28 px on Lantern, ~31 px on Longshore — a touch tighter than PRO+ but
nowhere near the edge), and the harness gates it at **≥ 3 px inside the road
edge** on its shipped laps and asserts it **never** leaves the road across the
whole upgrade sweep.

Every tier picks the strategy that is actually fastest on your car: a
`drift: "auto"` bot races its whole derived plan, each half of it and its own
clean line, and keeps the quickest (see *Strategy selection*).

The flying laps are 1.2-1.9 s quicker than the standing lap, which is the
whole point of racing three of them. The side panel ("Bot best lap") shows
each tier's best **flying** lap, since that is the like-for-like comparison
against your own laps 2 and 3; hover a time to see its standing lap too.

They earn nothing - they are pure pace references. The whole field grids up F1
style (player on pole, the five bots on slots 1..5 further back) and holds until
GO: the countdown reaches zero and **everyone launches together with no player
input required**, a fair standing start that tests acceleration equally. Each
bot then loops its flying lap endlessly. Toggle them with **G**.

### The grid + countdown loop

The START menu's GO (or **R** at any time) re-grids the field and runs the
3‑2‑1‑GO countdown; at GO everyone launches and laps forever. Nothing about the
economy is touched by a re-grid: your ranked laps, the earning ghosts and the
credit loop carry straight through, and the endless lap tally simply resets.

### Drift zones are derived, not hand-written

PRO+'s drift zones used to be hand-tuned arc-length fractions for this exact
circuit. They are now produced by `deriveDriftZones(params, skill)` in
`bots.js`, from track curvature plus the car's own physics constants. Every
threshold in `DRIFT_TUNING` is a dimensionless ratio or a physics quantity;
none is a position on this track.

1. **Find the corners.** Signed Menger curvature along the centerline, with
   hysteresis, gives maximal same-direction runs where the radius drops below
   8 road half-widths. The curvature's sign becomes the zone's steer direction,
   so a mirrored map just flips it.
2. **Classify each corner by GEOMETRY, never by top speed.** A corner whose
   racing-line radius is under 3 road half-widths is a switchback and gets a
   short part-throttle **entry flick** (rotation aid + entry-speed cue); every
   other corner is a candidate for a full charging **slide**. This used to be
   a "corner speed as a fraction of top speed" test, and that was a bug with a
   receipt: buying five levels of Top Speed reclassified the sweeper from fast
   to slow, PRO+ silently lost its only charging zone, and the drift-boost
   advantage evaporated. Geometry does not move when the player goes shopping.
3. **Check the slide is physically possible.** A slide's path turn rate is
   `latGrip * driftGrip * sin(slip)`, so a slide follows a corner of radius r
   at exactly one speed per steering angle: `v = r * rate(steer)`. That pins a
   charging slide's speed into a window - too slow and the steering needed to
   hold the arc drops below the charge-qualifying slip, too fast and no amount
   of lock holds the arc. A zone is only planned if the window is non-empty,
   the corner is long enough to bank its tier, and enough usable track
   follows to spend the boost. All of it moves the right way with every
   upgrade.
4. **Pick the tier deliberately.** The corner's own length *in seconds at the
   slide's speed* decides whether the zone targets tier 1 or tier 2, and the
   driver releases the moment that charge is banked. Sizing the zone in
   *distance* instead meant the tier depended on how fast the car happened to
   sweep through it - buying acceleration could drop PRO+ from a tier-2 boost
   to a tier-1 one and cost it half a second.
5. **Hold the slide's speed, don't floor it.** Throttle inside a slide targets
   the planned slide speed. Flooring it widens the arc (see the identity in
   step 3) and walks the car off the road, so more acceleration used to mean
   progressively wrecked drifts.
6. **Release where the boost can run.** The slide sits at the *end* of the
   corner: the boost fires on release, and a boost fired mid-corner is braked
   straight back off because the corner itself is the speed limit.

On EMBER LOOP the derivation picks a slide through the last third of each of
the two loops and nothing else; on LONGSHORE SPEEDWAY and LANTERN COIL it finds
no corner long enough to bank a charge in and plans nothing at all, at any
upgrade level.

### Strategy selection

A derived plan is a *prediction* about a car the analyser has never driven.
Rather than trust it, a `drift: "auto"` bot **races its options** —
`raceBest()` simulates the full plan, the slides only, the flicks only and the
clean line, and keeps whichever was actually quickest. Four races instead of
one (~50 ms) buys a hard guarantee: PRO+'s lap time is a minimum over a set
that always contains its clean line, so a drift plan that stops paying on some
exotic spec costs nothing at all.

**On the road first, then fast.** The fastest strategy only counts if it stayed
inside the road edge — measured to the car's centre, with its own half-width
(6 px) as the allowance, so clipping the kerb is fine and driving beside the
track is not. **Runoff counts as off the road here**: the concrete exists to
forgive the *player's* mistakes, not to widen the bots' racing line, and a
reference ghost that habitually rides the skirt is a bad example as well as a
worse lap. If nothing stays on the road the fastest run is still returned, so a
bot never simply fails to grid up.

That filter is not decoration. Whether an off-road slide "works" turns on a few
pixels, so without it one extra upgrade level could swap a 5.4 s off-road drift
for a 6.0 s clean lap and read as *an upgrade making the bot slower*: five of
the monotonicity violations that appeared while rebalancing Top Speed were
exactly this, and preferring on-road strategies removed all five by making lap
time a smooth function of the car again.

### Bots on an upgraded car — the invariants

Because the bots mirror your spec, the controller has to work across the whole
upgrade curve, not just the stock car. Two properties are now *asserted*, at
every sampled combination of the **driving** upgrades (Top Speed, Acceleration,
Grip, Boost Power, Boost Duration; Lap Payout and Ghost Fleet are economy only
and are excluded by construction):

- **(a) Ordering** — `proplus < pro < mid < novice` on best flying lap.
- **(b) Monotonicity** — buying one more level of *any* driving upgrade never
  makes a bot slower.

What had to change in the controller to get there:

- **Steering is a physical pure-pursuit law, not a raw P-gain.** The command is
  the yaw rate needed to reach the aim point (`2 v sin(err) / L`) divided by
  the yaw rate the car can currently produce (`min(maxTurn, maxLatAccel / v)`),
  times a dimensionless aggression multiplier. The old `steer = gain * err`
  had no idea what car it was driving: PRO's gain of 9 saturated at full lock
  within 6° of error, so on a quick car the *more* aggressive tunes steered
  bang-bang, overshot every apex and finished behind the softest one. **That is
  what fixed the Lv 20 MID-beats-PRO inversion.**
- **Corner entry is planned as a reaction TIME, charged against current
  speed.** A tune's `brakeMargin` (px at the stock car) is really
  `brakeMargin / 280` seconds; the margin distance is that time times the speed
  the car is doing *right now*, plus its decision delay. The old version scaled
  a fixed px margin by *top speed*, so a bot that is hairpin-limited to 200 px/s
  braked ever earlier for a corner it arrived at no faster. **That is the core
  of the Top Speed regression fix.**
- **The aim point may stretch with speed, bounded by the curvature it spans.**
  The look-ahead cap is the larger of 140 px and half a second of travel, then
  clamped by the chord bound `sqrt(8 R ROAD_HALF)` computed over the *whole
  look-ahead span* rather than at the car (on a straight approach the local
  curvature is zero, so the old local bound was infinite and a long aim point
  planted itself across the apex).
- **Corner speed respects a yaw-rate budget and a racing line.** `v <= 0.85 *
  maxTurn * r_eff` with `r_eff = 1/k + 0.2 * ROAD_HALF`: planning to use 100%
  of the steering authority leaves nothing to correct with.
- **Throttle and brake are proportional, not bang-bang.** A threshold
  controller makes the lap a step function of the car's parameters — one corner
  flips between "just made it" and "had to brake" and the lap time jumps
  several percent for a 1% spec change, which reads exactly like an upgrade
  making the bot slower. This alone removed most of the residual violations.
- **The reaction-limited pace cap now grants 25% of an upgrade's extra top
  speed** instead of being a hard constant, so a slow-reacting driver still
  gains something (a strictly worthless upgrade sits one simulation wobble away
  from a harmful one).

Two changes were made *outside* the bot, both because the alternative was a
physics rule that punished an upgrade:

- **The boost's speed gates are absolute px/s** (118 charge / 98 fire) instead
  of fractions of top speed. Tying them to top speed meant buying Top Speed
  could stop you charging a drift you already knew how to do.
- **The drift is anchored against the Grip upgrade**: `driftGrip` scales as
  `(11 / latGrip)^0.85`, so a slide's path turn rate goes 1.97 -> 2.3 rad/s
  from Lv 0 to Lv 20 instead of 1.97 -> 5.6, which no corner on the map can
  follow. Unanchored, buying grip turned the handbrake into a way to spear the
  inside kerb and made PRO+ slower than PRO.
- **Braking overrides the boost shove** (it does not cancel the burst, it just
  stops pushing). The shove is 880 px/s² against 400 px/s² of brakes, so a lit
  boost used to be impossible to slow down for the next corner — and a *longer*
  or *stronger* boost was therefore a good way to get carried off the road.

Only one upgrade definition needed changing: **Top Speed now also grants
+2.6%/level of braking force** (Acceleration already granted +8%/level). A car
with three times the top speed and the same brakes is genuinely worse at every
corner on the circuit, and no amount of bot cleverness makes that false.

`node test/drive_bot.mjs` prints a sweep table per track and gates both
invariants on each; at the time of writing it reports **0 ordering violations
and 0 monotonicity violations** across all three (197 simulated specs on Ember,
85 on each of the other two).

One bot-side fix was needed for the boost upgrades to mean anything. The
throttle controller drives at `min(topSpeed, paceCap, cornerLimit)` — so the
instant a drift boost fired and pushed the car past its top speed, the bot saw
"we are over the limit" and **braked**, and because braking also cancels the
boost shove (physics.js), it threw away the burst it had just earned one tick
after it arrived. Boost Power measured as worth **0.00%** on every track. The
cap the controller drives at is now the *boosted* one while a burst is lit
(corner limits are untouched — a boosting car still slows for the next corner),
after which Boost Power/Duration are worth 9.5% a lap on the drift circuit.

## Code layout

- `physics.js` — pure car physics: `stepCar(state, inputs, params, dt)`.
  No DOM. Steering is input-smoothed (~145 ms ramp to full lock, faster
  return-to-center) and curvature-limited (yaw rate capped by a lateral-
  acceleration budget, so high speed is inherently stable, not twitchy).
  Lateral slip is first-order damped: releasing the wheel settles the car
  without fishtailing, and drift recovery can never spin out. While the
  handbrake is held at speed, a **drift stabilizer** takes over steering:
  the stick selects a target slip angle (~34° at full lock) and a soft
  P-controller yaws the nose toward it, so a held drift carves a
  predictable arc (~25° settled slip), released steering straightens the
  slide, and countersteer visibly tightens it — first-order, no overshoot,
  no spin. A steady full-lock slide turns the car's *path* at
  `latGrip * driftGrip * sin(driftSlipTarget)` rad/s regardless of speed —
  v3 raises that to 1.97 rad/s against grip steering's 1.85 rad/s cap, so
  drifting genuinely out-rotates gripping (in v2 it never could, which is
  why the drift line only ever cost time). Acceleration is deliberately
  unhurried (0 to 90% of top speed in ~2.7 s) so the drift boost is worth
  earning; the boost charge/fire state machine (charge requires genuine
  cornering and decays 2.5x faster than it builds when conditions drop) and
  the brake-stop/reverse gate live in the car state (fully deterministic).
  **Three surfaces**, taken as `inputs.surface` (0 road / 1 concrete runoff /
  2 grass; the old boolean `offRoad` is still honoured and means grass): each
  is a speed-cap multiplier plus an extra drag term, so adding a fourth would
  be two numbers. Also home to **the shop** — `UPGRADE_DEFS`, `upgradeCost()`
  and `levelsForBudget()` — because the acceptance harness has to *price*
  upgrades as well as apply them, and a price list that lived only in `main.js`
  would have made the value-per-credit gates impossible to measure. `main.js`
  imports it and adds nothing but DOM. The Top Speed / Boost Power / Boost
  Duration effect curves (`speedBonus`, `boostPwrBonus`, `boostDurBonus`) are
  soft caps rather than straight lines — see *[The Top Speed
  rebalance](#the-top-speed-rebalance)*.
- `track.js` — **the multi-track module**: three track *definitions* plus the
  builder that turns one into everything the game and the bots need. No DOM.
  - A definition is a closed path of straights and arcs
    (`["s", 336, "the start straight"], ["a", 150, -160, "turn 1, the
    horseshoe"], …`) plus a road width, a start point, checkpoint positions
    (`[segmentIndex, fractionAlongIt]`) and, for free, **sector names** — any
    named segment becomes a sector, which is how the harness can report that
    PRO's slowest point was "turn 1, the horseshoe".
  - `buildTrack(def)` walks that path dropping a control point every ~30 px
    (tighter inside small-radius arcs), smooths it with Catmull-Rom into a
    centerline, then derives cumulative arc length, the start/finish gate and
    grid slot, the checkpoint gates, the sectors, the broad-phase collision
    grid behind `distToTrack`, and a `TRACK_SIGNATURE` that includes the
    track's id — which is what makes the bot-field cache in `bots.js` key
    correctly per circuit.
  - ...and **the concrete runoff**, derived from the same curvature data:
    two per-centerline-point width arrays (one per side), the renderable band
    polygons `main.js` fills, and `surfaceAt(x, y)` / `probe(x, y)`, which
    answer "where am I and what am I standing on" in a single nearest-point
    search — this is the hottest function in the whole simulation, so
    `distToTrack` is a thin wrapper over the same call and the two can never
    disagree about where the edge of the road is. See *[Where the runoff comes
    from](#where-the-runoff-comes-from)*.
  - **The gate rules** live here too: `crossedGate` (directional, used for the
    start/finish line only), `crossedGateEither` (used for checkpoints) and
    `advanceLap`, which tests only the *next* checkpoint so bidirectional
    crossings cannot be farmed. Checkpoint gates are widened asymmetrically at
    build time — far on the outside of the corner, barely at all on the
    inside.
  - **One track is active at a time**, and the module-level exports (`CENTER`,
    `N`, `ROAD_HALF`, `CHECKPOINTS`, `START_GATE`, `TRACK_SIGNATURE`, …) are
    ES module **live bindings** onto it, with the query functions
    (`distToTrack`, `curvatureAt`, `nearestIndex`, `advanceLap`, …) delegating
    to it. So `setTrack(id)` is the entire switching mechanism: every importer
    — `main.js`, `bots.js`, the harness — sees the new circuit the instant it
    returns, with no per-call track argument and no re-import. Built tracks are
    cached, so switching back is O(1).
- `main.js` — game glue: input, rotating follow camera (forward-is-up,
  smoothed rotation lag, big velocity look-ahead, speed-scaled zoom
  ~1.7x-1.45x, subtle drift kick + boost pulse), north-up corner minimap,
  tier-colored tire marks, boost flames, the **concrete runoff bands** (filled
  from `track.js`'s derived polygons, drawn *under* the road edge line so the
  edge still reads as the boundary of the racing surface; the minimap
  deliberately shows the road only, since at ~0.05x scale a 30 px skirt is
  noise), HUD (including the endless *Laps* tally, the two-tier surface warning
  and the on-canvas 3‑2‑1‑GO countdown), the **start menu** overlay + countdown
  state machine (`phase: menu | countdown | racing`), the **track selector /
  unlock** and `switchTrack()` / `tryUnlock()` (swap the geometry, re-fit the
  minimap, re-simulate the field, re-grid + count in), the **state split** —
  global `{ credits, drivingLevels, currentTrack, unlocked }` and per-track
  `state.tracks[id] = { rankedLaps: [{ticks,samples}], ghostHeads, lapPayoutLvl,
  ghostFleetLvl }` — and the ranked-ghost economy over it (your own lap payout;
  every unlocked track's fleet paying at once, each ghost on its own ranked
  lap), localStorage save (v6, currently behind `PERSISTENCE = false`), and bot
  reference ghost simulation + endless-loop playback (via `bots.js`), rendering
  + G toggle.
- `bots.js` — the bot drivers, imported by BOTH the game and the harness (so
  what the harness gates is exactly what you race). Skill presets (novice /
  average / expert / pro / proplus / proplusplus); `pursuitSteer()`, the physical
  pure-pursuit steering law (demanded yaw rate / available yaw rate x the
  tune's aggression); the corner planner with its reaction-TIME braking
  margin, yaw-rate budget, racing-line widening and reaction-limited pace
  cap; `deriveDriftZones()` + `findCorners()`, the automatic corner analysis
  that replaces PRO+'s hand-written drift zones (tunable via the
  `DRIFT_TUNING` object); `planVariants()` / `raceBest()`, which race a drift
  plan against the clean line and keep the quicker *of those that stayed on
  the road*; the telemetry lap runner;
  and
  `recordRace(skill, params, {laps, start})` — the standing-start recorder that
  drives from rest at a grid slot (`start`, default the pole) through
  consecutive laps, samples every tick, returns per-lap times plus per-lap and
  whole-run telemetry (brake ticks, the slowest point, handbrake/boost use, so
  the harness can prove the clean line is not flat out), and returns `null` if
  any lap is invalid. On top of that, `simulateBotField(params)` /
  `botField(params)` produce the whole five-tier reference field for a given car
  — each bot started from *its own F1 grid slot* (`T.gridSlot(1..4)`) so the
  launch spreads the field — memoised on (car spec + `TRACK_SIGNATURE`) in an
  8-slot LRU so re-grids are free, only an upgrade purchase re-runs the physics,
  and flipping back to a circuit you were just on is instant.
- `decor.js` — **purely cosmetic** world scenery: a dense **forest band** hugging
  a **grass corridor** around the track, with clearings, lakes, rocks, bushes and
  flowers. Generates a track's decoration from its centerline + bounding box +
  `distToTrack` and a seeded PRNG keyed on `TRACK_SIGNATURE`, cached per
  signature; no DOM
  (`main.js` owns the viewport-culled draw). No physics: it never touches the
  road or the cars. See *[World / scenery](#world--scenery)*.
- `test/drive_bot.mjs` — headless bot-driver test harness (acceptance).

There is no `bot_ghosts.json` and no ghost exporter any more: the game
simulates the field itself, so there is nothing to regenerate after a physics
or track change and nothing that can go stale.

## Automated handling tests

```
node test/drive_bot.mjs            # novice/average/expert/pro/proplus bots,
                                   # telemetry, PASS/FAIL acceptance criteria
node test/drive_bot.mjs baseline   # also measures the old v0 physics for
                                   # a before/after comparison
node test/drive_bot.mjs sweep      # grid-search key handling constants
```

Bots drive with pure-pursuit steering plus corner-speed anticipation. Skill
presets vary look-ahead, reaction delay, steering noise (seeded PRNG —
deterministic runs), and throttle discipline; novice and average emulate
digital keyboard input. Reported telemetry per run: lap completion rate,
best/mean lap, % ticks off-road, wobble index (steering-direction reversals +
yaw-rate zero-crossings per second), peak/RMS lateral g and traction-circle
utilization (assumed scale: 10 px = 1 m).

Beyond the bot laps, the suite runs six scripted feature tests:

- **drift boost** — drive to speed, hold a 1 s handbrake drift, release,
  floor it: must bank tier 1, peak ≥ +25% over top speed, and settle to
  < 10° slip within 0.6 s
- **drift control** — constant full steer + handbrake at speed: slip must
  settle into the 15–40° band (never past 55°) for 1.5 s; releasing steer
  (handbrake still held) must decay slip below 10° within 0.8 s with no
  sign-flip oscillation
- **exploit: straight-line handbrake** — 2 s handbrake hold at speed going
  straight must bank no charge and must mostly coast (≥ 75% of plain-coast
  speed: the handbrake is not a brake)
- **exploit: handbrake stop** — bank a genuine tier-1 charge, then brake to
  a standstill with the handbrake held: the charge must bleed away and no
  boost may fire on release
- **brake gate** — from top speed, hold brake: must reach a full stop and
  hold it ≥ 0.3 s before reverse engages
- **the three surfaces** — flat out for 6 s on each: the concrete runoff must
  settle strictly between road and grass, at ≥ 85% of road speed (it is at
  92%), grass must stay under 45% (it is at 30%), and running wide onto the
  concrete at speed must cost under 10% in the first second

Design gates lock in the balance and fail loudly if a future change undoes
it. **The friendliness / ladder / sweep / differentiation gates run on the three
designed tracks** (the physics scripts are track-independent, so they run once),
against simulated standing-start recordings; the **fourth circuit, Cape Cruise,
is exempt** from the differentiation gates and gets its own small check set (see
*[Cape Cruise](#exempt-from-the-differentiation-gates--and-the-economy-caveat)*).
The suite is **147 checks in ~42 s** and prints a per-track bot table, a
per-track summary, the per-track runoff and cutting report, three sweep tables,
the upgrade-sensitivity table, the value-per-credit table and the Cape Cruise
summary. It also carries light checks on the endless-model
plumbing — the F1 grid slots are distinct, ordered pole→5th and on-road on
every circuit, **and the five bots' actual simulated recordings begin at their
assigned slots (1..4), mutually distinct** (so a "computed but unused" grid
regression can't recur); ranked-lap insertion stays sorted and capped; and the
Ghost Fleet buy-gate math never lets the fleet exceed the recorded-lap count —
all kept *out* of the driving sweep because none of it affects how the car
drives.

- **casual-friendly everywhere** — on every circuit the timid keyboard NOVICE
  must complete ≥ 8/10 valid laps with < 6% of its ticks off-road and a wobble
  index under its per-track budget (currently 10/10 and 0.00% on all three)
- **the clean line lifts** — PRO's race must contain braking ticks and its
  slowest *flying-lap* point must drop below a **per-track** fraction of top
  speed: 85% on Ember (measured 73%, at the horseshoe), 75% on Lantern
  (measured 62%, at turn 5) — and merely "it brakes at all" on the speedway,
  where a near-flat-out lap is the entire design intent (measured 95%)
- **the drift line pays — where it is meant to** — on Ember, PRO+ must
  genuinely drift (≥ 1 boost per valid lap) and its standing lap must beat
  PRO's by ≥ 0.6 s *and* ≥ 6% (it beats it by 1.30 s / 11.7%). On the speedway
  and the coil no corner is long enough to bank a charge in, so demanding a
  drift there would be demanding the wrong thing: the gate becomes "PRO+ still
  leads *without* needing a boost to do it"
- **the tracks reward different upgrades, per credit** — the nine
  value-per-credit gates described under *[The proof that they
  differ](#the-proof-that-they-differ--measured-per-credit)*, plus four
  per-level sensitivity gates that survive from the old set (Grip must beat Top
  Speed on the coil and lose to it on the speedway; the boost upgrades must pay
  ≥ 3% on Ember and ≥ 3x more there than anywhere else; the drift line must pay
  most on Ember)
- **the gate rules** — six gates per circuit: a lap with one checkpoint taken
  *backwards* is valid; the checkpoint gates reach well past the road edge
  (and a crossing at their far tip, off the racing surface, registers); and
  three exploit regressions — shuttling over one gate never advances past it,
  reversing back over the finish line and re-crossing it scores an *invalid*
  lap, and taking the checkpoints in reverse order does not validate a lap
- **cutting cannot pay** — on every circuit, the *shortest gate-legal path*
  (solved by coordinate descent over where each gate is crossed) driven by a
  cheater with no cornering limit at all must still be slower than PRO's real
  clean lap. Measured: 22.0 s vs 9.78 s, 33.5 s vs 12.75 s, 21.5 s vs 10.83 s
- **the runoff is at the corners** — checked from the derived width arrays,
  not from the derivation: every skirt must peak at a real corner and sit on
  the *outside* of it, at least a quarter of the lap must have no concrete at
  all, and each circuit must have some (≥ 10% of the lap)
- **the concrete makes it gentler, never harsher** — the NOVICE bot must never
  reach the grass at all on any circuit (it does not: 0.00% off-road
  everywhere, which the concrete can only improve on)
- **the endless field loops valid laps** — every reference bot must string
  consecutive *valid* laps together (all checkpoints, in order, every lap) on
  every track, which is what the game loops forever
- **flying laps are real** — every bot's flying lap must be faster than its
  gridded standing launch, and the tier ladder must hold on best flying lap as
  well as on total time
- **on-road margin** — the whole standing-start race must stay ≥ 8 px (PRO) /
  ≥ 3 px (PRO+) inside the road edge, so no re-tune can buy time by scraping
  grass or by holding together for only one lap
- **the upgrade-space sweep, on every track** — because the bots race your
  upgraded car, the field is re-simulated across a sample of the whole
  **driving**-upgrade space (`speed, accel, grip, boostPwr, boostDur`; Lap
  Payout and Ghost Fleet are economy only and never enter this regime). The
  sample is each upgrade alone at Lv 3/7/12/20, a set of mixed edge cases (one
  stat maxed with the rest near zero, all-high, all-max) and a seeded random
  sample — plus, for every one of them, all five +1 neighbours. The **full**
  grid (197 distinct specs, ~15 s) runs on Ember, the only circuit where the
  corner analyser plans drift zones and therefore the one with the most ways to
  break; a **reduced** grid (85 specs, ~7 s each) runs on the other two, still
  covering every upgrade alone at Lv 7/20 plus the extremes. Three gates per
  track:
  - every bot strings 3 valid laps at every combo,
  - **ordering** `proplus < pro < mid < novice` at every combo,
  - **monotonicity**: no +1 level of any driving upgrade makes any bot slower.

  Deterministic tunes (MID/PRO/PRO+, `steerNoise ~ 0`) are held to 1%; NOVICE
  is a deliberately sloppy driver with a ~1.5-3% per-seed spread, so its time
  is the **median of 7 seeds** (raised from 5 when the fourteen-corner coil
  turned out to move a five-seed median ~1% on its own) and its tolerance is
  3%. Every violation is
  printed with its combo, tier and upgrade — `12,1,7,18,11: proplus got SLOWER
  buying accel (Lv 1->2): 7.35s -> 7.72s (+5.0%)` — so a regression names
  itself. A separate gate still checks that uniform Lv 7 and Lv 14 cars make
  *every* tier faster than stock, so "monotone" cannot be satisfied by a
  controller that ignores the car

## Current features (v6)

- **Four hand-authored circuits**, each defined as a path of straights and
  arcs and built into a Catmull-Rom centerline + gates + sectors + collision
  grid at load, with three friendly surfaces (no hard walls) and a live-binding
  "active track" so switching is one `setTrack()` call:
  **EMBER LOOP** (2 344 px, two slideable 160° loops each onto a long straight
  — the boost track), **LONGSHORE SPEEDWAY** (3 473 px, long straights and four
  flat-out double-apex corners — the top-speed track), **LANTERN COIL**
  (2 222 px, seven linked medium-speed corners with no straights — the grip
  track), and **CAPE CRUISE** (27 607 px, a ~1.7-minute organic scenic coastal
  loop of gentle sweepers and occasional straights — a chill cruise with *no*
  dominant upgrade, exempt from the differentiation gates; see
  *[Cape Cruise](#cape-cruise-the-fourth-circuit)*). **Ember and Cape Cruise are
  unlocked from the start; Longshore (4,000 cr) and Lantern (15,000 cr) are
  one-off credit unlocks** shown with a 🔒 and their price in the selector. The
  bot field, the ranked best laps, the earning ghosts and the per-track economy
  are all per track
- Arcade car physics at a fixed 60 Hz timestep: smoothed speed-sensitive
  steering, damped lateral slip, unhurried acceleration (~2.7 s to 90% of
  top speed), handbrake drift with fading tire marks and a slip-angle
  stabilizer (steering selects the drift arc; drifts are carve-able and
  can't diverge)
- Mario-style drift boost: sustained *cornering* slides bank a two-tier
  charge (blue +28% for 1.1 s / orange +45% for 1.7 s on release, with an
  880 px/s² shove and a gentle 260 px/s² bleed-off afterwards); no penalty for
  short drifts. Charging demands handbrake + slip + yaw + steering into the
  turn + speed above 42% of top; failing any condition decays the charge
  2.5x faster than it builds, and releasing below 35% of top speed fires
  nothing — so straight-line slides, steering wiggles and handbrake stops
  can't farm boosts. Boost is deterministic, inside `stepCar`, so ghosts
  replay it
- **Start menu + countdown + endless racing**: a dark START overlay (title +
  GO) over the canvas; GO runs a 3‑2‑1‑GO countdown and the whole field launches
  from the F1 grid automatically at GO, **with no player input required**. After
  that the player laps freely forever while the bots loop, and the side panel's
  *Laps* row is an endless tally. R re-grids and re-runs the countdown
- **F1 grid start**: player on POLE, then NOVICE/MID/PRO/PRO+ on slots 1..4,
  each further back along the start straight (slots derived from track geometry,
  walked backward along the centerline so they stay on-road on every circuit).
  Each bot's run starts from *its own slot*, so the standing launch spreads the
  field into an F1 stagger naturally
- Bot reference ghosts: a five-tier skill ladder, **re-simulated per circuit**
  — on Ember, NOVICE (green, timid, 12.03 s flying on the stock car), MID
  (purple, clean line, no drift, 10.23 s), PRO (cyan, the optimal clean lap,
  never drifts, 9.78 s) and PRO+ (gold, slides both loops and fires the banked
  boost onto the straights, ~8.4 s); comparable ladders on Longshore and
  Lantern. Each plays its standing launch from the grid once, then **loops its
  flying lap forever** as the pace reference — translucent labeled ghosts with
  minimap dots and side-panel best-flying-lap times; toggle with G. **Simulated
  live in the browser** on your current upgraded car (50–140 ms for the field),
  so their times move when you buy an upgrade; PRO+'s drift zones are derived
  from track curvature rather than hand-placed
- Brake gate: holding brake stops and holds the car; reverse needs a
  deliberate re-press or a 0.35 s hold at standstill
- Rotating follow camera: forward is up, car sits below screen center,
  rotation tracks your direction of travel with a natural lag, so the car —
  not the world — swings during a drift; falls back to the heading at low
  speed and in reverse (never flips). Speed-scaled zoom (wider view the
  faster you go), long velocity look-ahead, plus subtle juice: a small
  spring-return kick on drift start, a slip-proportional see-through-the-
  corner bias, and a brief zoom-out pulse when a boost fires. North-up
  corner minimap with a heading arrow (track outline, player and ghost)
- **Three surfaces, all driveable**: tarmac, a **concrete runoff skirt**
  derived from track curvature and placed F1-style on the outside of the
  demanding corners (92% of road speed — leeway, not a penalty), and grass
  (30%). No gravel, no traps, no walls
- Lap validation via **bidirectional but strictly ordered** checkpoint gates
  that reach far past the road edge on the outside of the corner and barely at
  all on the inside, plus a **directional** start/finish line so a lap can
  never be completed by reversing over it
- Ghost recording/playback (per-tick position + angle samples), per track
- **Ranked-ghost economy**, per track: each circuit keeps your best distinct
  valid laps fastest-first (capped at 12). Ghost #1 replays your best, #2 your
  2nd best, ..., each looping its own recording and earning on its own lap time
  (`round(720 / lapSeconds) x payoutMult`), staggered around the lap. Driving a
  valid lap also pays you `x2.5` directly. **Every unlocked track's fleet earns
  at once**, so unlocking maps grows total income; *Ghost payout* is this
  track's ghost #1, *Income* is all unlocked tracks summed
- **Upgrades — global car vs per-track economy**, with geometric cost growth:
  - *driving (GLOBAL — the car; the bots inherit it)* — **Top Speed** (90 cr,
    **x1.95/lvl**: a soft-capped top-speed bonus, +10% at Lv 1 rising to +48% at
    Lv 8, plus 26% of that in brakes), **Acceleration** (40 cr, x1.6: +12%
    accel, +8% brakes), **Grip** (45 cr, x1.5: +1 handling), **Boost Power**
    (25 cr, **x1.3**: +14%/lvl to both drift-boost tiers), **Boost Duration**
    (20 cr, **x1.3**: +14%/lvl of boost time)
  - *economy (PER TRACK)* — **Lap Payout** (60 cr, x1.7: x1.3 credits/level on
    this track) and **Ghost Fleet** (400 cr, **x7/lvl**: +1 earning ghost on
    this track). **Ghost Fleet is buy-gated**: you can only buy the next level
    once you have another distinct recorded lap here to fill the new ghost, even
    if you can afford it (the button greys with a *set another lap time* hint).
    The panel labels the two groups *Car — global* and *This track*
- localStorage save/load, **schema v6** (credits, global driving levels,
  unlocked set, current track, and per-track `{ lapPayoutLvl, ghostFleetLvl,
  rankedLaps: [{ticks,samples}] }`) — **currently DISABLED behind `const
  PERSISTENCE = false` for prototyping**: a refresh resets everything and any
  `trackcrimental_*` key is cleared at boot
- Headless bot-driver harness with F1-style telemetry, **147 acceptance gates
  (~42 s)** covering all four circuits (the three designed ones in full, plus a
  small exempt check set for Cape Cruise): scripted drift-boost / drift-control /
  exploit-regression / brake-gate / three-surface feature tests, per-circuit
  gate-rule and cut-the-corner regressions, runoff placement checked from the
  derived width arrays, per-track upgrade-space sweeps asserting bot ordering
  and per-upgrade monotonicity over ~370 simulated car specs, a
  **value-per-credit** table, and light checks on the endless-model plumbing
  (F1 grid slots distinct/ordered/on-road *and the actual bot recordings
  starting at their slots*; ranked-lap insertion sorted+capped; the fleet-buy
  gate math) — the economy is kept *out* of the driving sweep because it does
  not affect how the car drives
