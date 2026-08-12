# Research Report: Incremental × Top-Down Time-Trial Racing — Prior Art & Market Gap

**Bottom line up front: nobody has shipped this exact game.** The "your recorded run becomes your idle income" mechanic has been proven in platforming (IGTAP) but never in racing. Racing incrementals exist, but they all either remove the driving (The Loopler, Idle Racing Club) or keep the driving and skip the replay/automation entirely (Incremental Retro Racing). The specific fusion — *drive a lap → the lap itself becomes the automation → upgrades make the lap better → drive again* — is an open lane.

**Timing note (as of Aug 2026):** the two closest reference points both launch in the next 6 weeks, and **both are published by Zero Percent** — IGTAP (Sep 21, 2026) and The Loopler (Sep 11, 2026). That publisher is deliberately building this niche and is an obvious pitch target.

---

## 1. The Two Named References

### IGTAP: an Incremental Game That's Also a Platformer
- **Links:** [Steam (Sep 21, 2026)](https://store.steampowered.com/app/4364730/) · [itch.io demo](https://varii-peppertangogames.itch.io/igtap-but-patched) · [galaxy.click](https://galaxy.click/play/694) · [incrementaldb](https://www.incrementaldb.com/game/igtap-incremental-game-thats-also-a-platformer)
- **Devs:** Pepper Tango Games (dev "Varii"), pub Zero Percent + Gamersky Games. Unity. Demo rated **4.6/5 from 62 itch ratings**; called "cookie clicker meets Celeste."

**Core loop:** Run a short precision-platforming course → earn **Watts** → buy **clones** that replay your best path → clones generate passive Watts → buy movement abilities (double jump, dash, wall jump) → those abilities both *unlock new higher-income courses* and *open faster routes through old courses* → re-record a faster time → clone output multiplies.

**How the recording actually works — this is the load-bearing design decision.** IGTAP stores your **best time per course**, and income scales off that time. "Faster course times directly multiply your Watt output." The clones are production units (upgrades include *clone count*, *clone speed*, *clone size*) whose visual path-following is essentially decorative playback. It is **not** a physics re-simulation. This sidesteps replay invalidation entirely — a new dash ability can't "break" your ghost, because the ghost was never a physics entity.

**Structural cleverness worth stealing:**
- Re-recording is **opt-in and rewarded**, never forced. New abilities create *new* faster routes; you go back because it's lucrative, not because the game invalidated you.
- A "**boost all previous courses**" upgrade retroactively lifts old courses so early content never goes dead.
- The demo ends with a **prestige-like reset**: "your course times will be reset and you'll have to redo all the courses mostly in the dark for way higher Watt gain." Elegant — it re-monetizes mastery instead of adding new tracks, and changes the *conditions* (lights off) so the redo isn't literally the same.
- Metroidvania overworld with hidden bonus upgrades: gives active players something to do with idle downtime. One player: "you could spend all your idling time trying to tackle a hard secret."

**Praise (galaxy.click / itch comments):** "the smartest idea for a game I've ever seen"; "one of the extremely few demos where I can actually consider paying for it"; "one of the best games I have played on here." Repeatedly praised: **tight, responsive controls**, forgiving wall-jump/ledge timings, frequent checkpoints so low-skill players can finish, while emergent tech (dash-jump, dash-wall-jump for extra height) rewards experts. Players voluntarily post time tables (1.58 / 2.50 / 6.30 / 22.42 / 32.02) — self-organized leaderboard behaviour with no leaderboard in the game.

**Criticism — the important part:**
- **"The idea is very primitive and doesn't give much room for your own decisions."** (Klogner, long structured critique.) The incremental layer is flat multipliers, not choices. He asked for parallel courses run simultaneously, and for upgrades that alter the *level* (fans that blow you further, slower crushers) rather than just the number.
- **"Isn't even an incremental at all... incremental stuff put in there only to get an extra tag."** Genre-purist rejection from the idle crowd.
- **Opaque upgrades:** "I have no idea what clone size increase does."
- **Ramp too slow** per area; no fast travel between reached levels; no course-restart button; sticky-keys/dash keybind bugs; poor contrast (green text on red-lit sections); softlock in the end-of-demo pit.
- Physics inconsistency killed goodwill fastest: multiple long threads on double-jump failing after long jumps or head-bumps. In a game whose whole premise is *your execution is the content*, inconsistent physics is an existential bug, not a polish item.

**Lesson for us:** Store the *time* (or a lightweight scalar summary of the lap), not a physics replay, and make income a function of it. Make re-driving opt-in and lucrative. But go further than IGTAP on the incremental layer — that's its one consistent complaint and our clearest differentiation opportunity.

### The Loopler
- **Links:** [Steam (Sep 11, 2026)](https://store.steampowered.com/app/4150860/The_Loopler/) · [Demo](https://store.steampowered.com/app/4154070/) · [itch](https://mheep.itch.io/the-loopler) · [incrementaldb](https://www.incrementaldb.com/game/the-loopler)
- **Dev:** Mheep, pub Zero Percent. Originated as a **GMTK Game Jam 2025** entry (#320 in enjoyment). Demo: **Very Positive, 189/207 (91%)**.

**Core loop:** A slot car drives itself around a loop. You never steer. You draft a build from **50 cards**, place **30 gates** at specific track slots (ordering matters for synergies), collect **70 charms**, manage fuel/boost, and upgrade your car at pit stops. Goal: finish top three 10 times. 9 cars, 9 tracks, 5 difficulties, daily/weekly challenges with leaderboards. Notably, some cards **spawn ghost cars** to trigger gates — ghosts as a multiplier mechanic, not as a recording.

**Praise:** "surprisingly addictive"; stacking modifiers and spawning ghost cars for crazy high-score runs; music/atmosphere; leaderboards; the physical satisfaction of watching the loop accelerate.

**Criticism:**
- **Track variety is cosmetic:** "why different tracks, when it has no meaningful impact? What are my strategy options? You just pick 1 of each in every game." Solved in ~2 hours.
- "You are basically fishing for the same items every game."
- Late-game pit stops degrade to clicking: "give me an >autobuy everything and upgrade< button, because that was the only thing I was doing."
- An incrementaldb reviewer noted the swingy pacing makes it feel **more roguelike than incremental** — audience mismatch.
- Repeated demand for an **endless/infinite mode** (CloverPit-style "keep going past the goal").

**Lesson for us:** The Loopler's fatal weakness is *exactly* what our concept fixes. Its tracks are wallpaper because the player never interacts with the geometry. In our game the track *is* the skill expression — every corner is a decision the player physically makes. That converts The Loopler's biggest complaint into our headline feature. Also note: it validates that "watch a car loop, numbers go up" is commercially attractive (91% positive, ~200 demo reviews) — the appetite is real.

---

## 2. Other Relevant Prior Art

| # | Game | Link | Core loop | Why it works / fails | Lesson |
|---|---|---|---|---|---|
| 1 | **Incremental Retro Racing** | [Steam](https://store.steampowered.com/app/4534200/), July 28 2026, ~A$14, dev Baardmoeder | OutRun-style super-scaler; drive procgen roads, earn stars from speed/checkpoints/overtakes, spend on 70+ vehicles, upgrades, track-gen options | **Failed: 2 positive / 4+ negative.** This is our closest commercial cautionary tale | See below — full breakdown |
| 2 | **Progress Racer RPG** | [Steam](https://store.steampowered.com/app/3346820/) | Race an obstacle track for Km, spend Km to level stats; boosts can be comboed manually **or automated entirely** | **Very Positive, 106/112.** "Racing gameplay felt shockingly great"; hidden lore hook | Let the player *choose* automation depth per system rather than forcing one playstyle. Also: a genuinely good-feeling drive carries an incremental |
| 3 | **Cursor\*10** (Nekogames, 2008) | [Wikipedia](https://en.wikipedia.org/wiki/Cursor*10) | 10 time-limited lives; each new cursor replays *all* previous runs in real time; you cooperate with your past selves | The genre's ur-text. Credited with popularising "self-co-op." You deliberately waste a run setting up a future one | The deepest version of this mechanic isn't "past self = income," it's "**past self = a resource you plan around.**" A lap that deliberately sacrifices time to park a ghost somewhere useful is a design space nobody in racing has touched |
| 4 | **Loop Hero** | [Wikipedia](https://en.wikipedia.org/wiki/Loop_Hero) | Hero auto-runs a loop; you place tiles on the circuit to shape it; resources expand a camp | Tile *adjacency* synergies are the praised part. Criticised: once solved, "drains considerable joy"; opaque effect attribution; [doesn't respect your time](https://www.techradar.com/news/i-love-loop-hero-but-it-doesnt-respect-my-time-at-all) | Best available model for **making the track itself an upgrade surface**. Placing modifiers on specific corners gives spatial meaning to upgrades — and makes each track mechanically distinct, fixing The Loopler's flaw |
| 5 | **Learn to Fly** series | Flash/[Idle version](https://www.incrementaldb.com/game/learn-to-fly-idle) | Launch a penguin, collect coins during the attempt, spend on upgrades, launch again | Defined the "Upgrades Game" — the attempt→shop→attempt rhythm our concept inherits. "Watching your penguin travel a little farther each time" | The run must end at a **visible, comparable number** and the shop must be one click away. Session rhythm > session length |
| 6 | **Idle Loops / Increlution** | [Idle Loops](https://omsi6.github.io/loops/) · [Increlution](https://store.steampowered.com/app/1593350/) | Build an action list; time loop replays it; optimise the sequence | The *abstract* version of our mechanic — recording as a plan, with a predictor showing outcomes. Increlution criticised for pausing offline accrual when it hits an unautomated action | Consider a **route predictor**: show "this line, with your current stats, yields X/lap" before committing. Also: never stall idle income on a player action |
| 7 | **Idle Racing Club / Idle Racer / Loop Racer** | [Idle Racing Club](https://smulemun.itch.io/idle-racing-club) · [Idle Racer](https://duality583.itch.io/idle-racer) | Cars loop a track, laps = currency, buy upgrades, no driving | The jam-tier baseline. Feedback: "Could use a bit of polish"; on the similar *Idle Racing*: "**The concept is good, but it's so clunky, and not particularly rewarding**" | This shelf is crowded and shallow. Anything with real driving feel instantly outclasses it |
| 8 | **Backseat Champions** | [OverTake](https://www.overtake.gg/news/backseat-champions-combining-roguelite-strategy-with-motorsport.4704/), EA 2026 | Racing roguelite where you're the *engineer* — pick upgrade cards mid-race, no steering | Deliberately removes driving, like The Loopler. Confirms an industry-wide bet that racing+roguelite works | The market is converging on "racing without driving." Our differentiation is being the one that keeps the wheel |
| 9 | **Parking Garage Rally Circuit** | [Steam](https://store.steampowered.com/app/2737300/) | Short arcade time-trial tracks, chainable drift boosts, leaderboards, auto-downloaded ghosts | **Overwhelmingly Positive, 1413/1463.** "Gold standard of arcade time trials." Chainable drift boosts = infinite skill ceiling. **Auto-downloads the ghost of the player just above you** — "makes it super easy to play again." Con: only 3 cars / 8 tracks | The single best handling-feel and retry-loop reference. Steal the **ghost-just-ahead** hook wholesale: it is a ready-made "one more lap" engine that costs almost nothing |
| 10 | **Circuit Superstars** | [Steam](https://store.steampowered.com/app/1097130/) | Top-down multi-discipline racing, distinct handling per car class | Very Positive (1325/1583, 84%). "Low skill floor, high skill ceiling"; weight and nuance per vehicle. **Top negative review**: hidden auto-centering steering assist — "if you like having control while driving, look elsewhere" | The top-down handling benchmark. And the warning: **never hide driving assists**. In a game where the player's line is the content, invisible assistance is a betrayal |
| 11 | **Absolute Drift** | [Metacritic](https://www.metacritic.com/game/absolute-drift/) | Top-down zen drifting, score-attack | Once it clicks it's sublime; but the learning curve is "brutally steep," tutorials assign tasks without teaching, car is permanently sliding | An incremental's audience will **not** survive that onboarding. Our handling needs Circuit Superstars' floor with Absolute Drift's ceiling |
| 12 | **Ghost Lap** | [itch](https://jameswilson404.itch.io/ghost-lap) | RC-scale time trial; your previous laps become ghosts you can **slipstream off** for a speed advantage | Tiny, but the only game found where your own ghost is *mechanically useful*, not just a benchmark | Direct mechanical precedent: **your ghost fleet should physically help you** (slipstream/tow) — turning the idle layer into an active-play buff and closing the loop in both directions |

### Incremental Retro Racing — the cautionary tale in detail
Released July 2026, sitting at roughly 2 positive / 4 negative. It is the closest anyone has come to shipping "racing + incremental with real driving," and it is failing. Verbatim reasons:

- **No failure state, so no tension:** "Crashing into traffic doesn't damage your vehicle. Instead, it brings you to an immediate stop... you can't actually fail." Tracks are wide, staying on the road is easy.
- **Procgen tracks are the wrong tool:** unlimited generated roads meant no track was worth mastering. The one positive review praises the *generator settings*, not the driving.
- **Upgrade curve blowout:** "first upgrade are a few hundreds, but level two of them are directly 10-15k, and the double star bonus... is sold for 65k. I just can't buy it and there's no way I'm gonna grind for 3 hours for a single upgrade."
- **Content exhausted in 2 hours**; "70+ vehicles" felt padded.
- **Save file loss** ended one player's run permanently.
- Summary verdict: "It probably would've been better if it was just a regular racing game with upgrades."

That last line is the whole risk of this genre mashup in one sentence.

---

## 3. The Market Gap

**What's on the board:**
- Racing incrementals **without driving**: The Loopler, Idle Racing Club, Idle Racer, Backseat Champions, IdleDotRacers, the entire itch shelf. Well-served, and its ceiling is capped by exactly the complaint The Loopler got — tracks that don't matter.
- Racing **with driving but no automation layer**: Incremental Retro Racing (failing), Progress Racer RPG (succeeding, but the incremental layer is a stat RPG, not automation).
- Pure time-trial racers with **ghosts as benchmarks only**: Trackmania, Parking Garage Rally Circuit, Circuit Superstars. Ghosts are a comparison tool; they generate nothing.
- **Recording-as-automation** proven only outside racing: IGTAP (platforming), Cursor\*10 (puzzle), Idle Loops (abstract action lists).

**The gap:** No game makes a *ghost economically productive*. In every racer ever made, your best lap is a benchmark you race against and then discard. This concept makes it an **asset that pays rent** — and that single reframing does something no competitor achieves: it makes track geometry, racing line, and driver skill all *permanently* meaningful. A corner you learn to take 0.2s faster isn't a leaderboard entry, it's a compounding revenue increase forever.

Two secondary gaps worth naming:
1. **Top-down + incremental is empty.** Every incremental racer found is either chase-cam (IRR), abstract dots, or side-scrolling. Top-down is also the cheapest possible art style to produce track variety in — a structural advantage.
2. **A real skill layer in an incremental.** r/incremental_games and galaxy.click reactions to IGTAP show genuine hunger: "I have never been into speed running... but this game utilizes it"; "the first incremental game I find truly nourishing." The audience wants this, and there are two suppliers.

---

## 4. The Three Biggest Design Pitfalls

### Pitfall 1 — Replay semantics: physics re-simulation will destroy you
If the ghost is a **physics replay** of recorded inputs, then any change to top speed, grip, or acceleration desyncs it — the ghost drives into a wall, and the player's asset evaporates. Options:

- **(A) Store time, not physics (IGTAP's solution).** Income = f(best_lap_time) × ghost_count × multipliers. The visual ghost is decorative playback of the recorded *path*, replayed at whatever speed the sim needs. Robust, trivially cheap, never desyncs. Cost: upgrades don't visibly make ghosts faster unless you fake it.
- **(B) Store the racing line, re-simulate against it.** Record the path as a spline; upgraded cars re-drive that line and post a *derived* time from current stats. Speed upgrades genuinely make ghosts faster; the line's quality is what the player owns. Much more satisfying, and it makes "my line was good enough to survive a +20% speed upgrade" a real skill statement. Risk: needs a driving-assist AI that follows a line at the limit — solvable, but real work.
- **(C) Deterministic input replay.** Do not do this. It is the version that breaks.

**Sub-trap:** the *forced re-record*. If every speed upgrade requires re-driving 12 tracks to stay optimal, you have built a chore treadmill. IGTAP's answer is that upgrades open *new routes* (opt-in), plus a retroactive "boost all previous courses" upgrade, plus a prestige that resets times **under changed conditions** (lights off) so the redo is a new experience. Copy all three. Never make the player redo a lap to preserve income they already earned — only to *increase* it.

### Pitfall 2 — The two-audience trap: you will be attacked from both sides
This is empirically the most reliable failure mode in the mashup:
- Idle purists reject it: *"isn't even an incremental at all... incremental stuff put in there only to get an extra tag"* (IGTAP). Perfect Tower II drew the same fire for gating progression behind minigames — players avoided the active content even though it was a massive part of progression.
- Incremental veterans reject it for the opposite reason: *"the idea is very primitive and doesn't give much room for your own decisions"* (IGTAP). Flat multipliers aren't an incremental to that audience.

**Both complaints are about the same design gap: the active and idle layers are stapled together rather than interlocked.** Mitigations:
- Every active skill gain must have an **idle-purchasable substitute** at a worse exchange rate, so nothing is *locked* behind driving — only accelerated by it. (Progress Racer RPG's "automate boosts entirely" option is the model, and it's Very Positive.)
- Give the idle layer **real decisions**: ghost fleet composition, per-corner modifiers, mutually exclusive tuning trees (grip vs. top speed changes which line is optimal), track-slot placement à la Loop Hero. Upgrades that *change the routing problem* are worth ten that change a number.
- Make skill gains and upgrade gains **multiply, not substitute**. If a good driver can skip the economy, the incremental is decoration; if upgrades trivialize the driving, the racing is decoration.

### Pitfall 3 — Track variety, and the "solved game" cliff
The most damning review of The Loopler: *"why different tracks, when it has no meaningful impact?"* The most damning of Incremental Retro Racing: procgen roads nobody wanted to master. The most damning of Loop Hero: *"once you learn the best possible choices, it drains considerable joy."*

**Procedural tracks are actively harmful here.** Time-trial fun comes from *memorisation and refinement of a specific piece of geometry* — Parking Garage Rally Circuit ships 8 handcrafted tracks and sits at 96% positive; "Seattle is where I got the bug for repeatedly trying to find time." A generated track can never earn that. Handcrafted, short (15-45s), and few-but-distinct beats infinite-but-samey.

Then plan for the cliff: once a player has a near-perfect line on every track, the active layer is solved and the game collapses into a pure idler. Counters, in rough order of cost-effectiveness:
- **Ghost-just-ahead from the leaderboard** (PGRC's trick) — an infinite, free supply of "beat this by 0.3s" targets.
- **Condition mutators** rather than new geometry: night/lights-off (IGTAP's prestige), rain/low-grip, reversed direction (multiple IGTAP players independently drove courses backwards and loved it), no-checkpoints/no-assist challenge modes.
- **Build-dependent optimal lines**: if a grip build and a top-speed build want genuinely different lines through the same corner, one track becomes several problems.
- Community/custom tracks — requested unprompted by IGTAP players: *"the strong point of the game could be custom levels from the community. It's an ideal connection between the speedrun community and casual people."*

### Two more that will bite (lower tier, still costly)
4. **Physics inconsistency is fatal, not cosmetic.** IGTAP's longest and angriest comment threads are all about a double jump that fires ~5% of the time. When the player's execution *is* the content, non-determinism doesn't feel like difficulty, it feels like theft. Budget for frame-perfect determinism, input buffering, and a visible input display. Per Circuit Superstars' top negative review: **if you ship driving assists, make them visible and toggleable.**
5. **Upgrade curve and legibility.** IRR died partly on a 100 → 15,000 price jump. IGTAP players couldn't tell what "clone size increase" does. Every upgrade needs its effect on **income-per-lap shown numerically before purchase**, and the curve needs to keep the *next* purchase always within one or two laps' reach.

---

## 5. Concrete Recommendations

1. **Make the ghost mechanically useful, not just economically productive.** Ghost Lap lets you slipstream your own previous laps. If your ghost fleet gives a tow, a drafting boost, or blocks a hazard, then the idle layer feeds the active layer *and* the active layer feeds the idle layer. That closed two-way loop is the thing IGTAP doesn't have, and it's the strongest available differentiator.
2. **Record the racing line, derive the time (option B above).** "My line was clean enough to survive a +30% top-speed upgrade" is a far better fantasy than "my number went down."
3. **Ship handcrafted 15-45s tracks and the ghost-just-ahead hook.** Cheapest proven retention mechanism in the reference set.
4. **Give the incremental layer spatial decisions** — Loop Hero-style per-corner modifiers placed on the track — so upgrades change the *routing problem*, not just the multiplier. This single choice answers the loudest criticism levelled at both IGTAP and The Loopler.
5. **Consider Zero Percent as publisher.** They have IGTAP and The Loopler shipping within 10 days of each other. This concept is the literal intersection of their two bets.
6. **Watch both launches closely (Sep 11 and Sep 21, 2026).** IGTAP's launch reviews in particular will be the highest-quality data available on how mainstream audiences receive skill-gated incrementals — worth waiting for before locking the idle/active ratio.

---

**Sources:** [IGTAP Steam](https://store.steampowered.com/app/4364730/) · [IGTAP itch demo + comments](https://varii-peppertangogames.itch.io/igtap-but-patched) · [IGTAP galaxy.click comments](https://galaxy.click/comments/694?sort=top) · [IGTAP incrementaldb](https://www.incrementaldb.com/game/igtap-incremental-game-thats-also-a-platformer) · [Jank.cool on IGTAP](https://www.jank.cool/an-incremental-game-thats-also-a-platformer/) · [The Loopler Steam](https://store.steampowered.com/app/4150860/The_Loopler/) · [The Loopler Demo](https://store.steampowered.com/app/4154070/) · [Incremental Retro Racing](https://store.steampowered.com/app/4534200/) · [Progress Racer RPG](https://store.steampowered.com/app/3346820/) · [Parking Garage Rally Circuit](https://store.steampowered.com/app/2737300/) · [Circuit Superstars](https://store.steampowered.com/app/1097130) · [Absolute Drift reviews](https://www.metacritic.com/game/absolute-drift/) · [Cursor\*10](https://en.wikipedia.org/wiki/Cursor*10) · [Loop Hero](https://en.wikipedia.org/wiki/Loop_Hero) · [Ghost Lap](https://jameswilson404.itch.io/ghost-lap) · [Backseat Champions](https://www.overtake.gg/news/backseat-champions-combining-roguelite-strategy-with-motorsport.4704/) · [Perfect Tower II critique](https://libredd.it/r/incremental_games/comments/lzsalm/the_perfect_tower_ii_is_bad/) · [itch racing+incremental tag](https://itch.io/games/tag-incremental/tag-racing)
