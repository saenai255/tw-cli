# tw-cli

[![Tests](https://github.com/saenai255/tw-cli/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/saenai255/tw-cli/actions/workflows/test.yml)

A terminal client for [The West](https://www.the-west.net) (world en32 "Quebec"). It uses the same HTTP requests as the browser game.

> Unofficial. Third-party clients may break InnoGames' terms of service. Use at your own risk.

## Install

Needs Node ≥ 26 (it runs the TypeScript directly).

```sh
git clone https://github.com/saenai255/tw-cli
cd tw-cli
npm install
```

## Set up (once)

The game records a browser fingerprint at login, so tw-cli needs the fingerprint of the browser you normally play with.

**Easiest:** run `npm run tw -- web`, open the local page it prints, and log in there. It captures the fingerprint and saves your session.

**Or by hand:**

1. Open `game.php` in your browser while logged in, paste `tools/capture-fingerprint.js` into the DevTools console, and save the copied JSON to a file.
2. `npm run tw -- fp import <file>`
3. `npm run tw -- login` (asks for name and password; or set `TW_LOGIN_NAME` / `TW_LOGIN_PASSWORD`)

Everything is stored in `~/.config/tw-cli/` (session with mode 0600). Set `TW_CLI_HOME` to use another folder.

## Use

```sh
npm run tw            # full-screen TUI
npm run tw -- whoami  # character status
npm run tw -- jobs    # doable jobs, nearest location, travel time
npm run tw -- queue   # task queue
npm run tw -- web     # local page for fingerprint + login
```

In the TUI, press `?` for help on any screen. Keys are vim-like: `Esc` always goes back one step, `q` quits,
`j k` move, and every screen is `g` + a letter (the nav bar shows them while `g` is pending).

| Key           |                                                                                   |
| ------------- | --------------------------------------------------------------------------------- |
| `g h`         | home: current job, XP/h and $/h, queue, minimap, reports, chat (the start screen) |
| `g j`         | jobs & queue (`1` `2` `3` start the selected job: short / medium / long)          |
| `m` or `g m`  | map                                                                               |
| `g i`         | character: inventory, equipment sets, skills                                      |
| `g t`         | town: city hall, building levels, construction                                    |
| `g q`         | quests: log, quest givers, routes                                                 |
| `g r`         | mail: reports & telegrams                                                         |
| `g b`         | trade: bank, shops, mobile trader, market, buy orders                             |
| `g d`         | duels: NPCs & players                                                             |
| `g c`         | full chat with whispers (`g L` turns live updates on)                             |
| `g e`         | events: seasonal currency & rewards, gifts to friends, Loteria, community event   |
| `g a`         | autopilot                                                                         |
| `g x`         | debug log: everything the client and autopilot did, with the data                 |
| `g s` · `g p` | sleep in a hotel · points of interest                                             |
| `u` · `g R`   | refresh · reload everything                                                       |
| `g A`         | account setup                                                                     |

## Autopilot

Plays the character while the TUI is open (`g a`; `R` runs / pauses, paused only shows what it would do). Every
part is a toggle with safe defaults, and the plan pane says what it will do next and why.

- **Jobs** by your ranked goals (quests, XP, money, products), planned 6 h ahead, per energy or per hour.
- **Sleep** when out of energy or low on HP, and wakes early once energy is enough to level up or for the next
  stretch; uses energy / health / motivation items from the bag when that beats waiting.
- **Banks** cash over a limit when a town is on the way.
- **Quests**: works on what open quests need, finishes them (picks the reward by your priority), wears quest
  gear and puts yours back, accepts saloon quests in towns it passes, and finishes time-window quests inside
  their hours. Items no job drops are **bought**: in the shops of towns within a trip limit, from the mobile
  trader, or on the market (instant buy, then a trip to collect). It counts walking against price, keeps to
  $3,000 per quest in shops ($5,000 on the market) and to the daily spend cap.
- **NPC duels** for XP when the record says they are won and beat the best job (never players).
- **Event gifts**: during a seasonal event (Day of the Dead, …) it sends your daily event currency to all
  friends who can get it again. The Loteria card game is announced but left to you (`g e`).
- Cancels queued tasks when a fresh plan is clearly better, retries failures with backoff, and learns drop rates,
  HP loss, motivation and hotel rates from your own reports.

Not yet: "Go to …", "Resolve / Accept: …" and "Lose against …" quest steps (skipped and logged). Details in
[`docs/autopilot.md`](docs/autopilot.md).

## Develop

```sh
npm test          # tests (some skip without a saved game.php)
npm run typecheck
npm run lint      # Biome formatter + linter
npm run format    # apply Biome's fixes
npm run endpoints # list game endpoints from the client bundle → docs/endpoints.json
```

GitHub Actions runs the typecheck, lint and tests on every push to `main` and every pull request (badge above).
Coding agents: start with [`AGENTS.md`](AGENTS.md); game behaviour is in [`docs/`](docs/).
