// Mail, trade (bank / shops / market / item use), duels, chat sending, route energy budget, quest reward
// choice, and their TUI screens. Replies follow the client JS (offsets in the game modules' headers).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'twcli-social-'));
process.env.TW_CLI_HOME = home;
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
process.env.TW_ITEMS_FILE = `${FIX}items.sample.json`;

const React = (await import('react')).default;
const { render } = await import('ink');
const { CookieJar } = await import('../src/http/cookie-jar.ts');
const { GameClient } = await import('../src/http/game-client.ts');
const { resetThrottle } = await import('../src/http/throttle.ts');
const { GameState } = await import('../src/game/state.ts');
const { ItemCatalog, slimItem } = await import('../src/game/items.ts');
const { parseActiveEvent } = await import('../src/game/event.ts');
const { parseQuest } = await import('../src/game/quests.ts');
const { ChatPoller, chatPresence } = await import('../src/realtime/chat.ts');
const { MarketApi, parseOffer, depositFee, marketFee, buyOrderProblem, suggestedBid, DEFAULT_FILTER } = await import(
  '../src/game/trade.ts'
);
const { bbText, formatReport } = await import('../src/game/mail.ts');
const { planRoute } = await import('../src/game/route.ts');
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
/** Captured server JSON (fixtures are loosely shaped, so tests read them as any). */
const json = (name: string): any => JSON.parse(readFileSync(`${FIX}${name}.json`, 'utf8'));
const BAG = json('bag_init.sample');
const ITEMS = json('items.sample');
const QUESTS = json('open_quests.sample');

function bootstrap(): any {
  const now = Math.floor(Date.now() / 1000);
  return {
    h: 'abc123',
    game: { sincepoch: now, travelSpeed: 1, currentWorldName: 'Quebec', jobs: [] },
    character: {
      playerId: 42,
      name: 'shallax',
      level: 30,
      charClass: { type: 'adventurer' },
      experience: 1000,
      cash: 50,
      deposit: 10,
      nuggets: 0,
      pos: { x: 100, y: 100 },
      town: { id: 1421, coords: { x: 200, y: 200 } },
      charSpeed: 1,
      maxEnergy: 100,
      energy: 40,
      health: 300,
      healthRegenFactor: 0,
      energyRegenFactor: 0,
      taskQueue: [],
      taskLimit: { normal: 4, premium: 9 },
      skillData: {},
      lpPerPoint: 10,
    },
    premium: null,
    bag: BAG,
  };
}

interface Call {
  url: string;
  body: string;
}
let calls: Call[];
let realFetch: typeof fetch;
let routes: Record<string, (body: string) => unknown>;
const params = (body: string) => new URLSearchParams(body);
const callTo = (part: string) => calls.filter((candidate) => candidate.url.includes(part));

function fakeServer() {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body });
    const path = url.replace(WORLD, '').replace(/&h=\w+/, '');
    const route = routes[path];
    if (route) {
      const result = route(body);
      return result instanceof Response ? result : Response.json(result);
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  }) as typeof fetch;
}

function makeState() {
  const second = bootstrap();
  const client = new GameClient({
    worldUrl: WORLD,
    h: second.h,
    jar: new CookieJar(),
    identity: { userAgent: 'UA', acceptLanguage: 'en' },
    policy: FAST,
  });
  const gameState = new GameState({ client, bootstrap: second }, async () => ({ client, bootstrap: second }));
  gameState.items = ItemCatalog.fromRaw(ITEMS);
  gameState.inventory.retype(gameState.items);
  return gameState;
}

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
  const settle = (ms = 120) => new Promise((transform) => setTimeout(transform, ms));
  const app = render(React.createElement(App, { state }), {
    stdout: stdout as any,
    stdin: stdin as any,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    plain: () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    reset: () => (out = ''),
    settle,
    keys: async (...ks: string[]) => {
      for (const key of ks) {
        stdin.write(key);
        await settle();
      }
    },
    type: async (text: string) => {
      for (const ch of text) {
        stdin.write(ch);
        await settle(15);
      }
      await settle();
    },
    done: () => app.unmount(),
  };
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

const REPORTS = {
  count: 2,
  page: 1,
  reports: [
    {
      report_id: 501,
      title: 'Job report: Tending pigs',
      hash: 'h501',
      read: false,
      date_received: '10:12',
      popupData: 'You worked 1 hour',
    },
    { report_id: 502, title: 'Duel: you won', hash: 'h502', read: true, date_received: 'yesterday', popupData: '' },
  ],
};
const TELEGRAMS = {
  page: 1,
  count: 1,
  folders: [],
  messages: [
    {
      message_id: 77,
      subject: 'Hello there',
      partner_name: ['Bob'],
      partner_id: [9],
      own_status: 5,
      other_status: [4],
      last_post_date: '09:00',
    },
  ],
};

function mailRoutes() {
  routes['/game.php?window=reports&action=get_reports'] = () => REPORTS;
  routes['/game.php?window=reports&mode=show_report'] = () => ({
    title: 'Job report: Tending pigs',
    date_received: '10:12',
    reportType: 'job',
    page: '<page><div>You earned <b>&#036; 90</b><br/>and 50 XP</div><table><tr><td>Motivation</td><td>82 &#37;</td></tr><tr><td>Money</td><td>&#036; 47</td></tr></table></page>',
  });
  routes['/game.php?window=messages&action=get_messages'] = () => TELEGRAMS;
  routes['/game.php?window=messages&action=get_message'] = () => ({
    subject: 'Hello there',
    page: 0,
    pages: 1,
    head_id: 77,
    posts: [{ name: 'Bob', post_date: '09:00', text: 'Want to [b]trade[/b] some ham?', player_id: 9 }],
  });
  routes['/game.php?window=messages&action=send'] = () => [true, 'sent'];
  routes['/game.php?window=messages&action=reply'] = () => [true, 'ok'];
  routes['/game.php?window=reports&action=delete_single_report'] = () => [false];
}

test('mail: reports and telegrams requests, HTML/BBCode to text, errors from [ok, msg] replies', async () => {
  fakeServer();
  mailRoutes();
  const state = makeState();
  state.unread.reports = true;
  await state.loadReports(1, 'job');
  assert.equal(state.unread.reports, false);
  assert.deepEqual(Object.fromEntries(params(callTo('get_reports')[0]!.body)), { page: '1', folder: 'job' });
  const reportInfo = await state.openReport(state.reports!.reports[0]!);
  assert.equal(reportInfo!.text, 'You earned $ 90\nand 50 XP\nMotivation: 82%\nMoney: $47');
  assert.equal(params(callTo('show_report')[0]!.body).get('hash'), 'h501');
  await state.deleteReport(state.reports!.reports[0]!);
  assert.deepEqual(Object.fromEntries(params(callTo('delete_single_report')[0]!.body)), {
    report: '501',
    type: 'job',
    deleted: 'false',
  });
  await state.loadTelegrams();
  assert.deepEqual(state.telegrams!.telegrams[0], {
    id: 77,
    subject: 'Hello there',
    partners: ['Bob'],
    unread: true,
    answered: false,
    date: '09:00',
  });
  const telegram = await state.openTelegram(77);
  assert.equal(telegram!.posts[0]!.text, 'Want to trade some ham?');
  assert.equal(bbText('[player]Ann[/player] &amp; co'), 'Ann & co');
  assert.equal(await state.sendTelegram('Bob', 'Hi', 'ab'), false, 'text under 3 characters is refused before sending');
  assert.equal(callTo('action=send').length, 0);
  routes['/game.php?window=messages&action=send'] = () => [false, 'Player not found', ['not_found', ['Bobb']]];
  assert.equal(await state.sendTelegram('Bobb', 'Hi', 'hello'), false);
  assert.match(state.log.at(-1)!.msg, /Player not found/);
});

test('mail: < > change report and telegram pages', async () => {
  fakeServer();
  mailRoutes();
  routes['/game.php?window=reports&action=get_reports'] = (body) => {
    const urlValue = new URLSearchParams(body);
    if (urlValue.get('page') === '2') {
      return {
        page: 2,
        count: 2,
        reports: [
          { report_id: 601, title: 'Page two report', hash: 'h601', read: true, date_received: '11:00', popupData: '' },
        ],
      };
    }
    return REPORTS;
  };
  routes['/game.php?window=messages&action=get_messages'] = (body) => {
    const urlValue = new URLSearchParams(body);
    if (urlValue.get('page') === '2') {
      return {
        page: 2,
        count: 2,
        messages: [
          {
            message_id: 88,
            subject: 'Page two telegram',
            partner_name: ['Bob'],
            partner_id: [9],
            own_status: 2,
            last_post_date: '11:00',
          },
        ],
      };
    }
    return { ...TELEGRAMS, count: 2 };
  };
  const state = makeState();
  const transform = tui(state);
  try {
    await transform.keys('g', 'r');
    await transform.settle(400);
    assert.match(transform.plain(), /page 1\/2/);
    await transform.keys('>');
    await transform.settle(300);
    assert.equal(state.reports?.page, 2);
    assert.match(transform.plain(), /Page two report/);
    await transform.keys('<');
    await transform.settle(300);
    assert.equal(state.reports?.page, 1);
    // Kitty keyboard protocol: Shift+. / Shift+, arrive as "." / "," with shift.
    await transform.keys('\x1b[46:62;2u');
    await transform.settle(300);
    assert.equal(state.reports?.page, 2);
    await transform.keys('\x1b[44:60;2u');
    await transform.settle(300);
    assert.equal(state.reports?.page, 1);

    await transform.keys('\t');
    await transform.settle(200);
    await transform.keys('>');
    await transform.settle(300);
    assert.equal(state.telegrams?.page, 2);
    assert.match(transform.plain(), /Page two telegram/);
    await transform.keys('<');
    await transform.settle(300);
    assert.equal(state.telegrams?.page, 1);
  } finally {
    transform.done();
  }
});

test('job report formatter: dedupes values, inlines fields and compacts items', () => {
  const report = [
    'Motivation',
    '70 %',
    '70 %',
    'Time',
    '15s',
    'Money',
    '$ 35',
    'Pacific Bonds',
    '0',
    'Experience',
    '71 Points',
    'Luck',
    '$ 0',
    'Cempasúchil',
    '3',
    'Items Found',
    'No items were found.',
  ].join('\n');
  assert.equal(
    formatReport(report, 'job'),
    [
      'Motivation: 70%',
      'Time: 15s',
      'Money: $35',
      'Pacific Bonds: 0',
      'Experience: 71 Points',
      'Luck: $0',
      'Cempasúchil: 3',
      'Items: none',
    ].join('\n'),
  );
  assert.equal(
    formatReport(['Items Found', 'Canvas', '3', 'Bowie knife', '1'].join('\n'), 'job'),
    'Items: Canvas x 3, Bowie knife x 1',
  );
  assert.equal(formatReport('Items Found\nNo items were found.', 'job'), 'Items: none');
  assert.equal(formatReport('Motivation 70 %', 'duel'), 'Motivation 70 %');
});

test('trade: bank deposit, shop buy/sell, item use and market requests', async () => {
  fakeServer();
  const state = makeState();
  routes['/game.php?window=building_bank&mode=get_data'] = () => ({
    error: false,
    deposit: 10,
    own_money: 50,
    deposit_fee: 4,
    town_name: 'Slobozia',
    stage: 2,
  });
  routes['/game.php?window=building_bank&action=deposit'] = () => ({ error: false, deposit: 58, own_money: 0, fee: 2 });
  routes['/game.php?window=building_general&town_id=1421'] = () => ({
    trader_inv: [{ item_id: 16000 }, { item_id: 700000 }],
    charge: 1.5,
    level: 3,
    town_name: 'Slobozia',
  });
  routes['/game.php?window=building_general&action=buy'] = () => ({
    changes: [{ item_id: 700000, count: 2, inv_id: 2000000, type: 'yield' }],
    money: { barrows: 35, deposit: 10 },
  });
  routes['/game.php?window=building_general&action=sell'] = () => ({
    money: 65,
    changes: [{ item_id: 701000, count: 1, inv_id: 709577, type: 'yield' }],
  });
  routes['/game.php?window=itemuse&action=use_item'] = () => ({
    error: false,
    msg: {
      changes: [{ item_id: 702000, count: 1, inv_id: 1614984, type: 'yield' }],
      effects: [
        { type: 'energy', energy: 70 },
        { type: 'content', items: [{ item_id: 700000, count: 2 }] },
      ],
    },
  });

  await state.openBank(1421);
  assert.equal(state.bank!.fee, 4);
  assert.equal(depositFee(50, 4), 2);
  await state.depositMoney(50);
  assert.deepEqual(Object.fromEntries(params(callTo('action=deposit')[0]!.body)), { town_id: '1421', amount: '50' });
  assert.deepEqual([state.character.cash, state.character.deposit], [0, 58]);

  await state.openShop('general', 1421);
  assert.ok(
    callTo('window=building_general&town_id=1421')[0]!.url.endsWith('game.php?window=building_general&town_id=1421'),
    'Trader.open: no mode / action',
  );
  assert.equal(state.shopPrice(700000), 15, 'price × charge');
  state.character.cash = 50;
  await state.buyFromShop(700000);
  assert.deepEqual(Object.fromEntries(params(callTo('action=buy')[0]!.body)), {
    item_id: '700000',
    town_id: '1421',
    last_inv_id: '1614984',
  });
  assert.equal(state.inventory.count(700000), 2);
  assert.equal(state.character.cash, 35);
  await state.sellToShop(701000, 2);
  assert.deepEqual(Object.fromEntries(params(callTo('action=sell')[0]!.body)), {
    inv_id: '709577',
    town_id: '1421',
    item_id: '701000',
    count: '2',
    last_inv_id: '2000000',
  });
  assert.equal(state.character.cash, 65);

  state.items!.get(702000)!.usetype = 'normal';
  await state.useItem(702000, 1);
  assert.deepEqual(Object.fromEntries(params(callTo('use_item')[0]!.body)), {
    item_id: '702000',
    item_count: '1',
    lastInvId: '2000000',
  });
  assert.equal(state.character.energy, 70);
  assert.match(state.log.at(-1)!.msg, /You get: 2× Ham/);
  await state.useItem(16000);
  assert.match(state.log.at(-1)!.msg, /cannot be used/);

  // Mobile trader (item shop's "trader" tab): rotating offers, bought with dollars.
  routes['/game.php?window=shop_trader&mode=index'] = () => ({
    inventory: {
      trader: [
        {
          item_id: 700000,
          tab: 'trader',
          currency: 4,
          price_dollar: 15,
          reduced_value: 0,
          limited_time: null,
          limited_count: null,
          teaser: 'Food',
        },
      ],
    },
    currencies: { 4: 'dollar' },
    traderTime: Math.floor(Date.now() / 1000) + 600,
  });
  routes['/game.php?window=shop_trader&action=buy'] = () => ({ cash: 35, deposit: 10, bonds: 0, msg: 'Bought Ham' });
  routes['/game.php?window=inventory&action=inventory_changed'] = () => ({ changes: false, wear: {} });
  await state.openMobileTrader();
  assert.equal(state.mobileTrader!.items.length, 1);
  assert.deepEqual(
    [state.mobileTrader!.items[0]!.itemId, state.mobileTrader!.items[0]!.prices[0]!.amount],
    [700000, 15],
  );
  await state.buyMobileTrader(state.mobileTrader!.items[0]!);
  assert.deepEqual(Object.fromEntries(params(callTo('window=shop_trader&action=buy')[0]!.body)), {
    item_id: '700000',
    category: 'trader',
    currency: 'dollar',
  });
  assert.equal(state.character.cash, 35);
  assert.match(state.log.at(-1)?.msg ?? '', /Bought Ham/);

  // Market
  const offer = {
    market_offer_id: 9,
    item_id: 16000,
    item_count: 1,
    current_bid: 300,
    max_price: 900,
    auction_ends_in: 3600,
    seller_name: 'Ann',
    seller_player_id: 5,
    market_town_name: 'Slobozia',
    market_town_x: 200,
    market_town_y: 200,
    direction: 'SELL',
  };
  routes['/game.php?window=building_market&action=search'] = () => ({
    error: false,
    msg: { search_result: [offer, { ...offer, market_offer_id: 10, auction_ends_in: 0 }], next: false },
  });
  routes['/game.php?window=building_market&action=bid'] = () => ({
    error: false,
    msg: { money: 0, deposit: 3, instantBuy: true },
  });
  routes['/game.php?window=building_market&action=fetch'] = () => ({ error: false, msg: { money: 0 } });
  routes['/game.php?window=building_market&action=putup'] = () => ({
    error: false,
    msg: { money: 60, deposit: 3, costs: 5 },
  });
  routes['/game.php?window=building_market&action=fetch_bids'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=building_market&action=fetch_offers'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=inventory&action=inventory_changed'] = () => ({ changes: false, wear: {} });
  await state.searchMarket('knife');
  const source = Object.fromEntries(params(callTo('action=search')[0]!.body));
  assert.equal(source.pattern, 'knife');
  assert.deepEqual(
    [source.direction_sell, source.direction_buy, source.visibility, source.sort],
    ['true', 'false', '2', 'bid'],
  );
  assert.equal(state.market.offers.length, 1, 'finished offers are hidden');
  await state.bidMarket(state.market.offers[0]!, 900, true);
  assert.deepEqual(Object.fromEntries(params(callTo('action=bid')[0]!.body)), {
    bidtype: '1',
    bid: '900',
    market_offer_id: '9',
    direction: 'SELL',
  });
  assert.match(state.log.filter((line) => line.level === 'info').at(-1)!.msg, /won Bowie knife/);
  await state.pickUpMarket(parseOffer(offer));
  assert.match(state.log.at(-1)!.msg, /Go to Slobozia/);
  assert.equal(
    calls.filter((candidate) => /action=fetch&h=/.test(candidate.url)).length,
    0,
    'not sent while away from the market town',
  );
  state.character.position = { x: 200, y: 200 };
  await state.pickUpMarket(parseOffer(offer));
  assert.equal(
    params(calls.find((candidate) => /action=fetch&h=/.test(candidate.url))!.body).get('market_offer_id'),
    '9',
  );
  state.world.towns = [{ id: 1421, x: 200, y: 200, name: 'Slobozia', members: 3, npc: false, points: 0 }];
  assert.equal(await state.sellOnMarket({ itemId: 700000, count: 1, days: 2, buyNow: 40 }), true);
  assert.deepEqual(Object.fromEntries(params(callTo('action=putup')[0]!.body)), {
    town_id: '1421',
    item_id: '700000',
    itemcount: '1',
    auctioncount: '1',
    sellrights: '2',
    auctionlength: '2',
    description: '',
    direction: 'SELL',
    bidtype: '0',
    maxprice: '40',
  });
  await assert.rejects(
    new MarketApi(state.client).sell({ townId: 1, itemId: 1, count: 1, days: 1 }),
    /starting bid or a buy-now price/,
  );
});

test('daily login bonus: the startup hook collects once when the bootstrap says it is available', async () => {
  fakeServer();
  const state = makeState();
  let collected = false;
  routes['/game.php?window=loginbonus&action=collect'] = () => {
    collected = true;
    return { rewards: { xp: 120, nuggets: 3, upb: 2 } };
  };

  await state.autoCollectLoginBonus();

  assert.equal(collected, false, 'not collected when the bootstrap says there is no bonus');

  state.hasLoginBonus = true;
  await state.autoCollectLoginBonus();

  assert.equal(collected, true);
  assert.match(
    state.log.filter((line) => /Daily login bonus/.test(line.msg)).at(-1)!.msg,
    /120 XP.*3 nuggets.*2 bonds/,
  );
});

test('TUI: event progress and ready event item in the header', async () => {
  fakeServer();
  const state = makeState();
  state.event = parseActiveEvent({
    sesData: {
      DayOfDead: {
        meta: { end: '16.11.2026 12:00:59' },
        rewards: {
          90000: { id: 54973000, desc: 'spear' },
          110000: { id: 54975000, desc: 'torch' },
        },
        counter: { key: 'ses:dayofdead_collected', value: 95000 },
      },
    },
    ceData: { dayofdead: { event_name: 'Day of the Dead 2026' } },
  });
  state.items!.add(
    slimItem({
      item_id: 2665000,
      name: 'Flower pot',
      type: 'yield',
      usetype: 'use',
      action: true,
      description:
        'Generates 1250 flowers for the day of the dead event, which can be collected once every 11.5 hours.',
      usebonus: ['1250 Cempasúchil'],
    }),
  );
  state.inventory.bag.set(2665000, { itemId: 2665000, count: 1, invId: 1, type: 'yield' });
  state.inventory.itemCooldown.set(2665000, state.clock.now() - 10);
  state.inventory.itemLifetime.set(2665000, 1000);

  const term = tui(state);
  try {
    await term.settle(200);
    assert.match(term.plain(), /Day of the Dead 2026/);
    assert.match(term.plain(), /95,000 \/ 110,000/);
    assert.match(term.plain(), /15,000 to next/);
    assert.match(term.plain(), /Flower pot \+1250 ready/);
  } finally {
    term.done();
  }
});

test('town hall: building levels, construction detail and the build task post', async () => {
  fakeServer();
  const state = makeState();
  routes['/game.php?window=building_cityhall'] = () => ({
    townName: 'Slobozia',
    townNoLeave: false,
    buildings: [
      {
        key: 'general',
        name: 'General store',
        maxStage: 25,
        stage: 10,
        infinite: false,
        nextStagePoints: 1100,
        buildPoints: 455,
      },
    ],
  });
  routes['/game.php?window=cityhall_build&mode=build'] = () => ({
    error: false,
    build_key: 'general',
    build_name: 'General store',
    description: 'Better goods.',
    build_skills: { skills: [{ skill: 'build', coefficient: 3 }], malus: 120 },
    jobPoints: 3075,
    build_point: 455,
    build_point_limit: 1100,
    deposit: '35.064',
    motivation: 1,
    id: 1421,
    x: 200,
    y: 200,
    singleDuration: false,
    jobDurationData: {
      900: { calcduration: 900, formatted: '15 minutes (60$)', expCalc: { min: 23, max: 70 } },
      3600: { calcduration: 3600, formatted: '1 hour (240$)', expCalc: { min: 90, max: 280 } },
    },
    defaultData: { calcduration: 900 },
  });
  routes['/game.php?window=task&action=add'] = () => ({
    tasks: {
      0: {
        task: {
          queue_id: 5,
          type: 'build',
          date_start: 1,
          date_done: 2,
          data: { coords: { x: 200, y: 200 }, title: 'General store', building_key: 'general' },
        },
      },
    },
  });

  await state.loadTownHall();
  assert.deepEqual([state.townHall!.townName, state.townHall!.buildings[0]!.stage], ['Slobozia', 10]);
  const con = (await state.openConstruction(state.townHall!.buildings[0]!))!;
  assert.deepEqual([con.durations.length, con.defaultDuration, con.buildPoints, con.deposit], [2, 900, 455, '35.064']);
  assert.ok(await state.queueConstruction(3600, 'town'));
  assert.deepEqual(Object.fromEntries(params(callTo('task&action=add')[0]!.body)), {
    'tasks[0][x]': '200',
    'tasks[0][y]': '200',
    'tasks[0][building_key]': 'general',
    'tasks[0][duration]': '3600',
    'tasks[0][deposit]': 'town',
    'tasks[0][taskType]': 'build',
  });
});

test('TUI: town screen lists the city hall and queues a construction', async () => {
  fakeServer();
  const state = makeState();
  routes['/game.php?window=building_cityhall'] = () => ({
    townName: 'Slobozia',
    townNoLeave: false,
    buildings: [
      {
        key: 'general',
        name: 'General store',
        maxStage: 25,
        stage: 10,
        infinite: false,
        nextStagePoints: 1100,
        buildPoints: 455,
      },
    ],
  });
  routes['/game.php?window=cityhall_build&mode=build'] = () => ({
    error: false,
    build_key: 'general',
    build_name: 'General store',
    description: 'Better goods.',
    build_skills: { skills: [{ skill: 'build', coefficient: 3 }], malus: 120 },
    jobPoints: 3075,
    build_point: 455,
    build_point_limit: 1100,
    deposit: '35.064',
    motivation: 1,
    id: 1421,
    x: 200,
    y: 200,
    singleDuration: false,
    jobDurationData: { 900: { calcduration: 900, formatted: '15 minutes (60$)', expCalc: { min: 23, max: 70 } } },
    defaultData: { calcduration: 900 },
  });
  routes['/game.php?window=task&action=add'] = () => ({
    tasks: {
      0: {
        task: {
          queue_id: 5,
          type: 'build',
          date_start: 1,
          date_done: 2,
          data: { coords: { x: 200, y: 200 }, title: 'General store', building_key: 'general' },
        },
      },
    },
  });

  const transform = tui(state);
  try {
    await transform.keys('g', 't');
    await transform.settle(300);
    assert.match(transform.plain(), /City hall · Slobozia/);
    assert.match(transform.plain(), /General store/);
    assert.match(transform.plain(), /10\/25/);
    await transform.keys('\r');
    await transform.settle(200);
    assert.match(transform.plain(), /Construction: General store/);
    assert.match(transform.plain(), /Town treasury/);
    await transform.keys('\r', '\r');
    await transform.settle(200);
    assert.deepEqual(Object.fromEntries(params(callTo('task&action=add')[0]!.body)), {
      'tasks[0][x]': '200',
      'tasks[0][y]': '200',
      'tasks[0][building_key]': 'general',
      'tasks[0][duration]': '900',
      'tasks[0][deposit]': 'town',
      'tasks[0][taskType]': 'build',
    });
  } finally {
    transform.done();
  }
});

test('market: buy orders, filters, paging, selling into a buy order, withdraw, pick up all, fees', async () => {
  fakeServer();
  const state = makeState();
  const want = {
    market_offer_id: 21,
    item_id: 700000,
    item_count: 2,
    current_bid: null,
    auction_price: null,
    max_price: 30,
    auction_ends_in: 7200,
    seller_name: 'Bob',
    seller_player_id: 9,
    market_town_name: 'Slobozia',
    market_town_x: 200,
    market_town_y: 200,
    direction: 'BUY',
    description: 'need <b>ham</b>',
  };
  routes['/game.php?window=building_market&action=search'] = () => ({
    error: false,
    msg: { search_result: [want], next: true },
  });
  routes['/game.php?window=building_market&action=bid'] = () => ({
    error: false,
    msg: { money: 80, instantBuy: true },
  });
  routes['/game.php?window=building_market&action=putup'] = () => ({
    error: false,
    msg: { money: 20, deposit: 10, costs: 4 },
  });
  routes['/game.php?window=building_market&action=fetch_bids'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=building_market&action=fetch_offers'] = () => ({
    error: false,
    msg: { search_result: [{ ...want, market_offer_id: 30, direction: 'SELL', seller_player_id: 42 }] },
  });
  routes['/game.php?window=building_market&action=get_own_buy_offers'] = () => ({
    error: false,
    is_at_town: false,
    msg: [{ ...want, market_offer_id: 31, seller_player_id: 42, auction_ends_in: 0 }],
  });
  routes['/game.php?window=building_market&action=offtake'] = () => ({ error: false, money: 6 });
  routes['/game.php?window=building_market&action=fetch_all'] = () => ({ error: false, msg: { money: 95 } });
  routes['/game.php?window=inventory&action=inventory_changed'] = () => ({ changes: false, wear: {} });

  // Buy orders with filters (searchForMarketOffers: direction_sell / direction_buy, type, levels, usable, has_effect).
  await state.searchMarket('ham', 1, {
    ...DEFAULT_FILTER,
    buyOrders: true,
    type: 'yield',
    levelMin: 0,
    levelMax: 20,
    consumable: true,
  });
  let source = Object.fromEntries(params(callTo('action=search')[0]!.body));
  assert.deepEqual(
    [
      source.direction_sell,
      source.direction_buy,
      source.type,
      source.level_range_min,
      source.level_range_max,
      source.usable,
      source.has_effect,
      source.nav,
    ],
    ['false', 'true', 'yield', '0', '20', 'false', 'true', 'first'],
  );
  const offerInfo = state.market.offers[0]!;
  assert.deepEqual(
    [offerInfo.direction, offerInfo.buyNow, offerInfo.bid, offerInfo.description],
    ['BUY', 30, null, 'need ham'],
  );
  // Paging keeps the filter and sends nav next / prev like getNewPageNo.
  await state.searchMarket('ham', 2);
  source = Object.fromEntries(params(callTo('action=search')[1]!.body));
  assert.deepEqual([source.page, source.nav, source.direction_buy, source.type], ['2', 'next', 'true', 'yield']);
  await state.searchMarket('ham', 2);
  await state.searchMarket('ham', 1);
  assert.equal(params(callTo('action=search').at(-1)!.body).get('nav'), 'first');

  // Selling into a buy order needs the goods; a price below the instant price is raised to it (bid dialog).
  state.inventory.applyChanges([{ item_id: 700000, count: 0, inv_id: 1, type: 'yield' }]);
  const before = callTo('action=bid').length;
  await state.bidMarket(offerInfo, 30);
  assert.match(state.log.at(-1)!.msg, /You need 2× Ham/);
  assert.equal(callTo('action=bid').length, before);
  state.inventory.applyChanges([{ item_id: 700000, count: 3, inv_id: 2000001, type: 'yield' }]);
  await state.bidMarket(offerInfo, 10, true);
  assert.deepEqual(Object.fromEntries(params(callTo('action=bid')[0]!.body)), {
    bidtype: '1',
    bid: '30',
    market_offer_id: '21',
    direction: 'BUY',
  });
  assert.equal(state.character.cash, 80);
  assert.ok(state.log.some((line) => /You sold Ham for \$ 30/.test(line.msg)));

  // Buy order: item found by name, the web's checks, putup with direction BUY and bidtype.
  assert.equal(
    await state.placeBuyOrder({ query: 'Bowie knife', count: 1, days: 3, instant: 100, fromBank: false }),
    false,
    'below the shop sell price (425)',
  );
  assert.match(state.log.at(-1)!.msg, /at least the shop sell price \(\$ 425\)/);
  assert.equal(
    await state.placeBuyOrder({ query: 'bowie knife', count: 1, days: 3, instant: 900, maxBid: 800, fromBank: false }),
    false,
  );
  assert.match(state.log.at(-1)!.msg, /maximum bid must be higher/);
  assert.equal(await state.placeBuyOrder({ query: 'a', count: 1, days: 3, instant: 900, fromBank: false }), false);
  assert.match(state.log.at(-1)!.msg, /matches \d+ items/);
  assert.equal(callTo('action=putup').length, 0);
  assert.equal(
    await state.placeBuyOrder({ query: 'bowie knife', count: 2, days: 3, instant: 900, maxBid: 1200, fromBank: true }),
    true,
  );
  assert.deepEqual(Object.fromEntries(params(callTo('action=putup')[0]!.body)), {
    town_id: '1421',
    item_id: '16000',
    itemcount: '2',
    auctioncount: '1',
    sellrights: '2',
    auctionlength: '3',
    description: '',
    direction: 'BUY',
    bidtype: '1',
    auctionprice: '1200',
    maxprice: '900',
  });
  assert.equal(params(callTo('get_own_buy_offers')[0]!.body).get('town_id'), '1421');
  assert.equal(state.marketMine!.buyOrders.length, 1);
  assert.equal(state.marketMine!.offers.length, 1);

  // Withdraw (offtake) and pick up all (fetch_all) only on site.
  const mine = state.marketMine!.offers[0]!;
  await state.withdrawMarket(mine);
  assert.match(state.log.at(-1)!.msg, /Go to Slobozia/);
  state.character.position = { x: 200, y: 200 };
  state.world.towns = [{ id: 1421, x: 200, y: 200, name: 'Slobozia', members: 3, npc: false, points: 0 }];
  const cash = state.character.cash;
  await state.withdrawMarket(mine);
  assert.deepEqual(Object.fromEntries(params(callTo('action=offtake')[0]!.body)), {
    offer_id: '30',
    direction: 'SELL',
  });
  assert.equal(state.character.cash, cash + 6);
  await state.pickUpAllMarket();
  assert.deepEqual(Object.fromEntries(params(callTo('action=fetch_all')[0]!.body)), { townId: '1421' });
  assert.equal(state.character.cash, 95);

  // Fee (showMarketFees) and the pre-filled bid.
  assert.equal(marketFee({ startPrice: 1000, buyNow: 500, days: 2, homeTown: true }), 106); // int(500·0.02·10 + 6)
  assert.equal(marketFee({ buyNow: 500, days: 2, stage: 4, homeTown: false }), 53); // ceil(106/4·2)
  assert.equal(marketFee({ days: 2, homeTown: true }), 0);
  assert.equal(buyOrderProblem({ count: 1 }, 0), 'Set an instant price or a maximum bid.');
  assert.equal(suggestedBid(parseOffer({ ...want, direction: 'SELL', auction_price: 100, current_bid: 150 })), 151);
  assert.equal(suggestedBid(parseOffer({ ...want, direction: 'SELL', auction_price: 100, current_bid: null })), 100);
  assert.equal(suggestedBid(offerInfo), 30);
});

test('duels: NPC list and fight, opponents, player duel is a task', async () => {
  fakeServer();
  const state = makeState();
  const npcs = {
    npcs: [
      { duelnpc_id: 3, npc_name: 'Dusty Joe', npc_level: 12, weapon_id: 16000, arrival_delta: 0 },
      { duelnpc_id: 4, npc_name: 'Slim', npc_level: 14, weapon_id: 0, arrival_delta: 0 },
    ],
    arrival_delay: 0,
    difficulty: 'easy',
  };
  routes['/game.php?window=duel&action=get_data'] = () => ({ npcs, motivation: 0.8, motivation_npc: 1 });
  routes['/game.php?window=duel&action=search_op'] = () => ({
    oplist: {
      pclist: [
        { player_id: 9, player_name: 'Bob', duellevel: 20, town_name: 'Dodge', character_x: 300, character_y: 100 },
      ],
      page: 0,
      next: false,
    },
  });
  routes['/game.php?window=duel&action=duel_npc'] = () => ({
    data: {
      rounds: [
        { own: { damage: 30 }, other: null },
        { own: null, other: { damage: 12 } },
      ],
      duelResult: '<b>You won!</b>',
    },
    npcs,
    energy: 38,
    health: 288,
    money: 70,
    experience: 1040,
    level: 30,
    motivation: 0.8,
    motivation_npc: 0.9,
    attacker_died: false,
  });
  routes['/game.php?window=task&action=add'] = () => ({
    tasks: {
      0: {
        task: {
          type: 'duel',
          queueId: 5,
          date_start: 1,
          date_done: 2,
          data: { title: 'Bob', coords: { x: 300, y: 100 } },
        },
      },
    },
  });
  await state.loadDuels();
  assert.deepEqual(
    state.duels!.npcs.map((npc) => npc.name),
    ['Dusty Joe', 'Slim'],
  );
  assert.equal(state.duelOpponents[0]!.name, 'Bob');
  assert.deepEqual(Object.fromEntries(params(callTo('search_op')[0]!.body)), {
    distance: '7200',
    order_by: 'ASC',
    page: '0',
    sort: 'range',
    next: 'false',
  });
  await state.fightNpc(3);
  assert.equal(params(callTo('duel_npc')[0]!.body).get('duelnpc_id'), '3');
  assert.deepEqual([state.character.energy, state.character.cash, state.character.experience], [38, 70, 1040]);
  assert.equal(state.lastNpcDuel!.result, 'You won!');
  assert.deepEqual(state.lastNpcDuel!.rounds, [
    { own: 30, other: null },
    { own: null, other: 12 },
  ]);
  await state.duelPlayer(state.duelOpponents[0]!);
  assert.deepEqual(Object.fromEntries(params(callTo('task&action=add')[0]!.body)), {
    'tasks[0][player_id]': '9',
    'tasks[0][taskType]': 'duel',
  });
});

test('chat: rooms and history from Status / Text / tells, sending is a second request', async () => {
  fakeServer();
  const state = makeState();
  const sent: any[] = [];
  routes['/gameservice/chat/'] = (body) => {
    const req: any = JSON.parse(decodeURIComponent(body));
    if (req.batch[0].op === 'send') {
      sent.push(req.batch[0]);
      return {
        timenow: Date.now(),
        batch: [
          { id: 'Text', t: 5, payload: { cid: 'client_42', to: 'room_town_1421', message: req.batch[0].message } },
        ],
      };
    }
    return { timenow: Date.now(), batch: [] };
  };
  const poller = new ChatPoller(state.client, { policy: { ...FAST, lane: 'chat' } as any, errorPauseMs: 10 });
  poller.handle({
    id: 'Status',
    t: 1,
    payload: {
      self: { id: 'client_42', name: 'shallax', level: 30, townId: 1421, town_rights: 3, actioned: Date.now() },
      clients: [
        { id: 'client_9', name: 'Bob', level: 12, townId: 1421, town_rights: 1, actioned: Date.now() - 400_000 },
      ],
      disabledrooms: [],
      rooms: [
        {
          roomdescription: { id: 'room_town_1421', room: 'town', title: 'Slobozia', townid: 1421 },
          members: ['client_42', 'client_9'],
        },
        { roomdescription: { id: 'room_general_1', room: 'general', general_id: 1 }, members: [] },
      ],
    },
  });
  assert.deepEqual(
    [...poller.rooms.values()].map((result) => result.title),
    ['Slobozia', 'Saloon 1'],
  );
  assert.equal(poller.rooms.get('room_town_1421')!.townId, 1421);
  assert.deepEqual([poller.clients.get('client_42')!.townRights, poller.clients.get('client_9')!.level], [3, 12]);
  assert.equal(chatPresence(poller.clients.get('client_9')!.actioned), 'idle');
  poller.handle({
    id: 'UserUpdate',
    t: 2,
    payload: { id: 'client_9', level: 13, town_rights: 2, actioned: Date.now() },
  });
  assert.equal(poller.clients.get('client_9')!.name, 'Bob', 'missing fields keep their old values');
  assert.deepEqual([poller.clients.get('client_9')!.level, poller.clients.get('client_9')!.townRights], [13, 2]);
  assert.equal(chatPresence(poller.clients.get('client_9')!.actioned), 'online');
  const ses: Record<string, unknown>[] = [];
  poller.on('ses', (stats) => ses.push(stats));
  poller.handle({ id: 'SesStatChanged', t: 2, payload: { dayofdead_collected: 96000 } });
  assert.deepEqual(ses, [{ dayofdead_collected: 96000 }]);
  poller.handle({ id: 'Text', t: 2, payload: { cid: 'client_9', to: 'room_town_1421', message: 'howdy &amp; hi' } });
  poller.handle({ id: 'TellReceived', t: 3, payload: { from: { id: 'client_7', name: 'Ann' }, message: 'psst' } });
  assert.deepEqual(
    poller.history.get('room_town_1421')!.map((line) => `${line.from}: ${line.text}`),
    ['Bob: howdy & hi'],
  );
  assert.deepEqual(
    poller.history.get('tell:Ann')!.map((line) => line.text),
    ['psst'],
  );
  assert.ok(poller.unreadRooms.has('tell:Ann'));
  await poller.say('room_town_1421', 'hello town');
  await poller.whisper('Ann', 'hi back');
  assert.deepEqual(
    sent.map((second) => [second.op, second.to, second.message, second.tell]),
    [
      ['send', 'room_town_1421', 'hello town', undefined],
      ['send', 'Ann', 'hi back', true],
    ],
  );
  assert.equal(poller.history.get('room_town_1421')!.at(-1)!.own, true);
});

test('route: energy budget (runs that fit, shortfall) and walking weighted by regeneration', () => {
  const need = { key: 'item:700', label: 'Ham', amount: 6, unit: 'items' as const, itemId: 700000, quests: ['A'] };
  const job = (id: number, groupid: number): any => ({
    id,
    groupid,
    name: `job${id}`,
    jobPoints: 10,
    workPoints: 1,
    laborPoints: 9,
    durations: {},
    values: {
      long: {
        duration: 3600,
        energy: 12,
        money: 1,
        experience: 1,
        luck: 0,
        items: [{ itemId: 700000, expected: 1.5, percent: 150 }],
      },
    },
  });
  const base = {
    needs: [need],
    jobs: [job(1, 1)],
    locations: () => [{ x: 10, y: 0 }],
    from: { x: 0, y: 0 },
    wayTime: () => 60,
  };
  const plan = planRoute({ ...base, energyAvailable: 30 });
  assert.equal(plan.totals.runs, 4);
  assert.equal(plan.fitRuns, 2, '12 energy per run, 30 available');
  assert.equal(plan.energyShort, 18);
  assert.equal(planRoute(base).fitRuns, 4, 'no budget: all runs');
  // Two jobs: a slightly cheaper one far away vs. a near one. Fast regeneration makes walking expensive.
  const far = { ...job(2, 2), values: { long: { ...job(2, 2).values.long, energy: 11 } } };
  const jobs = [job(1, 1), far];
  const locs: Record<number, any[]> = { 1: [{ x: 1, y: 0 }], 2: [{ x: 5000, y: 0 }] };
  const opts = {
    needs: [need],
    jobs,
    locations: (value: number) => locs[value],
    from: { x: 0, y: 0 },
    wayTime: (first: any, second: any) => Math.abs(first.x - second.x),
  };
  assert.equal(
    planRoute({ ...opts, walkEnergyPerSecond: 1 / 6000 }).stops[0]!.job.id,
    2,
    'slow regen: walking is cheap',
  );
  assert.equal(
    planRoute({ ...opts, walkEnergyPerSecond: 100 / 3600 }).stops[0]!.job.id,
    1,
    'fast regen: walking costs energy-time',
  );
});

test('TUI: mail, trade, duels and chat screens; quest reward choice', async () => {
  fakeServer();
  mailRoutes();
  const state = makeState();
  routes['/game.php?window=building_quest&mode='] = () => ({ questEmployer: [] });
  routes['/game.php?window=building_quest'] = routes['/game.php?window=building_quest&mode='];
  routes['/game.php?window=building_bank&mode=get_data'] = () => ({
    error: false,
    deposit: 10,
    own_money: 50,
    deposit_fee: 4,
    town_name: 'Slobozia',
    stage: 2,
  });
  routes['/game.php?window=building_bank&action=deposit'] = () => ({
    error: false,
    deposit: 30,
    own_money: 30,
    fee: 1,
  });
  routes['/game.php?window=building_general&town_id=1421'] = () => ({
    trader_inv: [{ item_id: 700000 }],
    charge: 1,
    level: 3,
    town_name: 'Slobozia',
  });
  routes['/game.php?window=building_tailor&town_id=1421'] = routes['/game.php?window=building_general&town_id=1421'];
  routes['/game.php?window=building_gunsmith&town_id=1421'] = routes['/game.php?window=building_general&town_id=1421'];
  routes['/game.php?window=shop_trader&mode=index'] = () => ({
    inventory: {
      trader: [
        {
          item_id: 700000,
          tab: 'trader',
          currency: 4,
          price_dollar: 15,
          reduced_value: 0,
          limited_time: null,
          limited_count: null,
          teaser: 'Food',
        },
      ],
    },
    currencies: { 4: 'dollar' },
    traderTime: Math.floor(Date.now() / 1000) + 600,
  });
  routes['/game.php?window=building_market&action=search'] = () => ({
    error: false,
    msg: {
      search_result: [
        {
          market_offer_id: 21,
          item_id: 700000,
          item_count: 2,
          max_price: 30,
          auction_ends_in: 7200,
          seller_name: 'Bob',
          seller_player_id: 9,
          market_town_name: 'Slobozia',
          market_town_x: 200,
          market_town_y: 200,
          direction: 'BUY',
        },
      ],
      next: false,
    },
  });
  routes['/game.php?window=building_market&action=fetch_bids'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=building_market&action=fetch_offers'] = () => ({ error: false, msg: { search_result: [] } });
  routes['/game.php?window=duel&action=get_data'] = () => ({
    npcs: {
      npcs: [{ duelnpc_id: 3, npc_name: 'Dusty Joe', npc_level: 12, weapon_id: 0, arrival_delta: 0 }],
      arrival_delay: 0,
    },
    motivation: 0.8,
    motivation_npc: 1,
  });
  routes['/game.php?window=duel&action=search_op'] = () => ({ oplist: { pclist: [], page: 0, next: false } });
  routes['/game.php?window=quest&action=finish_quest'] = () => ({ error: false, msg: 'Done', allRewards: [] });
  routes['/game.php?window=building_quest&mode=get_open_quests'] = () => QUESTS;
  routes['/game.php?window=inventory&action=inventory_changed'] = () => ({ changes: false, wear: {} });
  state.quests = QUESTS.quests.map((query: any) => parseQuest(query, (id: number) => state.itemName(id)));
  const fin = state.quests.find((currentQuest) => currentQuest.finishable)!;
  fin.rewardOptions = [
    { id: 11, text: 'A horse' },
    { id: 12, text: 'A gun' },
  ];
  // Chat: a poller that is "active" with one room (no network loop).
  const poller = new ChatPoller(state.client, { policy: { ...FAST, lane: 'chat' } as any });
  (poller as any).running = true;
  poller.handle({
    id: 'Status',
    t: 1,
    payload: {
      self: { id: 'client_42', name: 'shallax', level: 30, townId: 1421, town_rights: 3, actioned: Date.now() },
      clients: [{ id: 'client_9', name: 'Bob', level: 12, townId: 1421, town_rights: 1, actioned: Date.now() }],
      disabledrooms: [],
      rooms: [
        {
          roomdescription: { id: 'room_town_1421', room: 'town', title: 'Slobozia', townid: 1421 },
          members: ['client_42', 'client_9'],
        },
      ],
    },
  });
  poller.handle({
    id: 'Text',
    t: Date.now(),
    payload: { cid: 'client_9', to: 'room_town_1421', message: 'anyone selling ham?' },
  });
  const said: string[] = [];
  poller.say = async (_to: string, message: string) => void said.push(message);
  state.live = poller;

  const transform = tui(state);
  try {
    await transform.settle();
    // Home (start screen): chat at the bottom; Enter + typing does not trigger shortcuts.
    assert.match(transform.plain(), /Task queue \d+\/\d+/);
    assert.match(transform.plain(), /Slobozia/);
    assert.match(transform.plain(), /Bob: anyone selling ham\?/);
    assert.match(transform.plain(), /Enter chat · ←\/→ room/);
    await transform.keys('\r');
    await transform.type('more ham m q');
    await transform.keys('\r');
    assert.deepEqual(said, ['more ham m q']);
    said.length = 0;
    // Debug (g x): the log pane's lines are listed; Tab shows what the autopilot sees; / filters.
    state.debug.add('autopilot', 'Carry out: test decision', { why: 'because' });
    await transform.keys('g', 'x');
    assert.match(transform.plain(), /Debug log/);
    assert.match(transform.plain(), /Carry out: test decision/);
    assert.match(transform.plain(), /"why": "because"/);
    await transform.keys('\t');
    assert.match(transform.plain(), /Now \(what the autopilot sees\)/);
    assert.match(transform.plain(), /homeTown: \{"name":"town 1421","at":\{"x":200,"y":200\},"seconds":\d+\}/);
    assert.match(transform.plain(), /quests: \(\d+\)/);
    await transform.keys('\t', '/');
    await transform.type('zzz');
    await transform.keys('\r');
    assert.match(transform.plain(), /0\/\d+ · all · \/zzz/);
    await transform.keys('\u001b');
    // Mail: reports listed, Enter opens one, Tab → telegrams, Enter reads, n composes and sends.
    await transform.keys('g', 'r');
    await transform.settle(300);
    assert.match(transform.plain(), /Job report: Tending pigs/);
    await transform.keys('\r');
    assert.match(transform.plain(), /You earned \$ 90/);
    assert.match(transform.plain(), /Motivation: 82%/);
    assert.match(transform.plain(), /Money: \$47/);
    assert.doesNotMatch(transform.plain(), /&#/);
    await transform.keys('\t', '\r');
    assert.match(transform.plain(), /Want to trade some ham\?/);
    await transform.keys('n');
    await transform.type('Bob');
    await transform.keys('\r');
    await transform.type('Ham');
    await transform.keys('\r');
    await transform.type('Got any? q i');
    await transform.keys('\r');
    await transform.settle(200);
    assert.deepEqual(Object.fromEntries(params(callTo('action=send')[0]!.body)), {
      to: 'Bob',
      subject: 'Ham',
      text: 'Got any? q i',
      masstelegramm: '0',
    });
    assert.equal(callTo('action=send').length, 1, 'typed letters did not trigger global shortcuts');
    await transform.keys('\x1b', '\x1b');

    // Esc goes back through the screens visited (debug → mail → Esc → debug → Esc → home); a screen's key does not toggle.
    await transform.keys('g', 'x', 'g', 'r', 'g', 'r');
    transform.reset();
    await transform.keys('\x1b');
    assert.match(transform.plain(), /Debug log/);
    transform.reset();
    await transform.keys('\x1b');
    assert.match(transform.plain(), /Task queue \d+\/\d+/);

    // Header: XP within the level (level 30 starts at 29232 XP and needs 2913; this test character has less).
    assert.match(transform.plain(), /XP ░+ 0\/2913 0%/);
    // Trade: bank → Enter → deposit form prefilled with the cash; edit to 20 and submit.
    await transform.keys('g', 'b');
    await transform.settle(200);
    assert.match(transform.plain(), /Deposit fee 4%/);
    assert.match(transform.plain(), /home town; you are not there/);
    await transform.keys('\r', '\x7f', '\x7f');
    await transform.type('20');
    assert.match(transform.plain(), /Fee: \$ 1/);
    await transform.keys('\r');
    await transform.settle(200);
    assert.equal(params(callTo('action=deposit')[0]!.body).get('amount'), '20');
    // Mobile trader tab: the rotating offers are listed with dollar prices.
    await transform.keys('\x1b[C');
    await transform.settle(200);
    assert.match(transform.plain(), /Mobile trader/);
    assert.match(transform.plain(), /Ham.*\$15/);
    // General store: buying needs you in town.
    await transform.keys('\x1b[C');
    await transform.settle(200);
    assert.match(transform.plain(), /Ham/);
    await transform.keys('\r');
    assert.match(transform.plain(), /You are not in town 1421/);
    // Market (two tabs on): t shows buy orders; n opens the buy-order form, which resolves the item name.
    await transform.keys('\x1b[C', '\x1b[C', '\x1b[C');
    await transform.settle(200);
    assert.match(transform.plain(), /For sale/);
    transform.reset();
    await transform.keys('t');
    await transform.settle(200);
    assert.equal(params(callTo('action=search').at(-1)!.body).get('direction_buy'), 'true');
    assert.match(transform.plain(), /Buy orders \(wanted\)/);
    assert.match(transform.plain(), /2× Ham/);
    await transform.keys('n');
    await transform.type('bowie');
    assert.match(transform.plain(), /Bowie knife · fee up to/);
    await transform.keys('\x1b', '\x1b');

    // Duels
    await transform.keys('g', 'd');
    await transform.settle(300);
    assert.match(transform.plain(), /Dusty Joe/);
    // g j jumps to the jobs view from any screen.
    transform.reset();
    await transform.keys('g', 'j');
    assert.match(transform.plain(), /Task queue/);

    // Chat: history and the town roster (status, role, level); Enter, type, Enter sends.
    await transform.keys('g', 'c');
    assert.match(transform.plain(), /Bob: anyone selling ham\?/);
    assert.match(transform.plain(), /Town · 2\/2 online/);
    assert.match(transform.plain(), /Mayor/);
    assert.match(transform.plain(), /Citizen\s+L12/);
    await transform.keys('\r');
    await transform.type('yes, 3 q');
    await transform.keys('\r');
    assert.deepEqual(said, ['yes, 3 q']);
    await transform.keys('\x1b');

    // Quests: finishing with two reward options → choose the second.
    await transform.keys('g', 'q');
    await transform.settle(200);
    // Move down until the finishable quest is selected (its key hint offers "Enter finish").
    for (let index = 0; index < 8 && !/Enter finish/.test(transform.plain().split('Quest log').at(-1)!); index++) {
      transform.reset();
      await transform.keys('j');
    }
    await transform.keys('\r');
    assert.match(transform.plain(), /Choose a reward/);
    await transform.keys('\x1b[C', 'y');
    await transform.settle(200);
    assert.equal(params(callTo('finish_quest')[0]!.body).get('reward_option_id'), '12');
  } finally {
    transform.done();
  }
});

test('job detail: danger and motivation come from job/job, concurrent loads are deduped', async () => {
  fakeServer();
  routes['/game.php?window=job&mode=job'] = (body) => {
    const urlValue = new URLSearchParams(body);
    assert.equal(urlValue.get('jobId'), '1');
    return {
      id: 1,
      danger: 37,
      motivation: 0.55,
      minMaxItemVal: [10, 400],
      durations: [
        { duration: 15, cost: 1, money: 1, xp: 5, luck: 0.01, items: [] },
        { duration: 600, cost: 5, money: 50, xp: 200, luck: 0, items: [] },
        { duration: 3600, cost: 12, money: 90, xp: 500, luck: 0, items: [] },
      ],
    };
  };
  const state = makeState();
  state.jobs = [
    {
      id: 1,
      groupid: 12,
      name: 'Tending pigs',
      shortname: 'swine',
      level: 4,
      malus: 1,
      skills: {},
      durations: { short: 15, middle: 600, long: 3600 },
      yields: {},
      jobPoints: 50,
      workPoints: 2,
      laborPoints: 49,
      motivation: 1,
      valuesMotivation: 1,
      danger: null,
      luckValue: [0, 400],
      values: {},
    },
  ];
  state.world.jobGroups = new Map([[12, [{ x: 120, y: 100 }]]]);
  const option = state.jobOptions('pigs')[0]!;
  assert.ok(option.at);
  assert.equal(option.job.danger, null);
  await Promise.all([state.loadJobDetail(option.job, option.at), state.loadJobDetail(option.job, option.at)]);
  assert.equal(option.job.danger, 37);
  assert.equal(option.job.motivation, 0.55);
  assert.equal(state.jobValues(option).long?.experience, 500);
  assert.deepEqual(option.job.luckValue, [10, 400]);
  assert.equal(calls.filter((candidate) => candidate.url.includes('window=job&mode=job')).length, 1);
  await state.loadJobDetail(option.job, option.at);
  assert.equal(calls.filter((candidate) => candidate.url.includes('window=job&mode=job')).length, 2);
});

test('discovered gold job: job/job values become a special row at the exact location', async () => {
  fakeServer();
  routes['/game.php?window=job&mode=job'] = (body) => {
    const urlValue = new URLSearchParams(body);
    assert.equal(urlValue.get('jobId'), '1');
    assert.equal(urlValue.get('x'), '120');
    assert.equal(urlValue.get('y'), '100');
    return {
      id: 1,
      danger: 12,
      motivation: 0.58,
      is_gold: true,
      minMaxItemVal: [0, 400],
      durations: [
        { duration: 15, cost: 1, money: 2, xp: 10, luck: 0.01, items: [] },
        { duration: 600, cost: 5, money: 100, xp: 400, luck: 0, items: [] },
        {
          duration: 3600,
          cost: 12,
          money: 355,
          xp: 888,
          luck: 0,
          items: [{ itemid: 700000, prop: 62 }],
        },
      ],
    };
  };
  const state = makeState();
  state.jobs = [
    {
      id: 1,
      groupid: 12,
      name: 'Tending pigs',
      shortname: 'swine',
      level: 4,
      malus: 1,
      skills: {},
      durations: { short: 15, middle: 600, long: 3600 },
      yields: {},
      jobPoints: 50,
      workPoints: 2,
      laborPoints: 49,
      motivation: 0.58,
      valuesMotivation: 0.58,
      danger: null,
      luckValue: [0, 400],
      values: {
        long: { duration: 3600, energy: 12, money: 355, experience: 888, luck: 0, items: [] },
      },
    },
  ];
  state.world.jobGroups = new Map([[12, [{ x: 120, y: 100 }]]]);
  state.tiles.specialJobs.set('120,100#1', {
    x: 120,
    y: 100,
    jobId: 1,
    groupId: 12,
    gold: true,
    silver: false,
    seenAt: Date.now(),
  });

  const before = state.jobOptions().find((option) => option.pendingSpecial);
  assert.ok(before);
  assert.equal(before.special, 'gold');
  assert.deepEqual(state.jobValues(before), {});
  assert.equal(await state.loadNextSpecialJob(), true);
  const options = state.jobOptions('pigs');
  const special = options.find((option) => option.special === 'gold');
  assert.ok(special);
  assert.deepEqual(special.at, { x: 120, y: 100 });
  assert.equal(state.jobValues(special).long?.experience, 888);
  assert.equal(state.jobValues(special).long?.money, 355);
  state.jobs[0]!.motivation = 0.46;
  assert.equal(state.jobValues(special).long?.experience, 592);
  assert.equal(state.specialJobOptions()[0]?.special, 'gold');

  const reloaded = makeState();
  reloaded.jobs = state.jobs;
  reloaded.loadSpecialCache();
  assert.equal(reloaded.tiles.specialJobs.size, 1);
  assert.equal(reloaded.specialJobOptions()[0]?.special, 'gold');
  assert.equal(reloaded.specialJobOptions()[0]?.at?.x, 120);
});

test('sync: background game.php re-read updates health/money and flags a drop (no push after being dueled)', async () => {
  const second = bootstrap();
  const client = new GameClient({
    worldUrl: WORLD,
    h: second.h,
    jar: new CookieJar(),
    identity: { userAgent: 'UA', acceptLanguage: 'en' },
    policy: FAST,
  });
  let next = second;
  let reopened = 0;
  const gameState = new GameState({ client, bootstrap: second }, async () => {
    reopened++;
    return { client: {} as any, bootstrap: next };
  });
  assert.equal(gameState.character.health, 300);

  next = bootstrap();
  next.character = {
    ...next.character,
    health: 120,
    cash: 20,
    experience: 1500,
    pos: { x: 200, y: 200 },
    taskQueue: [],
  };
  await gameState.syncCharacter();
  assert.equal(reopened, 1);
  assert.equal(gameState.character.health, 120);
  assert.equal(gameState.character.cash, 20);
  assert.equal(gameState.character.experience, 1500);
  assert.deepEqual(gameState.character.position, { x: 200, y: 200 });
  assert.equal(gameState.client, client, 'keeps the live client');
  assert.ok(gameState.lastSync > 0);
  assert.match(gameState.log.at(-1)!.msg, /Health 300 → 120, cash \$50 → \$20\. Attacked\?/);

  // Nothing changed: no warning.
  const count = gameState.log.length;
  await gameState.syncCharacter();
  assert.equal(gameState.log.length, count);

  // Failure is logged, not thrown, and does not lock other actions.
  const bad = new GameState({ client, bootstrap: bootstrap() }, async () => {
    throw new Error('down');
  });
  await bad.syncCharacter('report');
  assert.match(bad.log.at(-1)!.msg, /Sync \(report\): down/);
  assert.equal(bad.busy, false);
});

test('auto-route: queues the rest of a route as queue space and energy allow, in order', async () => {
  fakeServer();
  const gameState = makeState();
  let nextId = 100;
  const added: number[] = [];
  routes['/game.php?window=task&action=add'] = (body) => {
    const idx = [
      ...new Set([...params(body).keys()].map((key) => key.match(/^tasks\[(\d+)\]/)?.[1]).filter(Boolean)),
    ] as string[];
    const tasks: Record<string, unknown> = {};
    for (const textValue of idx) {
      const jobId = Number(params(body).get(`tasks[${textValue}][jobId]`));
      added.push(jobId);
      tasks[textValue] = {
        task: {
          queue_id: nextId++,
          type: 'job',
          date_start: 1,
          date_done: 2,
          data: { job_id: jobId, title: `job${jobId}`, coords: { x: 1, y: 1 } },
        },
      };
    }
    return { tasks };
  };
  const job = (id: number): any => ({
    id,
    groupid: 1,
    name: `job${id}`,
    durations: { long: 3600 },
    values: { long: { duration: 3600, energy: 12, money: 1, experience: 1, luck: 0, items: [] } },
  });
  const stop = (id: number, runs: number) => ({
    job: job(id),
    at: { x: 1, y: 1 },
    duration: 'long',
    runs,
    travel: 0,
    gains: {},
    energy: 12 * runs,
    seconds: 0,
    xp: 0,
    money: 0,
  });
  const plan: any = {
    needs: [],
    stops: [stop(1, 2), stop(2, 3)],
    unmet: [],
    leftover: {},
    totals: { energy: 60, seconds: 0, travel: 0, xp: 0, money: 0, runs: 5 },
    fitRuns: 3,
    energyShort: 24,
  };

  gameState.character.setEnergy(40); // 3 × 12 fit; queue limit 4 (no automation)
  await gameState.queueRoute(plan, { auto: true, label: 'this quest' });
  assert.deepEqual(added, [1, 1, 2]);
  assert.equal(gameState.queue.length, 3);
  assert.equal(gameState.autoRoute?.runs.length, 2);

  // No energy for the next run: no request.
  const count = calls.length;
  await gameState.autoRouteStep();
  assert.equal(calls.length, count);

  // Energy back, but only one free slot.
  gameState.character.setEnergy(100);
  await gameState.autoRouteStep();
  assert.deepEqual(added, [1, 1, 2, 2]);
  assert.equal(gameState.autoRoute?.runs.length, 1);

  // Queue full: no request. A task finishes → the last run goes in and auto-route ends.
  await gameState.autoRouteStep();
  assert.equal(added.length, 4);
  gameState.queue.shift();
  await gameState.autoRouteStep();
  assert.deepEqual(added, [1, 1, 2, 2, 2]);
  assert.equal(gameState.autoRoute, null);
  assert.match(gameState.log.at(-1)!.msg, /Auto-route done: all 5 job\(s\) queued/);

  // Refused by the server: retried later, not every second; x (stop) clears it.
  routes['/game.php?window=task&action=add'] = () => ({ tasks: { 0: { error: true, msg: 'Not enough energy' } } });
  routes['/game.php?window=task&mode=get_tasks'] = () => ({ queue: [] });
  gameState.queue = [];
  await gameState.queueRoute(plan, { auto: true });
  assert.ok(gameState.log.some((line) => /Auto-route: Not enough energy/.test(line.msg)));
  assert.ok((gameState.autoRoute as any).retryAt > Date.now());
  const value = calls.length;
  await gameState.autoRouteStep();
  assert.equal(calls.length, value);
  gameState.stopAutoRoute();
  assert.equal(gameState.autoRoute, null);
});

test('wake: a timer gap far above the interval counts as sleep; the rebuilt state keeps log and auto-route', async () => {
  const { WakeDetector } = await import('../src/util/wake.ts');
  let time = 1_000_000;
  const woke: number[] = [];
  const width = new WakeDetector((ms) => woke.push(ms), { intervalMs: 5_000, gapMs: 60_000, now: () => time });
  time += 5_000;
  assert.equal(width.check(), null);
  time += 59_000; // a slow tick (busy event loop) is not a sleep
  assert.equal(width.check(), null);
  time += 2 * 3600_000;
  assert.equal(width.check(), 2 * 3600_000);
  assert.deepEqual(woke, [2 * 3600_000]);
  time += 5_000;
  assert.equal(width.check(), null, 'measured from the wake, not from before the sleep');

  const old = makeState();
  old.info('before sleep');
  old.autoRoute = {
    label: 'this quest',
    runs: [{ post: {}, energy: 12, title: 'job1' }] as any,
    total: 3,
    retryAt: Date.now() + 60_000,
  };
  const next = makeState();
  next.carryOver(old);
  assert.ok(next.log.some((line) => line.msg === 'before sleep'));
  assert.equal(next.autoRoute?.runs.length, 1);
  assert.equal(next.autoRoute?.retryAt, 0, 'retries right away after waking');
});

test('autopilot needs: quests it cannot finish are skipped; rewards and deadlines ride on the needs', async () => {
  fakeServer();
  const gameState = makeState();
  gameState.jobs = [
    {
      id: 7,
      groupid: 1,
      name: 'Cutting tobacco',
      jobPoints: 10,
      workPoints: 1,
      laborPoints: 9,
      motivation: 1,
      danger: null,
      durations: {},
      luckValue: [0, 0],
      values: { long: { duration: 3600, energy: 12, money: 10, experience: 50, luck: 0, items: [] } },
    } as any,
  ];
  gameState.world.jobGroups = new Map([[1, [{ x: 110, y: 100 }]]]);
  const soon = new Date((gameState.clock.now() + 12 * 3600) * 1000);
  const pad = (count: number) => String(count).padStart(2, '0');
  const limited = `until the ${pad(soon.getUTCDate())}.${pad(soon.getUTCMonth() + 1)}.${soon.getUTCFullYear()} at ${pad(soon.getUTCHours())}:00`;
  const quest = (id: number, title: string, requirements: any[], options: any = {}) => ({
    id,
    title,
    soloTitle: title,
    groupId: 1,
    group: 'Chain',
    employer: 'e',
    employerName: 'E',
    employerAt: null,
    accepted: true,
    acceptable: false,
    finishable: false,
    requirements,
    rewards: [],
    rewardOptions: [],
    description: '',
    hint: '',
    limited: '',
    ...options,
  });
  gameState.quests = [
    quest(1, 'Cut it', [{ solved: false, info: 'Cutting tobacco (0/4)', jobId: 7, kind: 'job' }], {
      rewards: [
        { item: null, text: '500 Experience points' },
        { item: null, text: '40 Dollars' },
      ],
      limited,
    }),
    quest(2, 'Go there', [
      { solved: false, info: 'Cutting tobacco (0/2)', jobId: 7, kind: 'job' },
      { solved: false, info: 'Go to The Mexican', kind: 'other' },
    ]),
  ] as any;
  assert.equal(gameState.questBlocker(gameState.quests[0]!), null);
  assert.match(gameState.questBlocker(gameState.quests[1]!)!, /Go to The Mexican: the autopilot cannot do this/);
  const [need] = gameState.autopilotNeeds();
  assert.equal(need!.amount, 4, 'only the quest it can finish (4 runs, not 6)');
  assert.equal(need!.xpPerUnit, 125, '500 XP over 4 runs');
  assert.equal(need!.moneyPerUnit, 10);
  assert.ok(need!.weight! > 1.8 && need!.weight! <= 2, 'ends in 12 h: nearly double');
  gameState.updateAutopilot((autopilotFile) => (autopilotFile.config.quests.unfinishable = true));
  assert.equal(gameState.autopilotNeeds()[0]!.amount, 6, 'toggle on: both');
});

test('quest items no job drops: blocked until a shop in reach sells them, then a shopping trip; a time window only waits', async () => {
  fakeServer();
  const gameState = makeState();
  const { ItemCatalog: ItemCatalogModule } = await import('../src/game/items.ts');
  gameState.items = ItemCatalogModule.fromSlim([{ id: 1856, name: 'Jug of water', type: 'yield', price: 30 } as any]);
  gameState.world.towns = [{ id: 3, x: 150, y: 100, name: 'Slobozia', members: 1, npc: false, points: 0 }];
  const quest = (id: number, requirements: any[]) => ({
    id,
    title: `Q${id}`,
    soloTitle: `Q${id}`,
    groupId: 1,
    group: 'Chain',
    employer: 'e',
    employerName: 'E',
    employerAt: null,
    accepted: true,
    acceptable: false,
    finishable: false,
    requirements,
    rewards: [],
    rewardOptions: [],
    description: '',
    hint: '',
    limited: '',
  });
  gameState.quests = [
    quest(1, [{ solved: false, info: 'Jug of water 0/2', itemId: 1856000, count: 2, kind: 'item' }]),
    quest(2, [
      {
        solved: false,
        info: "This quest is only available between 06:00 and 11:00 o'clock.",
        kind: 'window',
        window: { from: '06:00', to: '11:00' },
      },
    ]),
  ] as any;
  assert.match(gameState.questBlocker(gameState.quests[0]!)!, /Jug of water: no job drops it, and no shop in reach/);
  assert.equal(gameState.questBlocker(gameState.quests[1]!), null, 'a window is not a blocker');
  gameState.buyCatalog.setShops(3, [
    { key: 'general', townId: 3, townName: 'Slobozia', level: 1, charge: 1, items: [1856000] },
  ]);
  assert.equal(gameState.questBlocker(gameState.quests[0]!), null);
  assert.deepEqual(
    gameState.buyTrips().map((target) => [target.townId, target.cost, target.what]),
    [[3, 60, ['2× Jug of water (general store) for "Q1"']]],
  );
  gameState.updateAutopilot((autopilotFile) => (autopilotFile.config.quests.buyLimit = 50));
  assert.match(
    gameState.questBlocker(gameState.quests[0]!)!,
    /\$60 \(general store in Slobozia\), over the \$50 quest buy limit/,
  );
  gameState.updateAutopilot((autopilotFile) => (autopilotFile.config.quests.buy = false));
  assert.match(
    gameState.questBlocker(gameState.quests[0]!)!,
    /Jug of water 0\/2: no doable job drops it/,
    'buying off: as before',
  );
  assert.deepEqual(gameState.buyTrips(), []);
});

test('calibration hooks: HP lost after a dangerous job; queued sleeps keep their room rates in the projection', async () => {
  fakeServer();
  const gameState = makeState();
  const now = gameState.clock.now();
  gameState.jobs = [
    {
      id: 9,
      groupid: 1,
      name: 'Hunting',
      jobPoints: 10,
      workPoints: 1,
      laborPoints: 9,
      motivation: 1,
      danger: 50,
      durations: {},
      luckValue: [0, 0],
      values: { long: { duration: 3600, energy: 12, money: 10, experience: 50, luck: 0, items: [] } },
    } as any,
  ];
  gameState.character.healthRegen = 0;
  gameState.character.setHealth(300);
  gameState.queue = [
    {
      queueId: 5,
      type: 'job',
      start: now - 3600,
      end: now - 1,
      coords: { x: 1, y: 1 },
      title: 'Hunting',
      jobId: 9,
      raw: {},
    },
  ];
  gameState.tick();
  gameState.applySelf({ health: 280, healthAt: 0 });
  assert.equal(gameState.calibration.data.hp.runs, 1);
  assert.equal(gameState.calibration.data.hp.observed, 20);
  assert.ok(gameState.debug.entries.some((entry) => /Calibration: Hunting cost 20 HP/.test(entry.title)));
  gameState.queue = [
    { queueId: 6, type: 'sleep', start: now, end: now + 8 * 3600, coords: { x: 1, y: 1 }, title: 'Sleep', raw: {} },
  ];
  gameState.sleepRates.set(6, { energyRate: 0.5, healthRate: 0.4 });
  const st = gameState.queuedStep(gameState.queue[0]!) as any;
  assert.deepEqual([st.energyRate, st.healthRate], [0.5, 0.4], 'not base regen');
});

test('live update: energy_date / health_date are offsets from now; queue time jitter does not replan', async () => {
  fakeServer();
  const gameState = makeState();
  const now = gameState.clock.now();
  gameState.character.energyRegen = 0.03;
  gameState.applySelf({ energy: 66, energyAt: -3600, health: 300, healthAt: -780 });
  assert.equal(gameState.character.energy, 69, '66 measured an hour ago at 3/h, not regen since 1970');
  assert.ok(Math.abs(gameState.character.serverValues.energyAt - (now - 3600)) < 2);
  assert.ok(Math.abs(gameState.character.serverValues.healthAt - (now - 780)) < 2);

  gameState.queue = [
    { queueId: 1, type: 'job', start: now, end: now + 3600.300001, coords: { x: 0, y: 0 }, title: 'job', raw: {} },
  ];
  const result = gameState.runner as any;
  const print = () => JSON.stringify(result.inputs([]));
  const before = print();
  gameState.queue[0]!.end = now + 3600.299904;
  assert.equal(print(), before, 'sub-ms jitter from the clock offset');
  gameState.queue[0]!.end = now + 3700;
  assert.notEqual(print(), before);
});

test('autopilot runner: queues what the energy covers, sleeps when out, wakes at the target, deposits, backs off', async () => {
  fakeServer();
  const gameState = makeState();
  let nextId = 200;
  const added: Record<string, string>[] = [];
  routes['/game.php?window=task&action=add'] = (body) => {
    const pick = params(body);
    const idx = [
      ...new Set([...pick.keys()].map((key) => key.match(/^tasks\[(\d+)\]/)?.[1]).filter(Boolean)),
    ] as string[];
    const tasks: Record<string, unknown> = {};
    const now = Math.floor(Date.now() / 1000);
    for (const textValue of idx) {
      const get = (key: string) => pick.get(`tasks[${textValue}][${key}]`) ?? '';
      added.push({ type: get('taskType'), jobId: get('jobId'), room: get('room') });
      const type = get('taskType');
      tasks[textValue] = {
        task: {
          queue_id: nextId++,
          type,
          date_start: now,
          date_done: now + 3600,
          data: {
            job_id: Number(get('jobId')) || undefined,
            title: type === 'sleep' ? 'Sleep' : `job${get('jobId')}`,
            coords: type === 'sleep' ? { x: 200, y: 200 } : { x: 110, y: 100 },
          },
        },
      };
    }
    return { tasks };
  };
  routes['/game.php?window=building_hotel&mode=get_data'] = () => ({
    hotel_level: 1,
    town_name: 'Slobozia',
    own_hotel: true,
    rooms: { cubby: { name: 'Cubby', level: 1, available: true, free: true, costs: 0, energy: 50, health: 50 } },
  });
  let cancelled = 0;
  routes['/game.php?window=task&action=cancel'] = () => {
    cancelled++;
    return { tasks: { 0: {} }, queue: [] };
  };
  gameState.world.towns = [{ id: 1421, x: 200, y: 200, name: 'Slobozia', members: 1, npc: false, points: 0 }];
  gameState.world.jobGroups = new Map([[1, [{ x: 110, y: 100 }]]]);
  gameState.jobs = [
    {
      id: 7,
      groupid: 1,
      name: 'Cutting tobacco',
      jobPoints: 10,
      workPoints: 1,
      laborPoints: 9,
      motivation: 1,
      danger: null,
      durations: {},
      luckValue: [0, 0],
      values: { long: { duration: 3600, energy: 12, money: 10, experience: 50, luck: 0, items: [] } },
    } as any,
  ];
  gameState.updateAutopilot((autopilotFile) => {
    autopilotFile.config.running = true;
    autopilotFile.config.priority = ['xp', 'money', 'quests', 'products'];
  });

  // 40 energy: three 12-energy runs fit.
  await gameState.runner.step(); // plans; the hotel loads in the background
  await new Promise((transform) => setTimeout(transform, 20));
  (gameState.runner as any).lastCheck = 0;
  await gameState.runner.step();
  assert.deepEqual(
    added.map((first) => `${first.type}${first.jobId}`),
    ['job7', 'job7', 'job7', 'sleep'],
    'then a sleep in the last slot: 4 energy left, no regen',
  );
  assert.equal(gameState.queue.length, 4);
  assert.ok(gameState.log.some((line) => /Autopilot: queued/.test(line.msg)));
  // Debug log: the planner's input / output with the context, and the decision to queue.
  const sim = gameState.debug.entries.find((entry) => entry.cat === 'sim')!;
  const simData = sim.data as any;
  assert.ok(
    simData.input.jobs.some((innerIndex: any) => innerIndex.name === 'Cutting tobacco'),
    'sim input lists the jobs',
  );
  assert.ok(simData.output.tasks.length > 0, 'sim output lists the planned tasks');
  assert.match(simData.context.energy, /^\d+\/\d+$/);
  assert.equal(simData.context.nearestTown.name, 'Slobozia');
  assert.ok(Array.isArray(simData.context.inventory) && Array.isArray(simData.context.quests));
  assert.ok(
    gameState.debug.entries.some((entry) => entry.cat === 'autopilot' && /^Carry out: queue /.test(entry.title)),
  );
  assert.ok(gameState.debug.entries.some((entry) => entry.cat === 'request' && /^queue tasks: ok/.test(entry.title)));
  assert.ok(
    gameState.debug.entries.some((entry) => entry.cat === 'log' && /Autopilot: queued/.test(entry.title)),
    'log lines are mirrored',
  );

  // Out of energy, nothing queued: no regen, so it sleeps in the home hotel (free cubby).
  gameState.queue = [];
  gameState.character.setEnergy(0);
  (gameState.runner as any).lastCheck = 0;
  await gameState.runner.step();
  assert.deepEqual(added.at(-1), { type: 'sleep', jobId: '', room: 'cubby' });
  assert.equal(gameState.queue[0]!.type, 'sleep');

  // Wake target reached (live energy) → the sleep is cancelled.
  gameState.character.setEnergy(100);
  await gameState.runner.step();
  assert.equal(cancelled, 1);
  assert.match(gameState.log.map((line) => line.msg).join('\n'), /woke up/);

  // Refused task: backs off instead of retrying every second.
  routes['/game.php?window=task&action=add'] = () => ({ tasks: { 0: { error: true, msg: 'Not now' } } });
  gameState.queue = [];
  (gameState.runner as any).lastCheck = 0;
  await gameState.runner.step();
  const count = calls.length;
  (gameState.runner as any).lastCheck = 0;
  await gameState.runner.step();
  assert.match(
    gameState.log
      .filter((line) => line.level === 'error')
      .map((line) => line.msg)
      .join('\n'),
    /refused: Not now \(retry in 1 min\)/,
  );
  assert.equal(
    calls.filter((candidate) => candidate.url.includes('action=add')).length,
    calls.slice(0, count).filter((candidate) => candidate.url.includes('action=add')).length,
    'no resend while backing off',
  );

  // Paused: replans but sends nothing.
  gameState.updateAutopilot((autopilotFile) => (autopilotFile.config.running = false));
  const before = calls.length;
  (gameState.runner as any).failures.clear();
  (gameState.runner as any).lastCheck = 0;
  await gameState.runner.step();
  assert.equal(
    calls.filter((candidate) => candidate.url.includes('action=add')).length,
    calls.slice(0, before).filter((candidate) => candidate.url.includes('action=add')).length,
  );

  // Cash over the limit while standing in the home town: deposits on the spot.
  routes['/game.php?window=building_bank&action=deposit'] = (body) => ({
    error: false,
    deposit: 10 + Number(params(body).get('amount')),
    own_money: 0,
    fee: 50,
  });
  gameState.updateAutopilot((autopilotFile) => (autopilotFile.config.running = true));
  gameState.queue = [];
  gameState.character.position = { x: 200, y: 200 };
  gameState.character.cash = 5000;
  (gameState.runner as any).lastCheck = 0;
  await gameState.runner.step();
  assert.equal(gameState.character.cash, 0);
  assert.equal(gameState.character.deposit, 5010);
  assert.match(gameState.log.map((line) => line.msg).join('\n'), /deposited \$ 5000 \(fee \$ 50\)/);
});

test('job report: found items come from reportInfo.items (the page only has empty placeholders); list summary from img alts', async () => {
  const { reportItems, popupItems, MailApi } = await import('../src/game/mail.ts');
  // Trimmed from a live show_report reply (Prospecting, 5× Fool's gold).
  const page =
    '<page><div id="rp_report_job_divLeft"><div class="rp_row_jobdata"><span class="rp_jobdata_label text_bold">Money</span><span class="rp_jobdata_text">&#036; 319</span></div></div>' +
    '<div id="rp_report_job_divRight"><h3 class="rp_job_header">Items Found</h3><div id="rp_job_rewardContainer"><span id="jobreward_item_1876161_708000"></span></div></div></page>';
  const popup =
    '<tr><th colspan="4">Found items:</th></tr><tr><td><div class="bag_item_mini"><img src="/images/items/yield/copper_pyrites.png" alt="Fool&#039;s gold" /></div></td>' +
    '<td><div class="bag_item_mini"><img src="/images/items/yield/copper_pyrites.png" alt="Fool&#039;s gold" /></div></td></tr>';
  const name = (id: number) => (id === 708000 ? "Fool's gold" : `item ${id}`);
  assert.deepEqual(reportItems({ items: [[708000, true, 5, 'yield']], job_id: 18 }, name), ["Fool's gold x 5"]);
  assert.deepEqual(reportItems(undefined, name), []);
  assert.deepEqual(popupItems(popup), ["Fool's gold x 2"]);
  fakeServer();
  routes['/game.php?window=reports&mode=show_report'] = () => ({
    report_id: 1876161,
    title: 'Job report: Prospecting',
    reportType: 'job',
    reportInfo: { items: [[708000, true, 5, 'yield']], job_id: 18 },
    page,
    date_received: 'Today',
  });
  routes['/game.php?window=reports&action=get_reports'] = () => ({
    count: 1,
    page: 1,
    reports: [
      {
        report_id: 1876161,
        title: 'Job report: Prospecting',
        hash: 'h',
        read: false,
        date_received: 'Today',
        popupData: popup,
      },
    ],
  });
  const gameState = makeState();
  const api = new MailApi(gameState.client, name);
  const reportInfo = await api.report(1876161, 'h');
  assert.match(reportInfo.text, /Money: \$319/);
  assert.match(reportInfo.text, /Items: Fool's gold x 5/);
  assert.doesNotMatch(reportInfo.text, /Items: none/);
  const list = await api.reports(1);
  assert.match(list.reports[0]!.summary, /Found items: Fool's gold x 2/);
  const { popupText } = await import('../src/game/mail.ts');
  const fields =
    '<table><tr><td><img src="images/job/clock.png" /></td><td>1 hour</td><td><img src="images/job/dollar.png" /></td><td>319</td></tr>' +
    '<tr><td><img src="images/job/experience.png" /></td><td>76</td><td><img src="images/icons/DayOfDead.png" /></td><td>366 Cempasúchil</td></tr></table>';
  assert.equal(
    popupText(fields),
    'Time: 1 hour Money: 319\nXP: 76 366 Cempasúchil',
    'icon labels named, event icons dropped',
  );
});

test('report log line: job rewards, event currency and found items in one line; other reports by title', async () => {
  const { reportLogLine } = await import('../src/game/mail.ts');
  const row = (title: string, summary: string) => ({ id: 1, title, hash: '', read: false, date: '', summary });
  // Live list summaries (2026-11-03).
  assert.equal(
    reportLogLine(
      row(
        'Job report: Laying railroad tracks',
        'Title: Job report: Laying railroad tracks\nType: Work\nTime: 1 hour Money: 297\nBonds: 0 XP: 161\nDanger: 0 355 Cempasúchil\nFound items: Glass of water x 11',
      ),
    ),
    'Laying railroad tracks: +161 XP, $297, 355 Cempasúchil · found Glass of water x 11',
  );
  assert.equal(
    reportLogLine(row('Job report: Prospecting', 'Time: 1 hour Money: 319\nXP: 76 366 Cempasúchil')),
    'Prospecting: +76 XP, $319, 366 Cempasúchil',
  );
  assert.equal(
    reportLogLine(
      row(
        'Job report: Putting up posters',
        'Type: Work\nTime: 15 seconds Money: 16\nBonds: 0 XP: 8\nDanger: 0 3 Cempasúchil',
      ),
    ),
    'Putting up posters: +8 XP, $16, 3 Cempasúchil',
  );
  assert.equal(
    reportLogLine(row("Achievement 'Disposophobic' gained.", 'Type: Achievements')),
    "Report: Achievement 'Disposophobic' gained.",
  );
});
