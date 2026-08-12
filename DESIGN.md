# Trackcrimental — Game Design Document

**Genre:** Incremental/idle × top-down 2D time-trial racer.
**Pitch:** Drive one great lap. Your car replays that exact lap forever, earning money per loop. Spend money on upgrades, then come back and drive a *better* lap — because the car got faster, or because you did. The differentiator vs. The Looper / IGTAP: **you actually drive, and driving is the only way to convert upgrades into income.**
**Target engine:** Godot 4, 2D (this repo). All units below are pixels and seconds unless stated.

---

## 1. Core Loop

### Moment-to-moment

1. **Drive.** Player takes manual control of the car on the current track (keyboard).
2. **Set a time.** Crossing the start/finish line with all checkpoints collected completes a lap.
3. **Ghost loops and earns.** Your best valid lap becomes the *Route*. Ghost cars replay the Route continuously — even while you keep driving, and while you're in menus — earning Credits per completed loop.
4. **Spend.** Buy upgrades (car stats, income, garage cars, QoL).
5. **Repeat.** Re-drive to set a faster lap. The new lap replaces the Route, income per minute goes up.

### Definitions (implement these exactly)

- **Run:** One continuous stint of manual driving, from the moment the player presses Drive (or any input while in drive mode) until they press Escape/Park or crash-reset. A run can contain many laps.
- **Recording:** Starts the frame the car's collision point crosses the start/finish line plane in the forward direction. Samples `(position, rotation)` at **30 Hz** into a flat buffer. Ends when the line is crossed forward again. The next lap's recording begins on the same frame (flying laps — you never lose momentum between attempts).
- **Valid lap:** All checkpoints crossed **in order** (track has 3–6 invisible checkpoint gates spanning the road), then start/finish crossed forward. Missing or out-of-order checkpoints → lap is invalid, timer shows "INVALID", recording is discarded, next lap arms normally. This is the anti-shortcut rule; no wall-contact penalty.
- **First lap of a session/track:** Car spawns stationary on the grid just before the line; recording starts at the line, so the standing start is *not* part of the recorded lap. All laps are therefore flying-start comparable... except the recorded Route needs an entry state. Solution: the Route stores 1 second of pre-line samples ("run-in") so ghost playback loops seamlessly (see §2).
- **Beating your time:** If a completed valid lap's time < current Route time, the new recording **instantly replaces** the Route. All ghost cars switch to the new Route at their *next* line crossing (they finish their current loop on the old Route first — no teleporting, no lost partial-loop income). The old Route is kept as `previous_best` for one generation so the player can toggle "race my old ghost."
- **Slower lap:** Discarded silently. Ghost keeps looping the best. There is no way to lose your Route except prestige.
- **Idle/offline:** Ghosts keep earning while the app is closed: `offline_earnings = income_per_minute × minutes_away × 0.5`, capped at 8 hours (both improvable via upgrades).

### First five minutes (scripted feel, not a cutscene)

No ghost exists yet → income is 0 → the game *forces* you to drive first. Tutorialization is just the HUD: "Cross the line to start your lap." After the first valid lap: "Your car will now repeat this lap forever. Earnings: X/min. Beat your time to earn faster." First upgrade is affordable within ~90 seconds.

---

## 2. The Replay/Ghost Problem

**Decision: ghosts are pure kinematic playback (position/rotation over time). Physics never touches them. Upgrades never speed up a ghost — only re-driving does.**

Rejected alternatives, briefly:

- *Re-simulate the recorded inputs with new stats:* an input replay tuned for old handling will drive the new car into a wall. Guaranteed breakage, and "your ghost crashed, income is now 0" is a terrible failure state for an idle game.
- *Auto-drive AI that follows the racing line with new stats:* this is The Looper. It deletes our differentiator — the player's driving would stop mattering.
- *Driver/car upgrade split where "car" upgrades re-scale the ghost:* clever, but it lets income grow without driving, which again erodes the core fantasy, and time-scaling a recorded path with faster stats produces physically absurd corner speeds.

Why pure playback is right:

1. **It creates the game's central incentive.** Buy a +top-speed upgrade → your ghost is *unchanged* → the upgrade is worthless until you go re-drive and bank a faster lap. Every purchase generates a reason to play the racing half. This tension isn't a problem to solve; it *is* the game.
2. **Deterministic and cheap.** N ghosts = N interpolated transform lookups per frame. No physics divergence, no floating-point replay drift, trivially serializable, works at any time-scale for offline catch-up.
3. **Never invalidates.** Track geometry is immutable within a season (see §4), so a recorded path is drivable forever by definition.

**Implementation spec:** Route = `{ lap_time: float, sample_rate: 30, run_in: Vector3[30], samples: Vector3[] }` where Vector3 packs `(x, y, rotation)`. Playback interpolates linearly between samples at global time `t mod lap_time`; the 1-second run-in is used only to blend the loop seam (crossfade position over the final 0.2 s into sample 0 — with a flying lap the end state ≈ start state, so the blend is invisible). A 40 s lap is 1,200 samples ≈ 14 KB. Ghosts are `Node2D` sprites, not physics bodies; they don't collide with the player (drawn at 60% alpha, below the player car).

---

## 3. Economy

### Currency

- **Credits (¢):** the only currency pre-prestige. Earned per ghost loop.
- **Legacy (★):** prestige currency, §4.

### Income formula — and the double-dip question

A faster lap naturally earns more loops per minute. If the payout *per lap* also scaled with speed, lap time would be squared in the income formula — small driving gains would explode income and upgrades would feel mandatory-then-trivial. **Decision: per-lap payout is flat per track; lap time only affects loop frequency. The "reward for a faster lap" is single-dipped and therefore honest: income/min = TrackValue × Mult × 60 / lap_time.**

But pure 1/lap_time makes a 0.4 s improvement feel invisible. So we add **chunky medal thresholds** that multiply TrackValue — discrete, celebrated jumps:

```
income_per_loop  = TrackValue × MedalMult × IncomeMult × LegacyMult
loops_per_min    = 60 / lap_time            (per ghost car)
income_per_min   = income_per_loop × loops_per_min × ghost_count
```

- `TrackValue` — Track 1: **10 ¢**. Each later track ≈ ×12 the previous.
- `MedalMult` — vs. per-track author times: none ×1, Bronze ×1.5, Silver ×2.5, Gold ×4, Author ×6. Track 1 targets: Bronze 40 s, Silver 34 s, Gold 30 s, Author 27.5 s. (A fresh car drives ~42 s; a maxed car with a clean line reaches ~27 s.)
- `IncomeMult` — product of purchased income upgrades. Starts 1.0.
- `ghost_count` — garage cars all replaying the same Route, phase-offset evenly around the lap (offset `i × lap_time / ghost_count`) so the track looks like a busy race. Starts at 1.

**Starting economy check:** first valid lap ~42 s → 10 ¢ × 60/42 ≈ **14 ¢/min**, plus you bank each lap you drive manually too (manual laps pay the same per-loop amount on completion — driving is never income-negative). First upgrade costs 25 ¢ → affordable in under 2 minutes of play.

### Cost curves

- Repeatable stat/income upgrades: `cost(n) = base × 1.15^n` (n = purchases so far in that line). Display next-cost.
- Ghost cars (the big-ticket line): `cost(k) = 500 × 8^(k-1)` for the k-th *additional* car. These are the "cookie clicker building" equivalent and should always feel expensive-but-inevitable.
- One-off unlocks: hand-priced, listed below.

### Upgrade catalog (v1 target; ✱ = in prototype)

**Car stats** (repeatable, each level also nudges the car's top achievable lap):

| # | Upgrade | Effect per level | Base cost | Max lvl |
|---|---|---|---|---|
| 1 | ✱ Engine | +4% top speed | 25 ¢ | 25 |
| 2 | ✱ Tires | +4% lateral grip (less drift, higher corner speed) | 40 ¢ | 25 |
| 3 | Turbo | +5% acceleration | 60 ¢ | 20 |
| 4 | Brakes | +6% braking force | 50 ¢ | 15 |
| 5 | Chassis | +3% steering rate at high speed | 150 ¢ | 15 |

**Income:**

| # | Upgrade | Effect | Cost |
|---|---|---|---|
| 6 | ✱ Sponsor Decals | ×1.25 IncomeMult per level | 100 ¢ × 1.5^n, max 20 |
| 7 | ✱ Second Car (Garage) | +1 ghost car per purchase | 500 × 8^(k−1) ¢ |
| 8 | Fan Club | +1% IncomeMult per medal owned (all tracks) | 2,500 ¢ one-off |
| 9 | Night Shift | Offline earnings 50% → 100%, cap 8 h → 24 h | 5,000 ¢, two ranks |

**Automation / QoL:**

| # | Upgrade | Effect | Cost |
|---|---|---|---|
| 10 | Telemetry | Shows best-line ghost + live delta timer while driving | 200 ¢ one-off |
| 11 | Sector Timing | Checkpoint split display + per-sector best comparison | 400 ¢ one-off |
| 12 | Instant Replay | "Retry from last checkpoint" during a practice run (practice laps can't set the Route) | 1,500 ¢ one-off |
| 13 | Race Engineer | Auto-buys cheapest affordable stat level while you drive (toggle) | 10,000 ¢ one-off |

**Roguelike pick-1-of-3 — "Contracts":** on every **medal earned** (bronze/silver/gold/author, per track), the player picks one of three randomly drawn permanent perks. They fit because they're earned by *driving milestones*, reinforcing the loop. Perk pool (examples): `Slipstream` — ghosts within 100 px of the player give the player +5% top speed (racing your ghost is literally faster); `Overtime` — first 10 loops after setting a new best pay ×3; `Clean Air` — +8% income if you haven't touched a wall this session's best lap; `Scrap Dealer` — refund 20% of spent Credits at prestige as bonus Legacy; `Pit Wall` — checkpoints pay 10% of loop value when the *player* crosses them. (Design rule for the pool: no perk may alter ghost replay speed — that would violate §2's "only re-driving speeds up income" principle.) Contracts reset at prestige.

---

## 4. Progression & Prestige

### Tracks as gates

Four tracks in v1, unlocked by **total lifetime Credits earned** (not spent): Track 1 "Paperclip" free; Track 2 "Hairpin Row" at 5,000 ¢; Track 3 "Interchange" at 250,000 ¢; Track 4 "The Gauntlet" at 20,000,000 ¢. Each track keeps its **own Route and its own ghosts, all earning simultaneously** — the mid-game is a portfolio: revisit old tracks with a faster car, re-drive them, and permanently raise their output. TrackValues: 10 / 120 / 1,500 / 18,000 ¢. Later tracks are longer (target lap 30 s / 45 s / 60 s / 90 s) and technically harder (Track 4 has an ice sector: grip ×0.35).

### Prestige — "New Season"

Available once lifetime earnings hit **1,000,000 ¢** (softly optimal around 3–5×).

- **Reset:** Credits, all upgrades, all Routes/ghosts, Contracts.
- **Keep:** track unlocks, medals (and their MedalMult on future laps), Legacy, Legacy perks, personal-best *times* on a leaderboard (history, not income).
- **Earn:** `Legacy = floor( sqrt( lifetime_credits / 1,000,000 ) × (1 + 0.1 × gold_medals) )`. Legacy is spent in a permanent shop: `LegacyMult = 1 + 0.05 × unspent ★`; shop items include starting-cash packs, +1 starting Engine/Tire level per rank, "Veteran Instincts" (Telemetry free from lap one), and — the marquee sink — **Season Rules**: each season, one global modifier chosen at prestige (e.g. reversed track direction, ×2 TrackValue but ice everywhere) that remixes the driving. Track *geometry* only ever changes at season boundaries, so Routes can never be invalidated mid-season (protects §2's guarantee).

Why full Route reset at prestige is right: the first hour of a new season replays the whole "drive → ghost → upgrade" arc with better perks — that arc is our fun, so prestige should re-trigger it, not skip it.

---

## 5. Driving Feel

**Model: arcade grip car with tunable drift** — a kinematic velocity model, not wheel physics. Keyboard-first: `↑` throttle, `↓` brake/reverse, `←/→` steer, `R` reset to last checkpoint (practice only), `Esc` park.

### Handling spec (base car, before upgrades)

Integrate per physics tick (60 Hz), car state = `pos, vel (Vector2), heading (rad)`:

```
TOP_SPEED      = 340   px/s        ENGINE_ACCEL  = 230  px/s²
BRAKE_DECEL    = 480   px/s²       REVERSE_SPEED = 90   px/s
COAST_DRAG     = 60    px/s²       STEER_RATE    = 3.2  rad/s   (at low speed)
STEER_FALLOFF  = steer × clamp(1.35 − 0.55×(speed/TOP_SPEED), 0.55, 1.0)
GRIP           = 6.0   /s          (lateral velocity decay rate)
WALL_RESTITUTION = 0.25, wall hit also scales speed ×0.6 (punishing but not lethal)
```

Per tick: apply throttle/brake along `heading`; rotate `heading` by steer input × falloff; then split `vel` into forward/lateral components and decay the lateral one: `v_lat *= exp(−GRIP × dt)`. `GRIP = 6` means the car visibly slides a car-length on hard corner entry, then hooks up — readable drift, forgiving recovery. Tire upgrades raise GRIP (+4%/lvl); a maxed car (GRIP ≈ 16) corners nearly on rails, which *feels* like the upgrade. Steering falloff >1 at low speed makes hairpins tight without twitchy straights. No handbrake in v0; add `Space` = handbrake (GRIP ×0.25 while held) in v1 for style and hairpin tech.

Car sprite 36×18 px; circle collider r = 10 (circle, not box — no corner-catching on walls). Track road width 130 px. Camera: follows with 0.15 s smoothing, slight look-ahead in velocity direction (×0.25 s), fixed zoom.

### What makes re-lapping feel good (all are HUD/feedback, all cheap)

1. **Best-lap ghost rendered while you drive** (Telemetry upgrade): the single strongest "one more lap" hook in time-trial games — you race yourself.
2. **Live delta timer:** signed `current_time_at_progress − best_time_at_same_progress`, computed by nearest-sample lookup on the Route; green when ahead, red behind, updated continuously.
3. **Checkpoint splits:** flash sector delta at each gate; store per-sector bests so players chase "purple sectors" even on failed laps.
4. **New-record ceremony:** freeze 0.3 s, line flash, "NEW ROUTE −1.24 s", and — crucially — show the **income/min counter physically tick up** on the same screen. Connect the racing win to the idle win every single time.
5. **Ghost swarm as progress display:** more garage cars = visibly busier track. Your income is *diegetic*.

---

## 6. Prototype Scope

### v0 — the fun-proof slice (build this, nothing else)

Goal: confirm that "beat my time → number goes up" compels a second hour.

1. One track (Track 1 "Paperclip": one long straight, one hairpin, two medium corners, 3 checkpoints), drawn with simple polygons; wall collision.
2. Car with the §5 handling constants; keyboard input; follow camera.
3. Lap timing + validity (checkpoint order), 30 Hz recording, best-lap replacement.
4. One ghost car doing pure playback of the Route, looping, paying `10 ¢ × MedalMult` per loop; Credits HUD with ¢/min readout.
5. Five upgrades: **Engine, Tires, Sponsor Decals, Second Car, Telemetry** (this set spans all three motivation types: drive faster / earn more / see more).
6. Medal thresholds for Track 1 with the ×1.5/×2.5/×4 multipliers and a record ceremony.
7. Save/load (JSON: credits, upgrade levels, Route buffer, best time), naive offline earnings on load.

Explicitly **out** of v0: prestige, multiple tracks, Contracts, handbrake, audio beyond an engine loop and a record sting, any art beyond colored polygons.

**v0 exit test:** does a playtester, unprompted, re-drive after buying Tires? If yes, the loop works.

### Ordered next steps

1. **v0.1 — Feel pass:** delta timer + sector splits standard (fold Telemetry upgrade into showing the *ghost line* only), handbrake, screenshake/skid marks/engine pitch by speed.
2. **v0.2 — Depth:** Tracks 2–3, per-track Routes earning in parallel, remaining stat/QoL upgrades, geometric-cost polish and balance sweep.
3. **v0.3 — Prestige:** Legacy, permanent shop, one Season Rule (reversed direction).
4. **v0.4 — Contracts:** medal-triggered pick-1-of-3, 12-perk pool.
5. **v0.5 — Track 4, offline-earnings upgrades, Steam-ready save robustness, controller support.**
6. **v1.0 — Art/audio pass, achievements, speedrun-friendly stats screen (lap history graph).**

---

*Numbers in this document are tuned for a first playable and are expected to move ±30% after the first balance pass; formulas and structural decisions are not.*
