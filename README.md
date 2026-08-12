# Trackcrimental

Incremental top-down 2D time-trial racer prototype. Drive laps to set a best
time; your best lap replays forever as a ghost that earns credits, which buy
car upgrades so you can drive an even faster lap.

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
zero credits, all upgrades back to Lv 0, no best lap, no earning ghost, default
zoom, default toggles. That is deliberate: every test of a balance change
starts from the same clean slate, and a stale save from before the change
cannot leak in.

The save/load code is intact and correct (schema v4, ghost recording included).
Flip the one constant back to `true` and saving works exactly as before.

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

## How it plays

**A race is three laps.** Cross the start/finish line to begin lap 1 — the
side panel's "Lap" row counts you through `1 / 3`, `2 / 3`, `3 / 3`. Each lap
must hit all 4 checkpoint gates in order (skipping one invalidates that lap,
which then doesn't count toward the race). After three valid laps a
race-complete message reports all three lap times and your best; **R**
re-grids everyone and starts a fresh race.

Lap 1 is run from the standing start on the grid, so it carries the
accelerate-from-zero run-up; laps 2 and 3 cross the line already at speed and
are **flying laps**, worth roughly 1.1–1.5 s each over the standing lap. That
is why the panel compares you against the bots' best *flying* laps.

The economy is unchanged by the race framing: whichever single lap is your
fastest — standing or flying — becomes the earning ghost if it beats your
record. The full per-tick recording of that one lap loops continuously and
pays credits each completed loop; faster ghost laps pay more per lap *and*
loop more often.

**Ghost Fleet** buys more of those earning ghosts. Every extra ghost replays
the same best lap and pays the same credits, staggered evenly around the
circuit (ghost *k* starts `k / N` of a lap along), so income is exactly
`N x` the single-ghost rate and arrives in evenly spaced instalments instead
of one lump per lap. They are income and scenery — they never collide with
anything and never earn you a lap time.

Running wide onto the grass just slows you down (~73% speed cap plus extra
drag) — checkpoints are the real anti-cheat, not punishment physics.

## The circuit (v3)

Roughly 2 300 px around, 76 px wide, driven clockwise on screen:

1. **Start straight** (east) into **turn 1, the sweeper** — a 180° right of
   radius 228 px up the whole right-hand side. Genuinely flat out for a
   gripped car, and the one corner whose radius matches a full-lock slide's
   arc: this is the drift corner.
2. **Top straight** into the **descent ess** — two linked 150 px arcs that
   drop 240 px. The perfect line is *just* flat out; anything less costs a
   lift.
3. **Hairpin approach**, then **THE HAIRPIN**: a true 180° switchback of
   centerline radius 62 px around (140, 392), its two legs only 124 px
   apart. Even the theoretical outside-inside-outside line is capped at
   radius 62 + 38 = 100 px, i.e. ~214 px/s = 76% of top speed. **No line, no
   bravery and no upgrade makes this corner flat.** Everybody brakes.
4. **Exit kink** back onto the start straight — a long clean run for the
   drift boost to pay off.

That hairpin is what killed the old v2 layout's flat-out lap. A sweep of 196
full-throttle tunes (every look-ahead / steering-gain combination, corner
braking disabled) finds **zero** that stay on the road on v3: the best is
still 31 px past the edge with ~1.7 s in the grass, all of it at the hairpin.
Tightening *radii* rather than narrowing the road was deliberate — a narrow
road punishes imprecision everywhere, while one genuinely slow corner on a
still-wide road only asks you to slow down, which is exactly the decision the
drift boost exists to reward.

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
| green **NOVICE** - sloppy keyboard driver, slow reactions | 15.08 | 13.77 | 13.47 | 42.32 | **13.47** |
| purple **MID** - clean, competent line; never drifts | 12.85 | 11.68 | 11.68 | 36.22 | **11.68** |
| cyan **PRO** - the optimal *clean* lap | 12.45 | 11.27 | 11.27 | 34.98 | **11.27** |
| gold **PRO+** - the drift bot | 11.42 | 10.10 | 10.08 | 31.60 | **10.08** |

PRO is a real corner-speed planner: it brakes for the hairpin (slowest point
35% of top speed), lifts through the descent ess, and keeps a >= 8 px on-road
margin. Beating MID with tidy driving is realistic; beating PRO cleanly is very
hard. PRO+ handbrake-slides turn 1, banks a charge through the arc and fires
the boost on exit - worth **1.03 s (8.3%)** over PRO on the standing lap.
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

On the v3 circuit the derivation picks one tier-2 slide through the second
half of turn 1 and one flick into the hairpin.

### Strategy selection

A derived plan is a *prediction* about a car the analyser has never driven.
Rather than trust it, a `drift: "auto"` bot **races its options** —
`raceBest()` simulates the full plan, the slides only, the flicks only and the
clean line, and keeps whichever was actually quickest. Four races instead of
one (~50 ms) buys a hard guarantee: PRO+'s lap time is a minimum over a set
that always contains its clean line, so a drift plan that stops paying on some
exotic spec costs nothing at all.

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

`node test/drive_bot.mjs` prints the whole sweep table and gates both
invariants; at the time of writing it reports **0 ordering violations and 0
monotonicity violations** over 197 simulated specs.

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
- `track.js` — pure track geometry: centerline, road width, checkpoint
  gates, named sectors, off-road test, curvature queries, lap tracking. No
  DOM. The v3 circuit (see *The circuit* above) is a fast 228 px sweeper and
  a committed descent ess linked by a genuinely slow 62 px hairpin — the
  corner that makes a flat-out lap geometrically impossible.
- `main.js` — game glue: input, rotating follow camera (forward-is-up,
  smoothed rotation lag, big velocity look-ahead, speed-scaled zoom
  ~1.7x-1.45x, subtle drift kick + boost pulse), north-up corner minimap,
  tier-colored tire marks, boost flames, HUD (including the `Lap n / 3` race
  counter and the race-complete summary), the economy and the staggered
  earning-ghost fleet, localStorage save (v4, currently behind
  `PERSISTENCE = false`), the
  automatic re-grid when a race finishes, and bot reference ghost simulation
  (via `bots.js`), rendering + G toggle.
- `bots.js` — the bot drivers, imported by BOTH the game and the harness (so
  what the harness gates is exactly what you race). Skill presets (novice /
  average / expert / pro / proplus); `pursuitSteer()`, the physical
  pure-pursuit steering law (demanded yaw rate / available yaw rate x the
  tune's aggression); the corner planner with its reaction-TIME braking
  margin, yaw-rate budget, racing-line widening and reaction-limited pace
  cap; `deriveDriftZones()` + `findCorners()`, the automatic corner analysis
  that replaces PRO+'s hand-written drift zones (tunable via the
  `DRIFT_TUNING` object); `planVariants()` / `raceBest()`, which race a drift
  plan against the clean line and keep the quicker; the telemetry lap runner;
  and
  `recordRace(skill, params, {laps})` — the 3-lap race recorder that drives
  from rest at the grid through three consecutive laps, samples every tick,
  returns per-lap times plus per-lap and whole-run telemetry (brake ticks,
  the slowest point, handbrake/boost use, so the harness can prove the clean
  line is not flat out), and returns `null` if any lap is invalid. On top of
  that, `simulateBotField(params)` / `botField(params)` produce the whole
  four-tier reference field for a given car, memoised on
  (car spec + `TRACK_SIGNATURE`) so re-grids are free and only an upgrade
  purchase re-runs the physics.
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

Beyond the bot laps, the suite runs five scripted feature tests:

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

Design gates lock in the v4 balance and fail loudly if a future change undoes
it. All of them run against the *shipped* 3-lap race recordings:

- **the flat-out clean lap is dead** — PRO's race must contain braking ticks
  and dip below 85% of top speed (it brakes for 3.15 s across the race and
  bottoms out at 44%, at THE HAIRPIN)
- **the drift line pays** — PRO+'s standing lap must beat PRO's by ≥ 0.6 s
  *and* ≥ 6% (it beats it by 1.55 s / 13.2%)
- **a race is three laps** — every reference bot must string three *valid*
  laps together (all checkpoints, in order, every lap)
- **flying laps are real** — every bot's best flying lap must beat its own
  standing-start lap 1, and the tier ladder must hold on best flying lap as
  well as on total race time
- **on-road margin** — the whole 3-lap race must stay ≥ 8 px (PRO) / ≥ 3 px
  (PRO+) inside the road edge, so no re-tune can buy time by scraping grass
  or by holding together for only one lap
- **the upgrade-space sweep** — because the bots race your upgraded car, the
  field is re-simulated across a sample of the whole **driving**-upgrade space
  (`speed, accel, grip, boostPwr, boostDur`; Lap Payout and Ghost Fleet are
  economy only and never enter this regime). The sample is each upgrade alone
  at Lv 3/7/12/20, a set of mixed edge cases (one stat maxed with the rest
  near zero, all-high, all-max) and a seeded random sample — plus, for every
  one of them, all five +1 neighbours. About 35 printed rows, ~197 distinct
  simulated specs, ~20 s. Three gates:
  - every bot strings 3 valid laps at every combo,
  - **ordering** `proplus < pro < mid < novice` at every combo,
  - **monotonicity**: no +1 level of any driving upgrade makes any bot slower.

  Deterministic tunes (MID/PRO/PRO+, `steerNoise ~ 0`) are held to 1%; NOVICE
  is a deliberately sloppy driver with a ~1.5-3% per-seed spread, so its time
  is the **median of 5 seeds** and its tolerance is 3%. Every violation is
  printed with its combo, tier and upgrade — `12,1,7,18,11: proplus got SLOWER
  buying accel (Lv 1->2): 7.35s -> 7.72s (+5.0%)` — so a regression names
  itself. A separate gate still checks that uniform Lv 7 and Lv 14 cars make
  *every* tier faster than stock, so "monotone" cannot be satisfied by a
  controller that ignores the car

## Current features (v4)

- Hand-authored closed circuit (Catmull-Rom smoothed centerline), soft
  off-road slowdown (no hard walls). v3 track: wide road (76 px), a fast
  228 px sweeper, a committed descent ess and a genuinely slow 62 px
  hairpin — no flat-out lap exists
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
- Bot reference ghosts: a four-tier skill ladder racing the same three laps —
  NOVICE (green, timid, 13.5 s flying on the stock car), MID (purple, clean
  line, no drift, 11.4 s), PRO (cyan, the optimal clean lap — brakes for the
  hairpin, never drifts, 10.8 s) and PRO+ (gold, slides turn 1 and fires the
  banked boost on exit, 9.0 s, i.e. 1.8 s up on PRO) — from a shared-grid
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
- Lap validation via ordered checkpoint gates + directional line crossing
- Ghost recording/playback (per-tick position + angle samples)
- Economy: credits per ghost loop, income scales with lap speed
- **7 upgrades** with geometric cost growth, applied to the player car (and
  therefore to the bots) instantly; the ghost keeps replaying the old
  recording until you beat it:
  - *driving* — **Top Speed** (50 cr, x1.6/lvl: +10% top speed and +2.6%
    brakes), **Acceleration** (40 cr, x1.6: +12% accel, +8% brakes), **Grip**
    (45 cr, x1.6: +1 handling), **Boost Power** (90 cr, x1.65: +9% to both
    drift-boost tiers speed bonus, so tier 1 goes +28% -> +53% at Lv 10),
    **Boost Duration** (80 cr, x1.65: +10% boost time, 1.1 s -> 2.2 s at Lv 10)
  - *economy* — **Lap Payout** (60 cr, x1.7: x1.3 credits/level) and **Ghost
    Fleet** (400 cr, **x7/lvl**: +1 earning ghost, i.e. a straight income
    multiplier; the extra ghosts are staggered evenly around the lap)
- localStorage save/load (credits, upgrade levels, best time, ghost
  recording, bot-ghost visibility) — save key v4, **currently DISABLED behind
  `const PERSISTENCE = false` for prototyping**: a refresh resets everything
  and any `trackcrimental_*` key is cleared at boot
- Headless bot-driver harness with F1-style telemetry, **33 acceptance
  gates**, scripted drift-boost / drift-control / exploit-regression /
  brake-gate feature tests, and an upgrade-space sweep that asserts bot
  ordering and per-upgrade monotonicity over ~197 simulated car specs
