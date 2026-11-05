// Seasonal / community events, friend gifts (autopilot), the Loteria card game and the Events screen.
// Data shapes from en32's game.php (Day of the Dead 2026) and the client JS (offsets in src/game/events.ts).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'twcli-events-'));
process.env.TW_CLI_HOME = home;
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
process.env.TW_ITEMS_FILE = `${FIX}items.sample.json`;

const React = (await import('react')).default;
const { render } = await import('ink');
const { CookieJar } = await import('../src/http/cookie-jar.ts');
const { GameClient } = await import('../src/http/game-client.ts');
const { resetThrottle } = await import('../src/http/throttle.ts');
const { GameState } = await import('../src/game/state.ts');
const { parseBootstrap } = await import('../src/auth/bootstrap.ts');
const { ChatPoller } = await import('../src/realtime/chat.ts');
const events = await import('../src/game/events.ts');
const { App } = await import('../src/tui/app.ts');

const WORLD = 'https://en32.the-west.net';
const FAST = {
  concurrency: 1,
  minIntervalMs: 0,
  jitterMs: 0,
  maxRetries: 0,
  baseBackoffMs: 0,
  maxBackoffMs: 0,
  breakerThreshold: 100,
  breakerCooldownMs: 0,
  timeoutMs: 5_000,
};

/** game.php's sesData / ceData on en32, 2026-11-04 (rewards trimmed). */
const SES_DATA = {
  DayOfDead: {
    meta: { end: '16.11.2026 12:00:59' },
    rewards: {
      '100': { id: 'wof-unlock', desc: 'The Loteria de Muertos has been unlocked!' },
      '10000': { id: 50301000, desc: 'An energy box for gathering 10.000 flowers!' },
      '500': { id: 51775000, desc: 'A motivation box for gathering 500 flowers!' },
      '55000': { id: 54974000, desc: "You receive Xólotl Spirit's arrows!" },
    },
    counter: { key: 'ses:dayofdead_collected', value: 50093 },
    friendsbar: { label: 'Send 20 Cempasúchil Flowers', cooldown: 82800 },
    premium: 60,
  },
};
const CE_DATA = {
  dayofdead: {
    event_id: 'dayofdead',
    event_name: 'Day of the Dead 2026',
    event_end: '16.11.2026 12:00',
    event_stages: {
      '45000': [{ reward: 'item', reward_id: 2137000, text: 'Red letter (1)' }],
      '10000': [{ reward: 'map', reward_id: 'halloween', text: 'Red rivers' }],
      '300000': [{ reward: 'item', reward_id: 2534000, text: 'Unique precious chest (1)' }],
    },
    event_progress: 27537212,
  },
};
const WHEELS = [
  {
    id: 62,
    type: 'dayofdeadwof',
    name: 'dodcardgame_2026',
    title: 'Loteria De Muertos 2026',
    free: 1,
    endDate: 1794826800,
  },
];
/** Far-future copies, so state tests see the events as running. */
const FUTURE_SES = { DayOfDead: { ...SES_DATA.DayOfDead, meta: { end: '16.11.2099 12:00:59' } } };
const FUTURE_WHEELS = [{ ...WHEELS[0], endDate: 4098000000 }];

let calls: { url: string; body: string }[];
let routes: Record<string, (body: string) => unknown>;
let realFetch: typeof fetch;
const params = (body: string) => new URLSearchParams(body);
const callTo = (part: string) => calls.filter((candidate) => candidate.url.includes(part));

function fakeServer() {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body });
    const route = routes[url.replace(WORLD, '').replace(/&h=\w+/, '')];
    return route ? Response.json(route(body)) : new Response(`unexpected ${url}`, { status: 404 });
  }) as typeof fetch;
}

function makeState(game: Record<string, unknown> = { sesData: FUTURE_SES, ceData: CE_DATA }, wheels = FUTURE_WHEELS) {
  const now = Math.floor(Date.now() / 1000);
  const bootstrap: any = {
    h: 'abc123',
    game: { sincepoch: now, travelSpeed: 1, currentWorldName: 'Quebec', jobs: [], ...game },
    character: {
      playerId: 42,
      name: 'shallax',
      level: 30,
      charClass: { type: 'adventurer' },
      pos: { x: 100, y: 100 },
      maxEnergy: 100,
      energy: 40,
      health: 300,
      taskQueue: [],
      taskLimit: { normal: 4, premium: 9 },
      skillData: {},
    },
    premium: null,
    bag: null,
    wheels,
  };
  const client = new GameClient({
    worldUrl: WORLD,
    h: 'abc123',
    jar: new CookieJar(),
    identity: { userAgent: 'UA', acceptLanguage: 'en' },
    policy: FAST,
  });
  return new GameState({ client, bootstrap }, async () => ({ client, bootstrap }));
}

beforeEach(() => {
  calls = [];
  routes = {};
  realFetch = globalThis.fetch;
  resetThrottle();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test.after(() => rmSync(home, { recursive: true, force: true }));

// ---- parsing -----------------------------------------------------------------------------------

test('server dates are Europe/Berlin: the event end matches the wheel endDate; summer time is UTC+2', () => {
  assert.equal(events.parseServerDate('16.11.2026 12:00'), WHEELS[0]?.endDate);
  assert.equal(events.parseServerDate('16.11.2026 12:00:59'), 1794826859);
  assert.equal(events.parseServerDate('01.07.2026 12:00'), Date.UTC(2026, 6, 1, 10) / 1000);
  assert.equal(events.parseServerDate('16.11.2026'), Date.UTC(2026, 10, 15, 23) / 1000);
  assert.equal(events.parseServerDate('tomorrow'), null);
  assert.equal(events.parseServerDate(undefined), null);
});

test('sesData: counter stat, currency, milestones in order (item or unlock), friend gift', () => {
  const [event, ...rest] = events.parseSeasonalEvents({ sesData: SES_DATA });
  assert.equal(rest.length, 0);
  assert.ok(event);
  assert.equal(event.id, 'DayOfDead');
  assert.equal(event.currency, 'Cempasúchil');
  assert.equal(event.counterStat, 'dayofdead_collected');
  assert.equal(event.collected, 50093);
  assert.equal(event.endsAt, 1794826859);
  assert.equal(event.startsAt, null);
  assert.deepEqual(
    event.milestones.map((milestone) => [milestone.at, milestone.itemId]),
    [
      [100, null],
      [500, 51775000],
      [10000, 50301000],
      [55000, 54974000],
    ],
  );
  assert.deepEqual(event.gift, { label: 'Send 20 Cempasúchil Flowers', cooldown: 82800 });
  assert.equal(events.nextMilestone(event)?.at, 55000);
  assert.equal(events.isRunning(event, 1794826858), true);
  assert.equal(events.isRunning(event, 1794826859), false);
  assert.deepEqual(events.parseSeasonalEvents(null), []);
  assert.deepEqual(events.parseSeasonalEvents({ sesData: [] }), []);
});

test('ceData: stages by points, progress, next stage; wheels from WofManager.init', () => {
  const [community] = events.parseCommunityEvents({ ceData: CE_DATA });
  assert.ok(community);
  assert.equal(community.name, 'Day of the Dead 2026');
  assert.deepEqual(
    community.stages.map((stage) => [stage.at, stage.rewards]),
    [
      [10000, ['Red rivers']],
      [45000, ['Red letter (1)']],
      [300000, ['Unique precious chest (1)']],
    ],
  );
  assert.equal(events.nextCommunityStage(community), null, 'progress is far past the last stage');
  assert.equal(events.nextCommunityStage({ ...community, progress: 20000 })?.at, 45000);
  assert.deepEqual(events.parseWheels(WHEELS), [
    { id: 62, type: 'dayofdeadwof', title: 'Loteria De Muertos 2026', free: 1, endsAt: 1794826800 },
  ]);
});

test('bootstrap reads the wheel list from game.php (and none when missing)', () => {
  const html = `<script>Player.init({"h":"688885"});
west.wof.WofManager.init(${JSON.stringify(WHEELS)}, LinearQuestHandler.hasTutorialQuest());</script>`;
  assert.deepEqual(parseBootstrap(html).wheels, WHEELS);
  assert.deepEqual(parseBootstrap('Player.init({"h":"688885"});').wheels, []);
});

test('saved game.php: sesData, ceData and the wheel parse (skips without the file)', (context) => {
  let html: string;
  try {
    html = readFileSync(new URL('../../en32.the_west.net/en32.the-west.net/game.php', import.meta.url), 'utf8');
  } catch {
    return context.skip('no saved game.php');
  }
  const bootstrap = parseBootstrap(html);
  const board = events.EventBoard.fromBootstrap(bootstrap.game, bootstrap.wheels);
  assert.ok(board.seasonal.length >= 1);
  assert.ok(board.seasonal.every((event) => event.endsAt !== null && event.milestones.length > 0));
  assert.ok(board.wheels.every((wheel) => wheel.id > 0 && wheel.endsAt > 0));
});

test('friends: activations per friend and event; who can get a gift and when the next one can', () => {
  const list = events.parseFriends({
    players: [
      { player_id: 7, name: 'Ann', townname: 'Quebec' },
      { player_id: 8, name: 'Bob', townname: '' },
      { player_id: 9, name: 'Cid', townname: '' },
    ],
    eventActivations: [
      { friend_id: 7, event_name: 'DayOfDead', activation_time: 1000 },
      { friend_id: 8, event_name: 'DayOfDead', activation_time: 5000 },
      { friend_id: 8, event_name: 'Hearts', activation_time: 1 },
    ],
  });
  const [event] = events.parseSeasonalEvents({ sesData: SES_DATA });
  assert.ok(event);
  const names = (now: number) =>
    events.giftableFriends(list.friends, list.activations, event, now).map((friend) => friend.name);
  assert.deepEqual(names(1000 + 82799), ['Cid'], 'Cid never got one; Ann is 1 s short');
  assert.deepEqual(names(1000 + 82800), ['Ann', 'Cid']);
  assert.deepEqual(names(5000 + 82800), ['Ann', 'Bob', 'Cid']);
  assert.equal(events.nextGiftAt(list.friends, list.activations, event), 82800, 'Cid (never) is due at once');
  assert.equal(events.nextGiftAt([], list.activations, event), null);
});

test('currency log: spent wheel payments and admin deductions are negative', () => {
  const page = events.parseLogPage({
    entries: [
      { date: 1793700000, type: 'jobDrop', value: 355, description: 'Job', details: 12 },
      { date: 1793700100, type: 'wofPay', value: 500, description: 'Loteria', details: 'sneakyshot' },
      { date: 1793700200, type: 'adminDrop', value: 5, description: 'Support', details: 'deduct' },
      { date: 1793700300, type: 'friendDrop', value: 20, description: 'From a friend', details: '{"name":"Ann"}' },
    ],
    page: 2,
    hasNext: true,
  });
  assert.deepEqual(
    page.entries.map((entry) => entry.value),
    [355, -500, -5, 20],
  );
  assert.equal(page.page, 2);
  assert.equal(page.hasNext, true);
});

// ---- Loteria -----------------------------------------------------------------------------------

const itemName = (id: number) => `item ${id}`;
const CARD_INIT = {
  name: 'dodcardgame_2026',
  prizes: { gamblePrizes: { '1': [51775000, 50301000], '2': [{ item_id: 2665000, count: 2 }] } },
  mode: {
    cost: { main: 10 },
    currencies: { main: [2, 16] },
    conversion: { ses: 50 },
    game: { free_games: 1, status: 'closed', current: { stage: 1 } },
    stages: [{ rewards: 51775000 }, { rewards: [{ item_id: 2665000, count: 2 }] }],
  },
};

test('card game: state, reward names, pools and prices; what the player can do in each status', () => {
  const closed = events.parseCardGame(CARD_INIT, null, itemName, 'Cempasúchil');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.freeGames, 1);
  assert.deepEqual(closed.reward, ['item 51775000']);
  assert.deepEqual(closed.pools.slice(0, 3), [['item 51775000', 'item 50301000'], ['item 2665000 ×2'], []]);
  assert.deepEqual(closed.start, [
    { currencyId: 2, name: 'nuggets', price: 10 },
    { currencyId: 16, name: 'Cempasúchil', price: 500 },
  ]);
  assert.deepEqual(events.cardGameActions(closed), {
    start: true,
    pick: false,
    next: false,
    collect: false,
    bribe: false,
    change: false,
  });

  const won = events.parseCardGame(
    CARD_INIT,
    { game: { status: 'won', current: { stage: 2 } }, stages: CARD_INIT.mode.stages },
    itemName,
  );
  assert.deepEqual(won.reward, ['item 2665000 ×2']);
  assert.equal(won.freeGames, 1, 'kept from init when the update does not say');
  assert.deepEqual(events.cardGameActions(won), {
    start: false,
    pick: false,
    next: true,
    collect: true,
    bribe: false,
    change: false,
  });

  const lost = events.parseCardGame(
    CARD_INIT,
    { game: { status: 'lost', current: { stage: 3, bribe_cost: { nuggets: 15 } } } },
    itemName,
  );
  assert.deepEqual(lost.bribe, [{ currencyId: 2, name: 'nuggets', price: 15 }]);
  assert.equal(events.cardGameActions(lost).bribe, true);
  assert.equal(events.cardGameActions(lost).next, false);

  const last = events.parseCardGame(
    CARD_INIT,
    { game: { status: 'bribed', current: { stage: 5, change_reward_cost: { '2': 5, '16': 200 } } } },
    itemName,
    'Cempasúchil',
  );
  assert.deepEqual(events.cardGameActions(last), {
    start: false,
    pick: false,
    next: false,
    collect: true,
    bribe: false,
    change: true,
  });
  assert.deepEqual(
    last.change.map((option) => `${option.price} ${option.name}`),
    ['5 nuggets', '200 Cempasúchil'],
  );
  assert.equal(
    events.cardGameActions(events.parseCardGame(CARD_INIT, { game: { status: 'running' } }, itemName)).pick,
    true,
  );
});

test('card game through GameState: init, start a free game, pick a card, collect; requests as the browser sends', async () => {
  fakeServer();
  const state = makeState();
  routes['/game.php?window=wheeloffortune&mode=init'] = () => CARD_INIT;
  const replies: unknown[] = [
    { game: { status: 'running', free_games: 0, current: { stage: 1 } } },
    { game: { status: 'won', current: { stage: 1 } }, stages: CARD_INIT.mode.stages, nuggets: 12 },
    { game: { status: 'closed', current: { stage: 1 } } },
  ];
  routes['/game.php?window=wheeloffortune&action=gamble'] = () => replies.shift();
  await state.openCardGame();
  assert.equal(params(callTo('mode=init')[0]?.body ?? '').get('wofid'), '62');
  await state.playCardGame('open');
  assert.equal(state.events.cardGame?.game.status, 'running');
  assert.equal(state.events.cardGameWheel(state.clock.now())?.free, 0, 'the free game is used');
  await state.playCardGame('gamble', { card: 2 });
  assert.equal(state.character.nuggets, 12);
  const reward = state.itemName(51775000);
  assert.deepEqual(state.events.cardGame?.game.reward, [reward]);
  await state.playCardGame('end');
  const sent = callTo('action=gamble').map((call) => Object.fromEntries(params(call.body)));
  assert.deepEqual(sent, [
    { action: 'open', wofid: '62' },
    { card: '2', action: 'gamble', wofid: '62' },
    { action: 'end', wofid: '62' },
  ]);
  assert.ok(state.log.some((line) => line.msg === `Loteria: collected ${reward}.`));
});

// ---- live updates, milestones, announcements ----------------------------------------------------

test('chat SesStatChanged / CommEventChanged → ses / communityEvent; the counter moves and milestones log', () => {
  const poller = new ChatPoller({} as any);
  const seen: unknown[] = [];
  poller.on('ses', (stats) => seen.push(stats));
  poller.on('communityEvent', (change) => seen.push(change));
  poller.handle({ id: 'SesStatChanged', t: 1, payload: { dayofdead_collected: '55020' } });
  poller.handle({ id: 'CommEventChanged', t: 2, payload: { event_id: 'dayofdead', event_stage: 3 } });
  assert.deepEqual(seen, [{ dayofdead_collected: 55020 }, { id: 'dayofdead', stage: 3 }]);

  const state = makeState();
  state.applyEventStats({ dayofdead_collected: 55020, other_stat: 4 });
  assert.equal(state.events.seasonal[0]?.collected, 55020);
  assert.match(state.log.at(-1)?.msg ?? '', /55,000 reached: You receive Xólotl Spirit's arrows!/);
  state.applyEventStats({ dayofdead_collected: 55030 });
  assert.equal(state.events.seasonal[0]?.collected, 55030);
  assert.equal(state.log.filter((line) => /reached/.test(line.msg)).length, 1, 'a milestone is announced once');
});

test('startup announces the running event and a free Loteria game; ended events stay quiet', () => {
  const state = makeState();
  (state as any).announceEvents();
  const log = state.log.map((line) => line.msg).join('\n');
  assert.match(log, /Event DayOfDead: 50,093 Cempasúchil, next reward at 55,000 \(g e\)/);
  assert.match(log, /Loteria De Muertos 2026: 1 free game\(s\) waiting\. Play it on the Events screen \(g e\)/);

  const ended = makeState({ sesData: SES_DATA, ceData: CE_DATA }, WHEELS);
  (ended as any).clock.driftMs = Date.now() - 1800000000 * 1000;
  (ended as any).announceEvents();
  assert.equal(ended.log.length, 0);
});

// ---- autopilot: friend gifts ---------------------------------------------------------------------

function friendRoutes(lastGift: () => number) {
  routes['/game.php?window=friendsbar&mode=search'] = () => ({
    players: [
      { player_id: 7, name: 'Ann' },
      { player_id: 8, name: 'Bob' },
    ],
    eventActivations: [
      { friend_id: 7, event_name: 'DayOfDead', activation_time: lastGift() },
      { friend_id: 8, event_name: 'DayOfDead', activation_time: lastGift() },
    ],
  });
}

test('autopilot gifts: event_all when a friend is due, nothing while all are on cooldown, every 10 min, backs off', async () => {
  fakeServer();
  const state = makeState();
  const runner = state.runner as any;
  const now = () => Math.floor(state.clock.now());
  let last = now() - 90_000;
  friendRoutes(() => last);
  routes['/game.php?window=friendsbar&action=event_all'] = () => {
    last = now();
    return { error: false, msg: 'You sent 20 Cempasúchil Flowers to 2 friends.' };
  };

  assert.equal(await runner.sendEventGifts(), true);
  assert.deepEqual(Object.fromEntries(params(callTo('action=event_all')[0]?.body ?? '')), { event: 'DayOfDead' });
  assert.equal(callTo('mode=search').length, 2, 'read before, and again after for the new cooldowns');
  assert.match(
    state.log.at(-1)?.msg ?? '',
    /Autopilot: DayOfDead gifts: You sent 20 Cempasúchil Flowers to 2 friends\./,
  );

  assert.equal(await runner.sendEventGifts(), false, 'checked less than 10 min ago');
  assert.equal(callTo('mode=search').length, 2);

  runner.giftsAt = 0;
  assert.equal(await runner.sendEventGifts(), false, 'everyone got one just now');
  assert.equal(callTo('action=event_all').length, 1);

  last = now() - 90_000;
  runner.giftsAt = 0;
  routes['/game.php?window=friendsbar&action=event_all'] = () => ({ error: true, msg: 'Not now.' });
  assert.equal(await runner.sendEventGifts(), true);
  assert.ok(runner.skipped().has('gift:DayOfDead'), 'backing off after a failure');
  assert.match(
    state.log.map((line) => line.msg).join('\n'),
    /Autopilot: DayOfDead gifts: Not now\. \(retry in 1 min\)/,
  );
});

test('autopilot gifts: on by default, only from a running step; off, paused or dry run send nothing', async () => {
  fakeServer();
  const state = makeState();
  assert.equal(state.autopilot.config.modules.eventGifts, true);
  friendRoutes(() => 0);
  routes['/game.php?window=friendsbar&action=event_all'] = () => ({ error: false, msg: 'Sent.' });
  const runner = state.runner as any;
  runner.plan = { tasks: [], timeline: { steps: [] }, why: '', value: 0 };
  runner.lastPrint = 'fixed';
  runner.lastCheck = Date.now();

  state.autopilot.config.running = false;
  await state.runner.step();
  state.autopilot.config.running = true;
  state.autopilot.config.modules.dryRun = true;
  await state.runner.step();
  state.autopilot.config.modules.dryRun = false;
  state.autopilot.config.modules.eventGifts = false;
  runner.carryOut = async () => {};
  runner.wakeUp = async () => false;
  runner.maybeCancelForBetter = async () => false;
  await state.runner.step();
  assert.equal(callTo('friendsbar').length, 0);

  state.autopilot.config.modules.eventGifts = true;
  await state.runner.step();
  assert.equal(callTo('action=event_all').length, 1);
});

// ---- Events screen -------------------------------------------------------------------------------

function tui(state: any, size = { columns: 130, rows: 40 }) {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { ...size, isTTY: true });
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (flag: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (data) => (out += data.toString()));
  const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
  const app = render(React.createElement(App, { state }), {
    stdout: stdout as any,
    stdin: stdin as any,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    plain: () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    reset: () => (out = ''),
    keys: async (...keys: string[]) => {
      for (const key of keys) {
        stdin.write(key);
        await settle();
      }
    },
    done: () => app.unmount(),
  };
}

test('Events screen: header counter, milestones, friends due, send with confirm; Loteria plays only on keys', async () => {
  fakeServer();
  const state = makeState();
  friendRoutes(() => 0);
  routes['/game.php?window=friendsbar&action=event_all'] = () => ({ error: false, msg: 'Sent to 2 friends.' });
  routes['/game.php?window=wheeloffortune&mode=init'] = () => CARD_INIT;
  routes['/game.php?window=wheeloffortune&action=gamble'] = () => ({ game: { status: 'running', free_games: 0 } });
  routes['/game.php?window=ses&mode=log'] = () => ({
    entries: [{ date: 1793700000, type: 'jobDrop', value: 355, description: 'Job' }],
    page: 1,
    hasNext: false,
  });
  const screen = tui(state);
  try {
    await screen.keys('g', 'e');
    let out = screen.plain();
    assert.match(out, /❀ 50,093 → 55,000/);
    assert.match(out, /Loteria free \(g e\)/);
    assert.match(out, /Cempasúchil 50,093/);
    assert.match(out, /› +55,000/);
    assert.match(out, /2 of 2 can get it now: Ann, Bob/);
    assert.match(out, /Community: Day of the Dead 2026/);

    screen.reset();
    await screen.keys('s');
    assert.match(screen.plain(), /Send 20 Cempasúchil Flowers to 2 friend\(s\): Ann, Bob\?\s+y yes/);
    assert.equal(callTo('event_all').length, 0, 'nothing before y');
    await screen.keys('y');
    assert.equal(callTo('event_all').length, 1);

    screen.reset();
    await screen.keys('\x1b[C');
    out = screen.plain();
    assert.match(out, /No game running · 1 free game/);
    assert.match(out, /s free game/);
    assert.equal(callTo('action=gamble').length, 0, 'opening the tab does not play');
    await screen.keys('s');
    assert.equal(callTo('action=gamble').length, 1);
    assert.match(screen.plain(), /Stage 1: pick one of 3 cards/);

    screen.reset();
    await screen.keys('\x1b[C');
    assert.match(screen.plain(), /\+355 +Job/);
  } finally {
    screen.done();
  }
});
