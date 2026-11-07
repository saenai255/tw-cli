# Autopilot

Plays the character on its own while the TUI is open: queues jobs by your priority, sleeps (and wakes early),
banks cash, uses consumables, does quests and safe NPC duels. Every behaviour is a toggle on the Autopilot
screen (`g a`). Spec agreed with the user in a grill session ("Decisions").

## Files

| File                                                     | What                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/game/timeline.ts`                                   | Pure projection of a task list: travel, waits, regen, energy/HP/XP/level/cash per step, level-up refill, partial sleeps, instant actions.                                                  |
| `src/game/autopilot-config.ts`                           | Settings, rules, saved plan, spend tracker, duel record (`autopilot.json` in the config dir); `goalWeights`, `fingerprint`, `duelOutlook`.                                                 |
| `src/game/autopilot.ts`                                  | Pure planner `planAutopilot(input)`: HP → bank → inserts → jobs by priority, energy sleeps / level-up-sized consumables when short. `parseConsumable`, `expectedHpLoss`.                   |
| `src/game/autopilot-runner.ts`                           | `AutopilotRunner` (`state.runner`): replans on input change, sends tasks, wakes from sleep, deposits, uses items, cancels for a better plan, NPC duels for XP, retries/backoff, spend cap. |
| `src/game/special-jobs.ts`                               | 24 h disk cache of map-discovered silver/gold positions and their raw `job/job` replies.                                                                                                   |
| `src/game/autopilot-quests.ts`                           | `QuestModule`: finish (reward by priority), wear + restore gear, buy quest items, pick up market goods, accept saloon quests, re-read quests waiting for a time window. `chooseReward`.    |
| `src/game/quest-buy.ts`                                  | Buying quest items no job drops: `chooseBuys` (pure: source per item within the limits), `BuyCatalog` (shops, mobile trader, market offers the runner read; `state.buyCatalog`).           |
| `src/game/debug-log.ts`, `src/tui/debug.ts`              | Debug log (`state.debug`) and its screen (`g x`); see "Debugging".                                                                                                                         |
| `src/tui/autopilot.ts`                                   | Screen: priority, module toggles and values on the left, plan pane (`PlanPane`, rows from `planRows`) on the right; `Q` full queue view.                                                   |
| `test/quest-buy.test.ts`                                 | Buying quest items: ~120 hand-reasoned cases (parsing, source choice, catalog, planner trips, state, buying against a fake server).                                                        |
| `test/autopilot.test.ts`, `test/social.test.ts` (runner) | Timeline, config, planner, consumables, inserts, screen, queue view, rewards, duels; runner against a fake server.                                                                         |

## Using it

- `g a` opens the screen. `R` run/pause (paused still plans and shows "would do", sends nothing), `X` stop
  (pause + clear the plan; rules stay), `Space`/`Enter` toggle, `←→`/`+-` values, `J K` reorder priority.
- `use discovered silver & gold jobs` (off): plan specials the map has found at their exact location, with the
  real `job/job` values. It does not scan the map itself; see "Silver/gold jobs".
- `switch spot only when better by` (20 %): stay at the queue-end location unless a job elsewhere scores clearly
  better; stops marginal walks like Peace Officer → Banker for +9.7 % XP/energy.
- `Use consumables` sizes energy items to the next level-up: the smallest item that covers the next run and the
  energy still needed to level up; `wait for a level-up up to` (1 h) is how close the level-up can be before it
  waits instead of using one. Price is not used for energy items (they are not regularly purchasable).
- `Q` queue view: queued + planned rows (ETA, travel, energy, HP, XP, $, module). `c` cancel a queued task,
  `d` exclude a planned job / remove an inserted row, `u` clear exclusions, `s`/`b` insert a sleep / bank stop at
  a row's time, `J K` move an inserted row. It captures all keys while open (Esc closes).
- Quest screen route prompt: `a` = autopilot on, Quests first, limited to the route's quests (`rules.onlyQuests`;
  clear it with the "Quests goal" row).
- Plan pane (right): status (running / dry run / paused "what it would do" / "waiting for the character
  position…"), goals in rank order, what the plan earns (job pay only; deposits are not losses) and when the next
  level lands, live E/HP/cash/spend. Then "In the queue" and numbered "Planned" rows: icon per kind, gains or
  length, energy before → after, `★` level-up, and the task's reason dimmed under it (shown once when the next row
  shares it, e.g. walk + deposit). Back-to-back runs of one job merge (`×3`); energy waits ≥ 1 min are their own
  `◷` rows.
- Reasons (`PlannedTask.why`): jobs say the goal that gave most of the score (`Candidate.by`): `quest: Cotton for
  "Farmer's woes" (3 left)` (left = before this run) or `best XP per energy · also <quest part>`. Sleeps: `energy low
  (8): sleep until …`; bank: `cash $X is over $Y: banking it`. Home shows the next task's title with its reason.
- Header shows `autopilot ●` while running. Resumes on launch if it was running (after startup + first replan).

## Debugging

- `g x` opens the Debug screen. Every entry also goes to `<config dir>/debug/YYYY-MM-DDTHH.jsonl` (UTC hour,
  one JSON object per line: `id, at, cat, title, data`). Files older than 24 h are deleted when a new hour
  starts. Only the TUI (`root.ts` `makeState`) turns the files on; tests and CLI commands do not write any.
- Categories: `log` (every log-pane line), `state` (diff of server values, queue, quests, bag, worn gear once
  a second; "Started: <task>" when a queued task begins), `request` (every guarded / autopilot call, with
  duration, result or error stack), `autopilot` (runner decisions: idle/acting, wake-up checks, cancel checks
  with both alternatives' values, what it queues and why the batch stopped, duels, failures), `sim` (every
  replan: `reason`, `context`, planner `input` without functions, `output` tasks + timeline), `quest` (finish /
  reward choice, wear, buys and pickups, buy-source reads, time-window re-reads, saloon, accept, skips).
- `runner.context()` is what the autopilot sees: energy, HP, home and nearest town with travel seconds, where
  you are, open quests with each requirement (have / need, nearest source job and seconds from the queue end),
  bag, consumables, gear, queue, budget, needs, failures; per quest `buy` (items to buy, picked source, problem),
  `buyTrips`, `pickups` and `shopsRead`. Logged with every replan; live under **Now**.
- Per-tick decisions use `debug.once(key, …)`, which logs only when the title changes. Keep titles free of
  values that change every tick (live energy) and put those in `data`, or the log fills up once a second.
- Planner input jobs list each duration's `items` as `[itemId, percent]` and the job's `groupid`, so a logged plan
  can be replayed: locations from `job_groups` in the cached minimap (`cache/minimap-*.json`), `wayTime` =
  distance × `travelSpeed` × character speed (check it against `context.homeTown.seconds`), the rest as logged.
- Memory: 3000 entries; only the newest 50 `sim` entries keep their data (the files keep all of it).

## How it plans

- **Inputs**: character (server values), server queue (fixed steps; queued jobs cost no energy, their drops
  count toward needs; queued sleeps keep their room rates in `state.sleepRates`), jobs and locations (drops
  blended with calibration), quest needs (`state.autopilotNeeds()`, below), hotels (home + nearest town, every
  10 min, energy rate × calibrated room scale), named towns, bag consumables above the reserve, budget left
  today, failing step keys, calibrated HP scale, and (when the toggle is on) discovered silver/gold jobs with
  their real `job/job` values.
- **Position first**: the plan starts from `state.queueEnd`. When that is unknown (`Character.init.pos`/task
  coords were `(0,0)` and no live update or queued task has supplied a position yet), the runner does not
  replan or act and the pane says "waiting for the character position…". `(0,0)` is never used as the map
  origin; a live `UserUpdate` or a queued task clears the wait and resumes planning.
- **Quests in scope** (`state.autopilotQuests()`): open quests (or the route's), minus excluded quests / chains,
  repeatables unless on, and quests it cannot finish (`questBlocker`: an item no doable job drops, you do not
  have and it cannot buy, a job you cannot do, or "Go to / Resolve / Accept / Lose against …") unless "also
  quests it cannot finish" is on. A time window ("only available between 06:00 and 11:00") is not a blocker:
  the items get collected and the quest is finished inside the window. Each need carries `weight` (1, up to 2 for a quest ending within 72 h; `questEnds` reads the
  `limited` date as UTC, unverified) and `xpPerUnit` / `moneyPerUnit` (the quests' rewards spread over the units
  they still need), added to the XP and Money goals.
- **Replans** when the fingerprint of those inputs changes (checked every 2 s; queue times and server values
  rounded) and after every action. The plan is saved to `autopilot.json` for display only.
- **Loop** until the timeline reaches `cancel.horizon` (6 h; `MAX_JOBS` = 200 caps it), so plans of short and long
  runs cover the same time and compare: HP under `sleepBelow` → health item that lifts it over, else HP sleep
  (wake ≥ `wakeAbove`) · cash over `bank.above` → walk + deposit (own town within `ownTownWithin`, else nearest
  within `maxDetour`, else checked again after each step, so it banks when the route comes near a town) · your
  inserts at their time · quest shopping trip (below) · best job.
- **Bank walk is sticky**: the deposit is an on-the-spot action, so only the walk goes into the server queue. The
  runner records that walk (`bankWalk` in `autopilot.json`, kept across restarts) and passes its town as
  `bankTownId`. While the queue ends there, the deposit comes first whatever the cash projection says, so no job
  is queued behind the walk. Without this, one replan whose projected cash dipped under `bank.above` put a job
  after the walk, and the next one walked to town a second time (live, 2026-11-04: `telegraph → Slobozia →
  Prospecting → Slobozia`, replayed from the debug log). The record is dropped after the deposit, or when the
  walk is gone from the queue and you are not in that town.
- **Quest items no job drops are bought** (Quests module, "buy items no job drops" on). `state.questPurchase(q)`
  lists what the quest still needs (item / wear / "Item 'X' bought" requirements no doable job covers, minus the
  bag; "bought" always needs a purchase). For several quests (`questPurchases`, used by trips and buying) bag items
  go to the first quest that needs them, solved requirements included (their items go when it is handed in), so
  two quests wanting 2 jugs each buy 4 in one stop. `chooseBuys` picks per item the cheapest option counting the
  walk (price + seconds × `quests.walkValue`, $15 / min; equal: less walk): a shop or the mobile trader (no walk)
  within `quests.buyLimit` ($3,000) for the quest, or a lot of market offers within `quests.marketLimit` ($5,000,
  a separate allowance). A market lot is the cheapest set covering the count (knapsack), overall or within one
  town (one pickup walk can beat a cheaper lot spread over two towns), walked once per town. Left out: sources
  beyond `quests.buyTrip` (the market's too: it is picked up there), $0 prices (unknown, not free), and mobile
  offers limited to fewer than needed. The first item it cannot get makes the quest's blocker (`Jug of water: no job drops it, and no shop in reach …`,
  `… over the $3,000 quest buy limit`) and nothing is bought for it; neither is anything for a quest blocked by a
  non-item requirement (the revolver of "The loser" waits for its duel). The daily cap applies on top.
- **Where it looks** (runner, `scanBuySources`, one read every 3 s at most, in the background like hotel data,
  only while some quest wants an item): the mobile trader (again after 30 min or when it rotates), the three shops
  of the 10 nearest named towns within `quests.buyTrip` of the queue end (each town every 6 h), and the market by
  item name (every 30 min). Each answer bumps `buyCatalog.version`, a planner input, so it replans.
- **Shopping trips**: shop picks of the quests in scope, one `BuyTrip` per town (what, for which quest, cost),
  plus market pickups. The planner walks to the nearest one within `quests.buyTrip` (1 h) and the budget, once per
  plan, and adds the on-the-spot `buy` action (cash − cost in the timeline). A trip further away is tried again
  after each later step. Trips earn no plan value, so cancel-for-better never cancels jobs to go shopping; the
  trip goes in when the queue runs out.
- **Job score**: five separate goals, each gain per cost, divided by the goal's **exchange rate** and weighted by
  rank (1, 0.25, 0.06, 0.015, 0.004) or custom weights:
  - **Quests**: weighted progress toward open quests.
  - **XP**: job XP plus the quests' XP rewards this progress earns.
  - **Money**: job cash plus the quests' money rewards.
  - **Products**: expected listed job drops × item sell price.
  - **Lucky finds**: luck chance × max find value (`minMaxItemVal[1]`), faded by planned motivation.

  Exchange rates = best gain per cost per goal from where the server queue ends, fixed for the whole plan
  (`plan.rates`) and passed to the cancel check's alternatives, so values compare and the last crumbs of a need
  lose to the next goal.
- **Staying put**: the best candidate at the queue-end spot is preferred unless the best one elsewhere is more
  than `jobs.moveMargin` (20 %) better. Travel already costs energy/time, so this stops marginal moves.
- **Cost**: per energy: net energy + (travel + HP regen time + slot cost) × energy regenerated per second. Per
  hour: `min(max(duration, net energy ÷ base regen), duration + net energy ÷ best room rate)` + travel + HP regen
  time + slot cost. Net energy = energy − XP × maxEnergy ÷ XP-per-level (a level-up refills energy), at least a
  quarter of the energy (the refill tops up to the max). Slot cost (`slotCost`, 10 min): each run takes a queue
  slot and the TUI is not always open, so runs that fill slots fast leave you idle.
- **Motivation**: XP, money and luck chance scale with the game's 25 % breakpoints (`ceil(motivation × 4) / 4`);
  product drops and the luck value range do not. Each run lowers the job's motivation by 1 / 5 / 12 % for short,
  middle / long (official mechanics), and the plan tracks the accumulated drop per job, queued runs included.
  Runs whose expected HP loss (heuristic × calibrated scale) would take HP under `sleepBelow` are skipped, HP
  sleeps on or off; runs that cost no HP are always allowed (under the line with no hotel, safe jobs go on while
  HP regenerates). A level-up raises max HP by `lpPerPoint` in the timeline.
- **Energy short**: motivation item at or below 75 %; an energy item when the next level-up is further than
  `levelUpWait` (1 h of natural regen by default) and within one refill (sized to that level-up), or when getting
  the energy otherwise takes ≥ 30 min and the level-up is not near; else sleep when it reaches the wake target
  sooner than waiting; else the timeline waits.
- **Energy items** are sized by effect, not shop price: these items are not regularly purchasable, so the bag
  is the limit, not the item's nominal price. The planner takes the smallest item whose gain covers the next
  run and, while the level-up is within one energy bar, the energy still needed to reach it (best XP/energy job,
  regen during those runs subtracted). If no item covers the level-up need, the largest goes first (most
  progress) and the plan sizes again after it. The max-energy cap counts (`gain = min(effect, maxEnergy −
  current)`), so at 95/100 a 10 % item beats a 100 % tea that both cap at 5. When the level-up is within
  `levelUpWait` of natural regen (waits between the runs included), it waits or sleeps instead of using one; the
  job reason then ends with `level-up in ~N min: waiting`. When it is farther but within one refill, the item is
  used even if each single wait is short; the reason says `for level N`, or `toward level N` when no item covers
  the whole need (the largest goes first). A level out of reach of one refill keeps the 30 min rule. The
  level-up refill itself has been seen live once (calibration `levelUps` 1/1).
- **Wake target** (toggles): when the run after the sleep levels up by itself, just its energy ("enough for X,
  which levels up"); else enough energy to reach the next level with the best XP/energy job (the level-up
  refill does the rest; when current energy already covers that, this used to give no reason and slept to
  full) · 4× the next job · HP safe · full. The sleep's length counts the base regen on the walk to the hotel.
  The runner cancels the sleep once live energy and HP
  reach it.
- **Cancelling**: checked at most every 30 s, at most one cancel per `cancel.cooldown`. Every cut point is
  tried (keep the first k tasks, the running one always, replan the rest with the cancelled jobs' energy back)
  against the whole queue. Cancel when a cut is > `cancel.margin` better over `cancel.horizon`, or when it is
  worth at most `sameWithin` (2 %) less and walks ≥ `walkSaved` (10 min) less. The second rule exists because
  you are usually energy-bound: wasted walking costs almost no value, so a pointless trip (town → job outside →
  town again) never cleared the margin (live: 32.80 vs 32.67, kept). Ties go to the later cut (cancel less).
  A queue worth 0 is cancelled for any plan worth more. The rule is `chooseCancel` (pure, in `autopilot.ts`).
  Queued jobs are scored like planned ones (`plan.queuedValue`: state before each run, quest needs before it
  counts); `plan.walk` is walking inside the horizon, server queue included (fixed steps walk the gap between
  their server times). Replayed on the logged double trip: keep telegraph + walk scores 32.43 vs 31.11 and
  walks 19 min less → Prospecting and the second walk are cancelled. Manual town construction tasks
  (`type: 'build'`) are never cancelled.

## Silver/gold jobs

The map screen's normal 5×5 tile load discovers silver/gold job positions (`TileCache.specialJobs`); there is
no separate scan and no extra traffic. `job/job` for a discovered position gives its real values, parsed into
`GameState.specialDetails`; the jobs screen loads the selected special row on demand (its row says values are
loading until then), and the autopilot loads the discovered ones within a 2 h walk of the queue end, one at a
time, while `use discovered silver & gold jobs` is on (off by default). The planner treats each special as a
location-specific candidate with its own key, coordinates and post; the normal job remains available at its
other locations. Values are not computed: +50 % / +100 % are only the documented boost, the game's own
`job/job` reply is what we use. Special values are refreshed every 30 min while the toggle is on, and a special
older than 30 min is re-read once before it is queued; if it is gone, the plan is rebuilt. Product drops are not
affected by motivation. Discovered positions and their raw `job/job` replies are saved in
`<config dir>/cache/special-jobs-<host>.json` for 24 h and loaded at startup, so a restart does not need the map
or another detail request; entries older than a day, or no longer in a refreshed tile, are dropped.

## Scenarios (`test/scenarios.test.ts`)

About 100 small situations (timeline, job choice, energy, wake targets, HP, bank, quests, motivation, inserts,
the server queue, cancelling), each with the result a good player would want, reasoned out by hand in its
comment. Never fill an expectation in from what the planner returns: when one fails, decide whether the
planner or the expectation is wrong. Add a scenario for every planner bug found live. Buying quest items has its own set in `test/quest-buy.test.ts`
(same rule; its cases B8, B18, B19, B24, B25, S16, S19–S21 each fixed a flaw found while reasoning them out).

## Calibration (`calibration.ts`, `calibration.json` in the config dir; TUI only)

Each estimate blends the game's number (or the old heuristic) with what was observed, the prior counting as 5
samples. Logged to the debug log (`Calibration: …`); `runner.context().calibration` shows the current values.

- **Drops** per job + duration: every new job report (page 1 of the report list, on the "new report" push) is
  read once with `show_report` (`parseJobReport`: `reportInfo.job_id`, `items`, run length from the page).
- **HP loss**: the first server health after a dangerous job ends (live update or sync) vs the regen estimate;
  drops over 30 % of max HP count as attacks and are skipped. Gives `hpScale`, capped to 0.5–3 and passed to the
  fingerprint rounded to one decimal, so tiny calibration changes do not replan.
- **Hotel rooms**: a sleep the autopilot queued and cancelled at its wake target: energy gained per hour vs the
  rate read from the hotel gives `roomScale` (only uncapped sleeps of 15+ min).
- **Level-ups**: whether energy was full after each (`levelUps.refilled / seen`); the planner assumes it is.

## Carrying out (runner: one thing per tick, only while running and not dry run)

wake-up cancel → cancel-for-better → quest step → NPC duel for XP → send planned tasks (as many as the queue and
current energy allow; a sleep ends a batch) or, with an empty queue, the next on-the-spot action (deposit in the
town you stand in, use an item, buy quest items).

- Quest step buying, one purchase per tick: market goods waiting in the town you stand in are picked up first
  (once; a failure leaves it to you); then, for quests buying unblocks, mobile-trader offers (dollar price) and
  market offers are bought from anywhere, shop items when you stand in their town. A market buy is a bid at the
  buy-now price (from the bank when cash is short); the offer is recorded in `pickups` (`autopilot.json`, kept
  across restarts) and becomes a trip to its town. Item failures back off under `item:<base id>`.
- Failures: retry after 1 → 5 → 15 min; after 3 the step key is left out of plans. Session errors pause.
  Exception: a job refused for "N more energy points" is not a failure. Our energy estimate was ahead of the
  server's, so local energy is set to `job energy − N` and the plan is redone.
- **Server queue full** ("You cannot add any more assignments!") is queue state, not a job failure: no failure
  key is added, the queue is refreshed, and adding pauses until the earliest queued task ends (max 60 s). This
  prevents the old loop that cycled the whole 200-task plan once per rejected job.
- Cancel-for-better counts each cancelled job's energy refund at its queued duration's cost, not the long job's.
- Spend cap: hotel rooms and quest purchases count toward `spend.daily` (UTC day). Quest items: shops + mobile
  trader ≤ `quests.buyLimit` per quest, market ≤ `quests.marketLimit` per quest (counted on what is still to buy).
  The $1,000 daily default blocks anything dearer (a $2,800 horse); raise it on the screen for those.

## Modules: status

| Module                                                                                                            | Status                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Queue jobs, priority, look-ahead                                                                                  | built                                                                                     |
| Silver / gold jobs discovered on the map                                                                          | built; toggle off by default, real `job/job` values, no scanning (see "Silver/gold jobs") |
| Energy sleep + wake rules + auto-cancel                                                                           | built (room rate units unverified)                                                        |
| HP (sleep / item / skip risky jobs)                                                                               | built (danger → HP is a heuristic)                                                        |
| Consumables (energy, health, motivation)                                                                          | built; uses what is in the bag (it never buys them)                                       |
| Bank                                                                                                              | built                                                                                     |
| Expanded queue + rules                                                                                            | built (planned jobs can only be excluded, not reordered; inserts can move)                |
| Quests: finish, rewards, wear + restore, accept from saloons                                                      | built                                                                                     |
| Quests: buy items no job drops (shops in reach, mobile trader, market + pickup trip), time windows                | built (remote shop reads of other towns and market buys from afar unverified)             |
| Quests: "Resolve / Accept: X" (accept the quest it waits on), "Go to X" (map giver coordinates), "Lose against X" | **not built** (logged once and skipped); next, after a live look at saloon / map givers   |
| NPC duels for XP                                                                                                  | built; fights only levels the duel record knows (fight NPCs yourself in `g d` to fill it) |

## Decisions (grill session)

TUI only (core has no UI deps) · may cancel anything, running tasks included, when the plan is better by the
margin · manual actions are replanned around unless paused · resume on launch · ranked priority, optional custom
weights · own-town hotel/bank within 1 h, else by cost · bank detour ≤ 30 min else the next town · cancel margin
20 % over 6 h, 15 min cooldown · jobs at the queue-end spot stay unless another spot is 20 % better · server queue
full waits for the earliest task end (max 60 s) · quests: all but excluded chains, time-limited yes, repeatables off · daily cap
$1,000 · quest items no job drops are bought: shops (any town in reach) and the mobile trader ≤ $3,000 per quest,
the market only under $5,000 (its trip to collect counted), trips ≤ 1 h, a minute of walking worth $15 when
comparing sources · health/motivation consumables valued at shop price; energy items sized by effect (their
nominal price is not a real cost) · retries 1/5/15 min, 3 strikes · HP < 50 % sleep or item, up at ≥ 70 %
at a hotel, 50–70 % keep working safely · NPC duels only (never players): HP ≥ 70 %, level ≤ duel level + margin,
one loss stops them for the day, for XP when it beats the best job · plan to the 6 h horizon (was 10 jobs) · skip quests it cannot finish · level-up energy refund always on ·
energy items: smallest that covers the next run and the level-up need, wait up to 1 h for a level-up (setting),
largest first when none covers the whole level-up need, and a farther level-up uses the item even when each
single wait is short · queue slots cost 10 min (the TUI is not open 24/7) · calibrate drops, HP, rooms from your
own game · silver/gold jobs only when discovered by the normal map tile loads, real `job/job` values, toggle off
by default, no scan ·
goals stay separate: Money = cash pay, Products = listed item drops at sell price, Lucky finds = luck chance × max
find value, none folded into another.

## Unverified (check live, then move to docs/game-mechanics.md)

- Hotel room `energy` / `health` units (read as % of max per hour; energy now calibrated from sleeps, health not).
- Cancelling a running sleep keeps the regenerated energy (a sync runs after the first wake-up).
- Silver/gold `job/job` reply shape (`durations[]`, `is_gold` / `is_silver`): from the client bundle, a live
  special has not been captured yet. Drop % > 100 means that many items on average.
- Finishing map-giver quests needs you at the giver (the module walks there after a failed finish).
- NPC duel loss detection (`attacker_died`, or "lost"/"defeat" in the result text).
- Shops of a town you are not in can be read (`building_<shop>&town_id=N`; seen for the home town only).
- A market instant buy works from anywhere and the goods wait in the offer's town (`fetch` there).
- A time-window requirement turns solved inside the window (the quest module re-reads the log every 10 min).
- Mobile trader offers carry full item ids (base × 1000, like the bag) and can be bought `limited_count` times.
