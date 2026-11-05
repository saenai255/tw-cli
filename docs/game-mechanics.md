# Game mechanics (as the client sees them)

What tw-cli relies on about The West, with where it comes from. **Verified** = seen in live replies or the
browser client's code; **unverified** = assumed, check live and update this file.

## Time, energy, health

- Server time: `Game.init.sincepoch`, refined by `POST /ntp.php` (epoch ms). `ServerClock` in `clock.ts`.
- Regen is continuous: `max · regenFactor · seconds / 3600` (`Character.tick4Character`), for energy
  (`energyRegenFactor`) and health (`healthRegenFactor`). Live `UserUpdate`s carry `energy_date` /
  `health_date` as an **offset in seconds from now** (negative: measured that long ago), not a timestamp:
  `Character.setEnergy(e, d)` sets `energyDate = Game.getServerTime() + d` (seen live: `-1176`). Character.init has
  no date (now). `CharacterState` regenerates locally from the last server value. Verified (debug log, en32).
- Queue `date_start` / `date_done` come back with sub-ms differences between polls (clock offset): round them
  before comparing.
- Max HP: `100 + (level − 1)·lpPerPoint + healthSkill·(lpPerPoint + lpPerPointBonus)` (`calcMaxHealth`). Verified.
- **Jobs pay their energy when queued** (task/add reply may carry the new `energy`; if it does not, subtract
  locally). Cancelling a queued job refunds it. Verified for queued; running-job refund unverified.
- **Level-up refills energy and health.** Assumed by the autopilot timeline; unverified (check on the first
  live level-up: sync right after and compare).
- Level XP: `levelStartXp(l) = floor((Σk² + 10(l+1) − 21)·3) + 1000·(l−120)^2.9 above 120` (`calcLowerExp`). Verified.

## Tasks and queue

- `task/add {tasks: {<queuePos>: post}}`; positions continue from the queue length. Posts:
  job `{jobId, x, y, duration, taskType:'job'}` · walk `{unitId, type, x?, y?, taskType:'walk'}` (type `town`,
  `fort`, `questgiver`) · sleep `{town_id, room, taskType:'sleep'}` (the server walks there first).
- `task/cancel {tasks: {<pos>: {queueId, type}}}` returns the new queue (+ `extra.energy` / `extra.money`).
- Queue entries carry `date_start` / `date_done` (epoch s), coords, `wayData` (the walk part). They do **not**
  say which duration a job was: infer from `date_done − way end` vs the job's short/middle/long values.
- Queue limit: `taskLimit.normal` (4) / `.premium` (9, with the automation premium bonus).

## Jobs

- `work/index` gives per-character values per duration (energy, money, xp, luck, item drops); `job/job` is the
  only source of **danger** (0–100) and live **motivation** (0–1).
- Item drops: expected items per run = `(prop + probBonus) / 100`.
- Travel time: `distance · Game.travelSpeed · Character.speed` seconds.
- Expected HP loss from danger: no formula known. The autopilot uses a heuristic (danger % of 10 % max HP per
  hour of work). Unverified.

## Hotel and sleep

- `building_hotel get_data {town_id}` → `rooms: {cubby|bedroom|hotel_room|apartment|luxurious_apartment: {name,
  level, available, free, costs, energy, health}}`.
- Room `energy` / `health` are points scaled to your max (verified live 2026-11-03, level-5 hotel, max HP 610:
  cubby 64/390 … luxury 100/610 = 64 % … 100 % of max). **The time unit is unverified**; the autopilot reads them
  as % of max per hour (`roomRate` in `hotel.ts`) times a room scale calibrated from real sleeps (energy only).
- A job the energy does not cover is refused with "You need at least N more energy points to work on this job."
- Whether cancelling a running sleep keeps the energy regenerated so far: unverified (the autopilot syncs right
  after its first wake-up cancel).

## Bank and money

- `building_bank get_data {town_id}` → `deposit_fee` (%) differs per town; deposit `{town_id, amount}` →
  `{deposit, own_money, fee}`. No withdrawal: purchases take cash first, then the bank. You must be in the town.
- Cash in pocket can be lost in duels; that is why the autopilot banks over a limit.

## Town buildings and construction

- `building_cityhall` action '' `{town_id}` → `{townName, townNoLeave, buildings:[{key, name, stage, maxStage,
  infinite, buildPoints, nextStagePoints}]}` (verified live). The city hall list shows the current level and
  progress to the next; `infinite` is the church (always more stages).
- `cityhall_build/build` (mode) `{x, y, building:<key>}` → `{build_name, description, build_skills:{skills:
  [{skill, coefficient}], malus}, jobPoints, build_point, build_point_limit, deposit, motivation,
  jobDurationData:{<seconds>:{calcduration, formatted, expCalc:{min,max}}}, defaultData, singleDuration}`
  (verified live). `x`/`y` are the home town coordinates; `deposit` is a formatted string ("35.064").
- Construction is a queued task, `taskType: 'build'`: `{x, y, building_key, duration, deposit:'town'|'player',
  taskType:'build'}` (TaskBuild @689326). `town` pays from the town treasury, `player` from cash/bank. The server
  walks there first, like a job.

## Items

- Item ids: plain id = base id · 1000; upgrades add to the last digits (`baseId`, `upgradeLevel`).
- `usebonus` texts on `usetype: 'single'` items: `Energy increase: 15%`, `Health point bonus: 20%`,
  `Work motivation increase: 15%`, `Duel motivation increase: 15%`, `Active waytime shortening: 25%`.
  `usetype: 'buff'` items give skills/speed for N uses; `'use'` items are boxes/cards. Verified from the catalog.
- **Usable products win over their wear slot.** Coffee is `type: 'yield'` (the Product slot) with
  `usetype: 'single'`/`action: true`; the browser uses it, it is not equipped. Plain products such as The Joker
  have `usetype: 'none'` and are worn in `yield`.
- Shops: `building_general|tailor|gunsmith&town_id=N` → `trader_inv` (item ids), `charge` multiplies the price.
- **Equipment sets**: `inventory/show_equip` (mode) → `{data:[{equip_manager_id, name, head, neck, body,
  right_arm, left_arm, yield, foot, animal, belt, pants}], max, premium_max, hasPremium, price}` (verified live,
  en32: two sets, max 3). `inventory/switch_equip {id, last_inv_id}` → `{changes, wear:[item ids], setItems,
  workPointBonus, speed, weapon}`; `wear` is the complete new worn list (the list endpoint is verified live; the
  switch shape is from `EquipManager.switchEquip`). Save / replace / delete are `save_equip` / `replace_equip` /
  `delete_equip`, not used by the TUI yet.

## Mobile trader

- The "Mobile Trader" is the `trader` tab of the item shop, not a town shop: `shop_trader/index` (mode) {} →
  `{inventory:{trader:[...]}, currencies, traderTime (epoch s)}` (verified live). Offers rotate; `currency` is a
  bitmask (1 bonds · 2 nuggets · 4 dollar · 8 veteran) and prices are `price_<currency>`; `reduced_value` is a
  percent discount, `limited_time` / `limited_count` limit the offer. Live offers were all dollars.
- Buy: `shop_trader/buy {item_id, category: <tab, trader>, currency:<name>}` → `{cash, deposit, bonds, msg}`.
  The reply has no bag changes; the inventory has to be re-read.

## Quests

- Requirement `jsInfo.type`: `inventory_changed` (have item) · `wear_changed` (wear item) · `task-finish-job`
  (`count` = runs, or seconds for timed ones). `jsInfo: null` texts include `Item 'X' bought` and wait timers
  ("you must wait 24 hours"). Shapes for "visit a place" and duel requirements: **not seen yet**.
- Other `jsInfo: null` texts seen live (en32, 2026-11-04): `Go to <place>` (The Mexican, Junction, Ghost town,
  Waupee's Indian village, Steve Chuck), `Resolve: <quest> (<chain>)` / `Accept: <quest> (<chain>)` (another quest
  of the chain, not in your log), `Lose against <NPC>`, and `This quest is only available between 06:00 and
  11:00 o'clock.` (parsed as kind `window`; which clock is unverified, the server's presumably).
- The minimap's `quest_locations` is `{id: [[x, y]]}`: coordinates without names, so "Go to X" cannot be placed
  from it alone.
- `finish_quest` replies may carry `eval` (browser JS): never executed.
- Map quest givers probably require being at the giver to finish; town (saloon) quests from the town. Unverified.

## Duels

- `duel/get_data` → NPCs `{duelnpc_id, npc_name, npc_level, weapon_id, arrival_delta}` and `difficulty`; no win
  odds. `duel/duel_npc {duelnpc_id}` fights at once and returns rounds, energy, health, money, experience.
- Player duels are tasks (`taskType: 'duel'`). The autopilot never duels players.

## Reports

- `reports get_reports {page, folder}` → rows with `popupData`: an HTML table whose field labels are icons
  (`images/job/clock.png` time, `dollar` money, `upb` bonds, `experience` XP, `danger`, event icons) and found
  items as one `<img alt="name">` per item. `popupText` / `popupItems` in `mail.ts` turn that into text.
- `reports show_report` → `page` (HTML; the "Items Found" block is an empty `<span id="jobreward_item_<report>_<item>">`
  the browser fills from `js`) and `reportInfo: {items: [[itemId, ?, count, type], …], job_id}`: the found
  items. Verified on a live Prospecting report (5× Fool's gold).

## Events (`events.ts`)

- **Seasonal events (SES)** come from `Game.init.sesData` in game.php: per event id (`DayOfDead`, `Hearts`,
  `Easter`, `Independence`, `Octoberfest`) `meta {start?, end}`, `counter {key: 'ses:<stat>', value}`, milestone
  `rewards {<collected>: {id, desc}}` (`id` is an item id, `wof-unlock` or `avatar-part-N`), `friendsbar {label,
  cooldown}` and `premium`. The browser's `west.events.Manager` starts and stops them by those dates.
- Dates are `dd.mm.yyyy hh:mm[:ss]` in server time, Europe/Berlin: DayOfDead's end `16.11.2026 12:00` equals the
  wheel's epoch `endDate` 1794826800 (11:00 UTC). Verified from the saved game.php.
- The counter is pushed on the chat long-poll: `SesStatChanged {<stat>: value}` (the client signals
  `ses:<stat>`). Most currency comes from jobs (the report's unlabelled `355 Cempasúchil` line); the log is
  `ses/log` (mode) `{ses_id, page, limit: 25}` → `{entries: [{date, type, value, description, details}], page,
  hasNext}`, where `wofPay` values are spent.
- **Friend gifts**: `friendsbar/search` (mode) `{search_type: 'friends'}` → `players` and `eventActivations
  [{friend_id, event_name, activation_time}]`. A friend can get one gift per `cooldown` (82,800 s = 23 h for
  DayOfDead). `friendsbar/event {player_id, event}` sends to one, `event_all {event}` to all eligible (the
  browser's double click); both answer `{error, msg}`. Not yet seen live.
- **Community events**: `Game.init.ceData` `{<id>: {event_name, event_end, event_progress, event_stages
  {<points>: [{reward, reward_id, text}]}}}`, progress shared by all players; chat `CommEventChanged {event_id,
  event_stage}`.
- **Wheels**: `west.wof.WofManager.init([{id, type, name, title, free, endDate}])` in game.php. `dayofdeadwof` is
  the Loteria de Muertos card game: `wheeloffortune/init` (mode) `{wofid}` → `mode {game {free_games, status,
  current {stage, bribe_cost, change_reward_cost}}, stages [{rewards, card}], cost, currencies, conversion}`,
  `prizes.gamblePrizes`; `wheeloffortune/gamble {action, wofid, …}` → `{game, stages, nuggets?}`. Five stages of three
  cards. Status `closed → running` (open: free or `{currency_id}`) `→ won | lost` (gamble `{card}`); from won,
  `continue` to the next stage (a wrong card loses the reward) or `end` to collect; from lost, `bribe
  {currency_id: 2}` (nuggets) or `end`; on stage 5, `change {currency_id}` rerolls the reward. Pay ids: 1 bonds ·
  2 nuggets · 4 dollars · 8 veteran points · 16 event currency (`conversion` scales the price). Unverified: the
  reward and price shapes in replies (read from the client only).

## Chat

- Messages carry links as tags in the text: `[item=<instance id>]` (seen live: `wtb [item=42085000]`). The client
  shows them as names (`chatlinks.ts`: items yellow, set items green). `[quest=<id>]` is assumed the same way
  (unverified); its title is only known for quests in the log or at the open employer, else `quest <id>`.
- Town room members and every `Status.clients` entry carry `town_rights`: 0 none/guest · 1 citizen · 2 councillor ·
  3 town founder (shown as mayor). `actioned` is epoch ms; the browser treats a client idle after 5 minutes
  (Chat.Resource.Client.updateStatus @1029000). Town chat is the only room where the browser shows these roles.
