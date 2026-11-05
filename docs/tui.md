# TUI conventions

Ink (React without JSX: `const h = React.createElement`). Shell in `src/tui/app.ts`, connect/setup in `root.ts`.

## Startup

- `Root` connects (`ensureGame`) and shows `LoadingFrame` with a running "Connecting to The West" step; the
  connect time is passed to `GameState.start({ connect })`, which lists it as the first, finished loading step.
- `LoadingScreen` (in `App`) shows `state.startup.steps` until `startup.done` (Esc skips).

## Keys

- `App`'s `useInput` handles **global keys first**, then screens get the rest. Only five are single keys: `?` help,
  `q` quit, `m` map, `u` refresh, `g` go-to. Everything else is `g` + a key from `GOTO` (`overlays.ts`, shared by
  the nav bar, the help and the handler): `h` home · `j` jobs · `m` map · `i` character · `t` town · `q` quests ·
  `r` mail · `b` trade · `d` duels · `c` chat · `a` autopilot · `x` debug, plus `s` sleep · `p` places · `L` live ·
  `R` reload · `A` account. While `g` is pending the nav bar shows "go to ›" and the key line lists the actions.
  Keep it that way: new screens and rare actions go under `g`, so screens keep the letters.
- **Esc is back**, one step: overlay → panel / detail focus → previous screen. `App` keeps a history (`go(m)` /
  `back()`; a screen appears in it once, so going back never loops; empty history = home). Screens call
  `onExit` (= `back`). A screen's own key never toggles it off; pressing it again does nothing.
- **Two-pane screens** (mail, quests, character inventory, debug): `j k` move in the list; `l` focuses the detail
  pane (cyan border, list dims) and then `j k` / PgUp PgDn scroll it; `h` (or Esc) returns to the list. Mail's
  Enter opens and focuses at once; Esc there also closes the message. `Tab` stays a tab/pane switch. `J K` are
  only used to _move_ an item (autopilot priority and inserts), never to scroll.
- Screens (`SCREEN_MODES`) receive `onCapture(bool)`: while true, global keys are skipped (text entry, confirm
  prompts, the autopilot's queue view). Always release it on close/unmount.
- Taken screen-level uppercase keys: `P` (trade: pick up), `R` (quests/mail; autopilot: run/pause), `U`
  (character: use item), `X`/`Q` (autopilot). Quests use `v` (not `g`) to show jobs on the map; the map uses `e`
  for the queue end. Check `grep "input === '<k>'" src/tui` first.
- Help text lives in `SHORTCUTS` in `overlays.ts`; add a section for every new screen (`Record<Mode, …>` is
  exhaustive, so does `MODE_TITLE`).

## Screens

- **Header**: two data lines with blank separators; another line appears while a seasonal event is active, with
  the event name, personal progress toward the next reward, and the names of ready event generator items (green).
  The line is driven by `state.event` and `state.eventReadyItems()`; a body row is reserved only while it is shown.
- **Home** (`home.ts`, mode `home`, the start screen; `g h`; where Esc ends up): working panel
  (queue head: progress bar, time left, expected rewards via `state.queuedJob()`, "✓ done" with the report
  summary for 30 s, autopilot status), session (measured XP/h and $/h from `state.rates`, queued rate from
  `state.timeline()`, level ETA, regen "full at"), task queue (`QueuePane` from `queue.ts`, shared with the jobs
  screen; fills the rest of the left column, rows measured with `measureElement`), minimap (`buildGrid` around `@`, +/-),
  newest reports (`state.recentReports`), interactive chat. Small terminals drop chat (< 23 rows), then the
  right column (< 96 cols).
- Reports on home cost no polling: one read on first show, then the live "new report" push (which already
  fetches page 1 for its log lines) fills `recentReports`; without live updates, one re-read 5 s after a job ends.
- **Jobs** (mode `main`, `g j`): full-height list (xp / $ of the longest run, LP, travel; `!` marks jobs for the
  highlighted quest), detail with xp per energy, queue with its end time and total. No chat here.
- **Debug** (`debug.ts`, mode `debug`, `g x`): left the debug log (`state.debug`, newest followed at the bottom
  until you move up; `f` category, `/` title filter), right the selected entry's data as pretty JSON (`l`, then `j k`
  scroll). `Tab` switches to **Now**: `runner.context()` live, one line per field, lists one item per line.
- **Character** (`character.ts`, mode `char`, `g i`): three tabs, `← →` cycles Inventory → Sets → Skills. Bag
  `Enter/e` uses an item when `usetype !== 'none'` (coffee is a usable `yield` product) and equips it only when
  it has `usetype: 'none'`; `U` always opens the use form. **Sets** lists `inventory/show_equip` sets, shows the
  slots and the currently worn alternative, and `Enter` + `y` switches (`switch_equip`). `S` saves the current
  wear as a new named set (`save_equip`); `R` + `y` replaces the selected set (`replace_equip`); delete stays
  browser-only.
- **Trade** (`trade.ts`, mode `trade`, `g b`): Bank · Mobile trader · General store · Tailor · Gunsmith · Market ·
  My market. Mobile trader loads `shop_trader`'s `trader` offers anywhere, shows the dollar price and rotation
  time, and buys with `Enter`; the bag and offers are re-read after a buy.
- **Chat** (`chat.ts`, mode `chat`, `g c`): for the town room, a third column lists the clients in the room with
  presence (● online / ◐ idle, 5 min), name, role (Mayor / Councillor / Citizen / Guest) and level, online-first.
  It is hidden below 90 columns with a note; whisper/saloon rooms keep the two-column layout.
- **Daily login bonus**: no screen. `GameState.start()` checks `Player.hasLoginBonus` and collects once after the
  startup steps; the log line shows the reward. `daily bonus pending` stays in the header only if collection
  failed. The separate 7-day pony-express delivery is not shown.
- **Town** (`town.ts`, mode `town`, `g t`): the home town's city hall (`building_cityhall`), building levels,
  progress bars, and construction detail. `Enter` opens a form with the available duration and payer (town
  treasury / private), then queues a `taskType: 'build'` task. `u` refreshes; it does not use the town you are
  standing in.
- **Log pane** (bottom, all screens): 3 lines, 5 from 32 rows; twice that on home and jobs. Logged: finished
  tasks, each new report once (`reportLogLine`: job XP, $, event currency, found items; others by title; ids in
  `seenReports`), item uses (manual and autopilot), level-ups, autopilot actions, errors.
- **Map**: `m` (or `g m`) opens it; Esc closes the selection panel, then goes back like any screen.

## Rendering

- The 1 s ticker in `App` re-renders and drives `state.tick()`, queue polls, syncs and `state.runner.step()`.
- `GameState` emits `change`; `useGameState` re-renders on it. Components read state directly (no copies).
- Lists use `scrollWindow(selected, total, rows)`; text is `wrap: 'truncate'` with `truncate()` for columns.
  Durations: `formatDuration` (`1:02:03`, ticking clocks) or `shortDuration` (`15s`, `45m`, `2h10`, plans and estimates; under a minute in seconds, so a 15 s run is not "1m").
- Icons: `src/tui/icons.ts` (`ICON`, `taskIcon(type)`, `stepIcon(step, action)`): ⚒ job, → walk, ☾ sleep, $ bank,
  ✚ item, ◷ wait, ★ level-up, ⚔ duel, ! quest, ✉ mail. One-cell text symbols only; emoji are two cells wide
  and misalign Ink columns. Used in the header, jobs queue, home working panel, autopilot plan and Q view.
- Coloured wrapped text (chat lines): `wrapSegments()` in `form.ts` wraps `{text, color}` runs like `wrap()`.
- Ink props may be left out but not set to `undefined` (`exactOptionalPropertyTypes`): wrap props with a
  conditional value in `defined({ color: sel ? 'cyan' : undefined })`. Own components type such props
  `x?: T | undefined` instead.
- Tests render with a `PassThrough` stdout (`isTTY`, `columns`, `rows`) and strip ANSI; a stub state must be
  re-rendered by hand (`app.rerender`) since it does not emit `change`.
