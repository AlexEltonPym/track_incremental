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
- **G** — toggle the NOVICE/MID/PRO/PRO+ bot reference ghosts (preference is
  saved)
- **Mouse scroll wheel** (over the track) — zoom out to survey most of the
  track, or back in. The zoom is remembered across sessions

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
| green **NOVICE** - timid keyboard driver, slow reactions | 15.42 | 14.78 | 13.50 | 43.70 | **13.50** |
| purple **MID** - clean, competent line; never drifts | 12.57 | 11.43 | 11.40 | 35.40 | **11.40** |
| cyan **PRO** - the optimal *clean* lap | 11.97 | 10.75 | 10.77 | 33.48 | **10.75** |
| gold **PRO+** - the drift bot | 10.40 | 9.00 | 8.98 | 28.38 | **8.98** |

PRO is a real corner-speed planner: it brakes for the hairpin (slowest point
35% of top speed), lifts through the descent ess, and keeps a >= 9 px on-road
margin. Beating MID with tidy driving is realistic; beating PRO cleanly is very
hard. PRO+ handbrake-slides turn 1, banks a charge through the arc and fires
the boost on exit - worth **1.57 s (13.1%)** over PRO on the standing lap and
1.8 s on the flying lap. Watch it for a live demo of where and how drifting
pays.

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
2. **Classify each corner** by its grip-limited speed on an
   outside-inside-outside line:
   - **Fast corner** (taken near top speed) -> a full **slide**, if the corner
     is long enough to bank a tier-1 charge with margin *and* is followed by
     enough track that is neither a slow corner nor a turn the other way (the
     test that stops the analyser sliding one half of a linked ess straight
     into the other). The slide's length is the tier-1 charge time at the
     speed a slide actually holds; it sits 75% of the way through the corner's
     spare length, so the entry is set up on grip and there is still corner
     left to pull against when the boost fires.
   - **Slow corner** that is also **tight against the road itself** (radius
     under 3 road half-widths - a hairpin, not a fast kink) -> a short
     part-throttle **entry flick**, sized as a fraction of the corner rather
     than a duration so it stays the same manoeuvre on a faster car. Its entry
     speed is the minimum of the slide arc, the grip limit and the yaw-rate
     ceiling.
   - Everything else gets nothing.
3. **Bound the steering.** A slide is clamped between the steering the boost
   charge needs to keep qualifying and the steering that holds the corner's
   arc - without the ceiling the pursuit term saturates at full lock and cuts
   the inside edge the moment the car gets quick.
4. **Let the driver pick the release.** The controller bails out of a slide as
   soon as a tier is banked *and* the charge starts decaying, which is the
   optimal moment to fire the boost. The analyser therefore only has to pick a
   zone that is long *enough*.

On the v3 circuit the derivation independently rediscovers the hand tune: one
slide in the second half of turn 1 and one flick into the hairpin, in almost
the same places. Head to head against the old hand-written zones, the derived
version costs **0.26 s (3%) of flying-lap pace** (8.98 s vs 8.72 s) and keeps a
comparable on-road margin (5.5 px vs 5.7 px), while still paying 1.57 s / 13.1%
over PRO and firing a boost on every lap. That is the price of map portability
and of surviving upgrades, and it is a deliberate trade.

### Bots on an upgraded car

Because the bots mirror your spec, the controller has to work across the whole
upgrade curve, not just the stock car. Four things in `bots.js` scale with the
params (all of them exactly no-ops at the stock spec):

- the brake planner's **scan reach** is the car's own braking distance plus its
  reaction margin, on a grid that stays 12 px fine however fast the car is;
- **brake margins** scale with top speed, plus the distance covered while the
  steering actuator is still winding on (`steerRampUp` is a fixed rate, so a
  corner arrives three times sooner but the lock still takes 143 ms);
- corner speed is capped by the **yaw-rate ceiling** as well as grip
  (`v <= maxTurn / k`) - `maxTurn` only creeps up with the grip upgrade while
  top speed climbs linearly, so on an upgraded car the tightest corners are
  steering-limited, and ignoring that sent a fast car straight on at the
  hairpin however early it braked;
- a **reaction-limited pace cap**: no driver may cover more than 1.5 road
  half-widths between decisions. This never binds for the 1-tick bots and is
  what keeps the 200 ms keyboard NOVICE driveable (and appropriately slow) in
  a much faster car.

The look-ahead cap deliberately does *not* scale: it is a chord bound
(`sqrt(8 * R * ROAD_HALF)`), and stretching the aim point with speed makes a
high-gain pursuit bot cut corners and wander.

Measured at upgrade levels 0 / 2 / 5 / 10 / 20 (speed, accel and grip all at
that level - level 20 is a 3x top speed, 3.4x grip car), all four tiers still
string three valid laps together and none spins out. The ladder holds through
level 10. Known rough edges at high levels: NOVICE and PRO+ clip the grass
(NOVICE by design - it is a bad driver in a fast car; PRO+ because its tune
deliberately runs a few px from the edge and has no headroom to give away),
and at level 20 MID's tidier line beats PRO's aggressive one.
`node test/drive_bot.mjs` prints the whole scaling table and gates levels 5
and 10.

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
  counter and the race-complete summary), economy, localStorage save (v4 —
  unchanged by the 3-lap race: bot ghosts are not part of the save and the
  player's ghost/best time is still a single lap; older saves are wiped
  because physics/track changes invalidate their ghost lap times), the
  automatic re-grid when a race finishes, and bot reference ghost simulation
  (via `bots.js`), rendering + G toggle.
- `bots.js` — the bot drivers, imported by BOTH the game and the harness (so
  what the harness gates is exactly what you race). Skill presets (novice /
  average / expert / pro / proplus); the pure-pursuit controller with
  speed-scaled corner planning, a yaw-rate corner limit and a
  reaction-limited pace cap; `deriveDriftZones()` + `findCorners()`, the
  automatic corner analysis that replaces PRO+'s hand-written drift zones
  (tunable via the `DRIFT_TUNING` object); the telemetry lap runner; and
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
- **upgrade scaling** — because the bots race your upgraded car, the field is
  re-simulated at upgrade levels 5 and 10: every tier must still string three
  valid laps together, the ladder must still hold, and the upgrades must
  actually make every bot faster. The harness prints the full scaling table
  (lap times, on-road margin, off-road time and PRO+'s derived drift plan)
  for both levels

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
- 4 upgrades with geometric cost growth (~1.6x/level): Top Speed,
  Acceleration, Grip, Lap Payout — applied to the player car instantly; the
  ghost keeps replaying the old recording until you beat it
- localStorage save/load (credits, upgrade levels, best time, ghost
  recording, bot-ghost visibility) — save key v4; older saves are wiped on
  load because physics changes invalidate their ghost lap times
- Headless bot-driver harness with F1-style telemetry, 32 acceptance gates,
  scripted drift-boost / drift-control / exploit-regression / brake-gate
  feature tests, and an upgrade-scaling regression gate
