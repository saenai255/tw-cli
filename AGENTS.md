# AGENTS.md

Guide for coding agents working on tw-cli, a terminal client for The West (world en32). Read this first, then
the relevant file in `docs/`.

## 1 % better every day

Leave the project a little better than you found it, every session, on top of the task: fix one stale doc line,
one misleading name, one missing test, one rough edge you passed by. Small and safe, in the same change, said in
the summary. Small gains compound; nobody needs to schedule a cleanup.

## Keep this knowledge current (do this every time)

- **Update this file and `docs/` as part of every change**, in the same commit or edit session, without being
  asked. If you learn something non-obvious about the game, the code or the user's preferences, write it down.
- Put game behaviour (endpoints, formulas, units, quirks) in `docs/game-mechanics.md`, the autopilot in
  `docs/autopilot.md`, TUI conventions in `docs/tui.md`. Add a new `docs/*.md` for a new area and link it below.
- Improve what is there: fix anything you find wrong or stale, merge duplicates, move "unverified" items to
  verified once checked live (say how). Keep entries short and factual; no change logs (git has those).
- Keep the docs index below in sync with the files in `docs/`.
- **Keep `README.md` up to date** in the same change: commands, keys (the go-to table mirrors `GOTO` in
  `src/tui/overlays.ts`), what the autopilot does and does not do yet, setup, CI. It is for players, so describe
  behaviour, not code; link to `docs/` for detail.

## Docs index

- `docs/code-style.md`: how code here should read (intent over mechanics, types over comments, pure core,
  interfaces over classes, full names, errors as values, tests as specs, structured logs). Read before writing code.
- `docs/autopilot.md`: Autopilot spec, architecture, modules, decisions, what is not built yet.
- `docs/game-mechanics.md`: The West as the client sees it: endpoints, formulas, units, verified vs unverified.
- `docs/tui.md`: screens, key handling (global vs screen keys), input capture, rendering conventions.
- `docs/endpoints.json`: game endpoints extracted from the client bundle (`npm run endpoints`).

## Commands

- `npm run tw`: full-screen TUI · `npm run tw -- <cmd>` for CLI commands (whoami, jobs, queue, login, …).
- `npm test`: all tests (`node --test test/*.test.ts`). Some skip without a saved `game.php`.
- `npm run typecheck`: `tsc -p .`. Run it and the tests after every change.
- `npm run lint`: `biome check .` (formatter + linter, zero warnings). `npm run format`: `biome check --write .`;
  `npm run format:unsafe`: also applies unsafe fixes (for example `useBlockStatements` wrapping one-line `if`s).
  Biome owns layout, quotes, semicolons, braces and import order (see `docs/code-style.md` §20); do not format by hand.
- CI (`.github/workflows/test.yml`, badge in the README): typecheck + lint + tests on Node 26, Ubuntu, for pushes to
  `main` and every PR. The two login tests that check 0600 file modes fail on Windows only; CI runs them. The test
  step sets `CI=false`: with `CI` set, Ink (is-in-ci) writes only the last frame and every TUI test sees nothing.

## Layout

- `src/game/`: game logic, no UI. `state.ts` (GameState: owns the client, keeps state in sync), one module per area
  (jobs, tasks, quests, hotel, trade, townhall, event, loginbonus, duels, …), the autopilot (`autopilot*.ts`, `timeline.ts`,
  `quest-buy.ts` for buying quest items), `debug-log.ts` (`state.debug`: everything, with data;
  hourly JSONL files kept 24 h in `<config dir>/debug/`, Debug screen `g x`), `calibration.ts` (what the
  autopilot learns from reports, health, motivation and sleeps; `calibration.json`).
- `src/tui/`: Ink (React) screens; `app.ts` is the shell (header, nav, ticker, global keys), `root.ts` connects.
- `src/util/`: `json.ts` (narrowing unknown JSON), `errors.ts` (`errorMessage` for a caught value), `defined.ts`
  (drop undefined props), disk cache, wake detection.
  `src/types/reset.d.ts`: lib typings that would hand out `any`.
- `src/http/`, `src/auth/`, `src/fingerprint/`, `src/realtime/`: transport, login, fingerprint, chat long-poll.
- `test/`: node:test. `features`/`social`/`setup` tests set `TW_CLI_HOME` to a temp dir; new tests that write
  config must do the same (never write the user's real `~/.config/tw-cli`).

## Conventions

- Write new and touched code to `docs/code-style.md`. Where it conflicts with a project rule below, the project
  rule wins.
- TypeScript run directly by Node ≥ 26 (no build). `.ts` import specifiers. ES modules.
- Types are as strict as tsc allows (`tsconfig.json`: `strict` plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, unused locals/params, no implicit returns/overrides). Left out on purpose:
  `noPropertyAccessFromIndexSignature` (only forces `o['x']` over `o.x`, no safety gained).
- No `any` outside `test/` (`test/types.test.ts` fails on one). Server and file JSON is `unknown`
  (`src/types/reset.d.ts` makes `JSON.parse`, `res.json()` and `Array.isArray` say so); narrow it with
  `src/util/json.ts` (`obj`, `arr`, `objs`, `vals`, `entries`, `nums`, `mergeDefaults`) and coerce each field
  (`Number()`, `String()`, `plainText()`). `GameClient.remoteCall`/`get`/`remoteCallMode` return a `JsonObject`;
  `remoteCallRaw` for the few array replies. An optional field that may be set to `undefined` is typed
  `x?: T | undefined`; Ink props built with `cond ? v : undefined` go through `defined()` (`src/util/defined.ts`).
- Match the surrounding style: short header comment per file saying what it mirrors in the browser client
  (often with `@offset` into tw2game), terse JSDoc on non-obvious members, no comments that restate code.
- Pure logic (planners, parsers, formulas) lives apart from requests so it can be unit-tested with fixtures.
- Shared domain facts have one home: `isDoable`, `motivationFactor`, `MOTIVATION_LOSS` (jobs), `baseId` (items),
  `questInScope` (autopilot-config), `DEFAULT_WALK_ENERGY_PER_SECOND` (route), `errorMessage` (util/errors).
  Import them instead of repeating the comparison or number.
- Requests go through `GameState`: `guard()` (busy lock, logs errors) for user actions; `autopilotCall()`
  (busy lock, throws) for the autopilot, which needs the error to back off.
- Line endings are mixed (several files are CRLF). The Edit tool handles both. When scripting edits with Node,
  normalise to `\n`, edit, and write back with the file's original ending. Backslashes do not survive JS
  strings inside heredoc'd Node scripts (`\d`, `\/`, `\n` come out wrong): write any line with a regex or an
  escape using the Edit tool, then grep for `(d+)` or broken string literals and typecheck. In a scripted
  `s.replace(a, b)`, `$'` / `$&` inside `b` are patterns (a `'$'` in `b` pasted the file's tail): use
  `s.split(a).join(b)`.
- New autopilot or state behaviour logs to `state.debug` (`add`, or `once` for per-tick decisions) with the data
  that drove it; label new `autopilotCall(fn, label)` calls so the request log says what they were.
- Settings and caches live in `CONFIG_DIR` (`TW_CLI_HOME` or `~/.config/tw-cli`), written with mode 0600.

## User preferences (learned)

- Plans are discussed and agreed before building ("grill" style: numbered questions with a recommended answer).
- Everything the autopilot does is a toggle; defaults are safe (starts paused unless it was running, dry run).
- Unverified game behaviour is labelled as such in code comments and docs, and checked live when possible.
- Keys: vim-like and predictable. Esc is always "back", `q` the only quit, no toggle keys, lowercase `j k` (never
  `J K`) to scroll, mnemonic letters behind the `g` go-to menu rather than odd single keys (see `docs/tui.md`).
- No single-letter variables or parameters, even in small callbacks: write `index`, `entry`, `option`, `xCoord`,
  `yCoord` (the only short names kept are words like `id`, `url`, `html`).
- Energy items are not valued by their nominal shop price (they are not regularly purchasable): use the
  smallest item that covers the next run and the energy still needed for the next level-up, waiting up to an
  hour for a level-up; if none covers the level-up need, the largest goes first. A level-up farther than that
  wait but within one refill uses the item even when each single wait is short.
- Job rewards have separate goals: Money = cash pay, Products = listed item drops × sell price, Lucky finds =
  luck chance × max `minMaxItemVal`. Never fold luck into Money or Products.
