# Trackcrimental

Incremental top-down 2D time-trial racer prototype. Drive laps to set a best
time; your best lap replays forever as a ghost that earns credits, which buy
car upgrades so you can drive an even faster lap.

**Three circuits**, each built so a *different* upgrade is the dominant lever:
EMBER LOOP rewards the drift boost, LONGSHORE SPEEDWAY rewards top speed,
LANTERN COIL rewards grip. That is measured, not asserted — see
*[The three circuits](#the-three-circuits)*.

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

The save/load code is intact and correct (**schema v5**: the selected track
plus a `{ trackId: { bestTicks, ghostRec } }` map, so per-track records and
ghost recordings round-trip; unknown track ids in a save are ignored, and a
track with no entry simply starts blank). Flip the one constant back to `true`
and saving works exactly as before — this was verified by flipping it, setting
laps on two circuits, reloading, and flipping it back.

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
- **R** — re-grid: car back on the start line, bot ghosts re-parked, the
  3-lap race restarted (aborts the current lap). Finishing all three laps
  re-grids you automatically, so R is only for abandoning a race early
- **G** — toggle the NOVICE/MID/PRO/PRO+ bot reference ghosts
- **Mouse scroll wheel** (over the track) — zoom out to survey most of the
  track, or back in (reset by a refresh while persistence is off)
- **Track buttons** (top of the side panel: Ember / Longshore / Lantern) —
  switch circuit. The bot field is re-simulated for that track (cached per
  track, so flipping back is instant), the race is reset to the grid, and the
  panel shows that circuit's own best lap and ghost payout

## How it plays

**A race is three laps.** Cross the start/finish line to begin lap 1 — the
side panel's "Lap" row counts you through `1 / 3`, `2 / 3`, `3 / 3`. Each lap
must hit every checkpoint gate in order (4 gates on Ember and Longshore, 7 on
Lantern; skipping one invalidates that lap, which then doesn't count toward the
race) — though the gates are generous about *how* you hit them, see
*[Checkpoints](#checkpoints-bidirectional-wide-and-still-uncuttable)*. After three valid laps a race-complete message reports all three lap
times and your best; **R** re-grids everyone and starts a fresh race.

Lap 1 is run from the standing start on the grid, so it carries the
accelerate-from-zero run-up; laps 2 and 3 cross the line already at speed and
are **flying laps**, worth roughly 1.1–1.5 s each over the standing lap. That
is why the panel compares you against the bots' best *flying* laps.

### Getting paid

Two things pay credits:

- **Driving a valid lap yourself.** Every clean lap pays immediately —
  `round(720 / lapSeconds) x payoutMult x 2.5` credits, flashed in the panel
  message (`Lap: 9.83s — +183 cr (best 9.51s)`). The `x2.5` is deliberate:
  the ghost is idle income you set up once, so actually driving the lap should
  beat watching a recording of yourself drive it.
- **The earning ghosts**, which pay `round(720 / lapSeconds) x payoutMult`
  per completed loop, forever.

Whichever single lap is your fastest on a circuit — standing or flying —
becomes **that circuit's** earning ghost if it beats the record there. The full
per-tick recording of that one lap loops continuously; faster ghost laps pay
more per lap *and* loop more often.

**Every track's ghosts keep paying, all the time**, whichever circuit you are
currently driving — only the active track's ghosts are drawn. Setting a first
lap on a new circuit is therefore a permanent income increase, so exploring the
tracks is worth credits rather than costing them. The panel's *Ghost payout*
row is this track's per-loop figure; *Income* is every track's ghosts added up.

**Ghost Fleet** buys more of those earning ghosts, **on every track at once**.
Every extra ghost replays the same best lap and pays the same credits,
staggered evenly around the circuit (ghost *k* starts `k / N` of a lap along),
so income is exactly `N x` the single-ghost rate and arrives in evenly spaced
instalments instead of one lump per lap. They are income and scenery — they
never collide with anything and never earn you a lap time.

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


## The bot ghosts (a 3-lap race, simulated live)

Four translucent **bot reference ghosts** race you over the same three laps,
so you can calibrate "is it just me". They are **not** a baked recording:
`bots.js` simulates each bot's entire 3-lap race headlessly in the browser at
load, and again whenever your car changes, then plays the resulting samples
back. That costs **60-140 ms for the whole four-bot field** (~8,500 pure
physics ticks) and it buys two things a baked file cannot:

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
| gold **PRO+** - the drift bot | 9.85 | 8.45 | 8.45 | 26.75 | **8.45** |

(EMBER LOOP, stock car. Each circuit has its own field: see the per-track
summary the harness prints.)

PRO is a real corner-speed planner: on Ember it brakes for both loops (slowest
flying-lap point 73% of top speed) and keeps a >= 8 px on-road margin. Beating
MID with tidy driving is realistic; beating PRO cleanly is very hard. PRO+
handbrake-slides both loops, banks a charge through each arc and fires the
boost onto the straight that follows - worth **1.30 s (11.7%)** over PRO on the
standing lap.
Watch it for a live demo of where and how drifting pays.

Every tier picks the strategy that is actually fastest on your car: a
`drift: "auto"` bot races its whole derived plan, each half of it and its own
clean line, and keeps the quickest (see *Strategy selection*).

The flying laps are 1.2-1.9 s quicker than the standing lap, which is the
whole point of racing three of them. The side panel ("Bot best lap") shows
each tier's best **flying** lap, since that is the like-for-like comparison
against your own laps 2 and 3; hover a time to see its standing lap too.

They earn nothing - they are pure pace references. All five cars share the
same grid spot: the bots sit parked at your spawn, behind the line, until you
first touch any drive control - then everyone launches together from a dead
stop, a fair standing start that tests acceleration equally. Each bot drives
its whole simulated 3-lap race once and then holds parked at the finish (no
looping). Toggle them with **G**.

### The race loop

Crossing the line starts lap 1. When you complete the third valid lap the race
**ends and re-grids you automatically**: the car is put back on the start grid
at a dead stop, the three lap times and your best are shown, and the next race
is armed. Nothing starts until you touch a control again - same standing-start
rule as before, so the clock begins as you cross the line. **R** does the same
thing at any time, abandoning a race in progress.

None of this touches the economy: the earning ghost, your best lap and the
credit loop are unchanged by a re-grid, and the best *single* lap of any race
still becomes the ghost.

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
  noise), HUD (including the `Lap n / 3` race counter, the two-tier surface
  warning and the race-complete summary), the **track selector** and
  `switchTrack()` (swap the geometry, re-fit the minimap, re-simulate the
  field, re-grid), the **per-track state** (`state.tracks[id] = { bestTicks,
  ghostRec, ghostIndex }` — best lap, earning-ghost recording and playhead all
  belong to the circuit they were set on) and the economy over it (your own lap
  payout; every track's ghost fleet paying at once), localStorage save (v5,
  currently behind `PERSISTENCE = false`), the automatic re-grid when a race
  finishes, and bot reference ghost simulation (via `bots.js`), rendering +
  G toggle.
- `bots.js` — the bot drivers, imported by BOTH the game and the harness (so
  what the harness gates is exactly what you race). Skill presets (novice /
  average / expert / pro / proplus); `pursuitSteer()`, the physical
  pure-pursuit steering law (demanded yaw rate / available yaw rate x the
  tune's aggression); the corner planner with its reaction-TIME braking
  margin, yaw-rate budget, racing-line widening and reaction-limited pace
  cap; `deriveDriftZones()` + `findCorners()`, the automatic corner analysis
  that replaces PRO+'s hand-written drift zones (tunable via the
  `DRIFT_TUNING` object); `planVariants()` / `raceBest()`, which race a drift
  plan against the clean line and keep the quicker *of those that stayed on
  the road*; the telemetry lap runner;
  and
  `recordRace(skill, params, {laps})` — the 3-lap race recorder that drives
  from rest at the grid through three consecutive laps, samples every tick,
  returns per-lap times plus per-lap and whole-run telemetry (brake ticks,
  the slowest point, handbrake/boost use, so the harness can prove the clean
  line is not flat out), and returns `null` if any lap is invalid. On top of
  that, `simulateBotField(params)` / `botField(params)` produce the whole
  four-tier reference field for a given car, memoised on
  (car spec + `TRACK_SIGNATURE`) in an 8-slot LRU so re-grids are free, only an
  upgrade purchase re-runs the physics, and flipping back to a circuit you were
  just on is instant.
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

Design gates lock in the v5 balance and fail loudly if a future change undoes
it. **Everything below the scripted physics tests runs on all three tracks**
(the physics scripts are track-independent, so they run once), against the
*shipped* 3-lap race recordings. The suite is **120 checks in ~44 s** and
prints a per-track bot table, a per-track summary, the per-track runoff and
cutting report, three sweep tables, the upgrade-sensitivity table and the
value-per-credit table.

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
- **a race is three laps** — every reference bot must string three *valid*
  laps together (all checkpoints, in order, every lap) on every track
- **flying laps are real** — every bot's best flying lap must beat its own
  standing-start lap 1, and the tier ladder must hold on best flying lap as
  well as on total race time
- **on-road margin** — the whole 3-lap race must stay ≥ 8 px (PRO) / ≥ 3 px
  (PRO+) inside the road edge, so no re-tune can buy time by scraping grass
  or by holding together for only one lap
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

## Current features (v5)

- **Three hand-authored circuits**, each defined as a path of straights and
  arcs and built into a Catmull-Rom centerline + gates + sectors + collision
  grid at load, with three friendly surfaces (no hard walls) and a live-binding
  "active track" so switching is one `setTrack()` call:
  **EMBER LOOP** (2 344 px, two slideable 160° loops each onto a long straight
  — the boost track), **LONGSHORE SPEEDWAY** (3 473 px, long straights and four
  flat-out double-apex corners — the top-speed track), **LANTERN COIL**
  (2 222 px, seven linked medium-speed corners with no straights — the grip
  track). A compact selector in the side panel switches between them; the bot
  field, the best lap, the earning ghosts and the records are all per track
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
- **Three-lap races**: lap 1 from the standing start, laps 2–3 flying
  (~1.1–1.5 s quicker). A `Lap n / 3` counter runs in the side panel and a
  race-complete message reports all three lap times plus your best; R
  re-grids and restarts. The economy is untouched — your best *single* lap
  is still the earning ghost
- Bot reference ghosts: a four-tier skill ladder racing the same three laps,
  **re-simulated per circuit** — on Ember, NOVICE (green, timid, 12.03 s flying
  on the stock car), MID (purple, clean line, no drift, 10.23 s), PRO (cyan,
  the optimal clean lap, never drifts, 9.78 s) and PRO+ (gold, slides both
  loops and fires the banked boost onto the straights, 8.45 s, i.e. 1.3 s up on
  PRO); 15.67 / 13.12 / 12.75 / 12.43 s on Longshore and 13.90 / 11.17 /
  10.83 / 10.10 s on Lantern — from a shared-grid
  standing start: parked at your spawn until your first input, then the full
  3-lap race once before they hold at the finish (R re-grids) — as
  translucent labeled ghosts with minimap dots and side-panel
  best-flying-lap times; toggle with G (saved). **Simulated live in the
  browser** on your current upgraded car (60–140 ms for the field), so their
  times move when you buy an upgrade; PRO+'s drift zones are derived from
  track curvature rather than hand-placed
- Automatic race restart: finishing the third lap puts you back on the grid,
  stopped and re-armed, with the three lap times and your best on screen
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
- Economy: **your own valid lap pays too** (2.5x what one ghost loop of the
  same lap length pays, flashed in the panel the moment you cross the line),
  plus credits per ghost loop; income scales with lap speed, and **every
  track's ghosts pay at once**, so a first lap on a new circuit is a permanent
  income increase
- **7 upgrades** with geometric cost growth, applied to the player car (and
  therefore to the bots) instantly; the ghost keeps replaying the old
  recording until you beat it:
  - *driving* — **Top Speed** (90 cr, **x1.95/lvl**: a soft-capped top-speed
    bonus, +10% at Lv 1 rising to +48% at Lv 8 and +67% at Lv 20, plus 26% of
    that again in brakes — deliberately the priciest and the only one with
    diminishing returns, because it is the only one that helps everywhere),
    **Acceleration** (40 cr, x1.6: +12% accel, +8% brakes), **Grip** (45 cr,
    x1.5: +1 handling), **Boost Power** (25 cr, **x1.3**: soft-capped +14%/lvl
    to both drift-boost tiers, so tier 1 goes +28% -> +55% at Lv 8), **Boost
    Duration** (20 cr, **x1.3**: soft-capped +14%/lvl of boost time)
  - *economy* — **Lap Payout** (60 cr, x1.7: x1.3 credits/level) and **Ghost
    Fleet** (400 cr, **x7/lvl**: +1 earning ghost, i.e. a straight income
    multiplier; the extra ghosts are staggered evenly around the lap)
- localStorage save/load (credits, upgrade levels, selected track, **per-track
  best times and ghost recordings**, bot-ghost visibility) — save key v5,
  **currently DISABLED behind `const PERSISTENCE = false` for prototyping**: a
  refresh resets everything and any `trackcrimental_*` key is cleared at boot
- Headless bot-driver harness with F1-style telemetry, **120 acceptance gates
  (~44 s)** covering all three circuits: scripted drift-boost / drift-control /
  exploit-regression / brake-gate / three-surface feature tests, per-circuit
  gate-rule and cut-the-corner regressions, runoff placement checked from the
  derived width arrays, per-track upgrade-space sweeps asserting bot ordering
  and per-upgrade monotonicity over ~370 simulated car specs, and a
  **value-per-credit** table that *measures* each circuit rewarding a different
  upgrade for the same money
