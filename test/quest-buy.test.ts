// Buying quest items no job drops: one situation per test, with the result a good player would want, reasoned
// out by hand (the comment says why). Never fill an expectation in from what the code returns.
// R: requirement parsing · B: chooseBuys (which source) · K: BuyCatalog (what a source costs) · P: planner
// trips · S: GameState (what a quest needs, blockers, trips) · M: quest module buying against a fake server.
// Walking: chooseBuys tests use travel = x (1 unit = 1 s) and a walk worth $0.25 / s ($15 / min, the default).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'twcli-questbuy-'));
process.env.TW_CLI_HOME = home;
process.env.TW_ITEMS_FILE = fileURLToPath(new URL('./fixtures/items.sample.json', import.meta.url));

const { CookieJar } = await import('../src/http/cookie-jar.ts');
const { GameClient } = await import('../src/http/game-client.ts');
const { resetThrottle } = await import('../src/http/throttle.ts');
const { GameState } = await import('../src/game/state.ts');
const { ItemCatalog } = await import('../src/game/items.ts');
const { JobCatalog } = await import('../src/game/jobs.ts');
const { parseQuest } = await import('../src/game/quests.ts');
const { parseMobileTraderItem } = await import('../src/game/trade.ts');
const { BuyCatalog, chooseBuys } = await import('../src/game/quest-buy.ts');
const { planAutopilot } = await import('../src/game/autopilot.ts');
const { DEFAULT_CONFIG, EMPTY_RULES, parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
const { QuestModule } = await import('../src/game/autopilot-quests.ts');
const { walkPost } = await import('../src/game/tasks.ts');
const { levelStartXp } = await import('../src/game/character.ts');
type BuySource = import('../src/game/quest-buy.ts').BuySource;
type BuyLimits = import('../src/game/quest-buy.ts').BuyLimits;

test.after(() => rmSync(home, { recursive: true, force: true }));

// ---- R: requirement parsing --------------------------------------------------------------------------------

const req = (info: string, jsInfo: unknown = null, solved = false) =>
  parseQuest({ id: 1, title: 'Q', requirements: [{ solved, info, jsInfo }] }).requirements[0]!;

test('R1 a time window is its own kind with its hours', () => {
  const requirement = req("This quest is only available between 06:00 and 11:00 o'clock.");
  assert.equal(requirement.kind, 'window');
  assert.deepEqual(requirement.window, { from: '06:00', to: '11:00' });
});

test('R2 single-digit hours are read as written', () => {
  assert.deepEqual(req("This quest is only available between 6:00 and 9:30 o'clock.").window, {
    from: '6:00',
    to: '9:30',
  });
});

test('R3 a solved window stays a window (solved)', () => {
  const requirement = req("This quest is only available between 06:00 and 11:00 o'clock.", null, true);
  assert.equal(requirement.kind, 'window');
  assert.equal(requirement.solved, true);
});

test('R4 "Item \'X\' bought" names the item to buy', () => {
  const requirement = req("Item 'White horse' bought");
  assert.equal(requirement.kind, 'bought');
  assert.equal(requirement.buy, 'White horse');
});

test('R5 have / wear requirements carry the item and count from jsInfo', () => {
  const have = req('Jug of water 0/2', { type: 'inventory_changed', id: 1856000, count: 2 });
  const wear = req('Equip Grey rags 0/1', { type: 'wear_changed', id: 300000, count: 1 });
  assert.deepEqual([have.kind, have.itemId, have.count], ['item', 1856000, 2]);
  assert.deepEqual([wear.kind, wear.itemId, wear.count], ['wear', 300000, 1]);
});

test('R6 "Go to …", "Resolve: …" and "Lose against …" stay other (nothing to buy)', () => {
  for (const text of [
    'Go to The Mexican',
    'Resolve: Discipline 1 (Pinkerton Agency)',
    'Lose against Billy the blind eagle',
  ]) {
    assert.equal(req(text).kind, 'other');
  }
});

// ---- B: chooseBuys -----------------------------------------------------------------------------------------

const BUY_LIMITS: BuyLimits = {
  buyLimit: 3000,
  marketLimit: 5000,
  market: true,
  walkValue: 0.25,
  maxWalk: 3600,
};
const shop = (townId: number, xCoord: number, price: number, key = 'general'): BuySource => ({
  kind: 'shop',
  shop: key as any,
  townId,
  townName: `T${townId}`,
  at: { x: xCoord, y: 0 },
  price,
});
const mobile = (price: number, limitedCount: number | null = null): BuySource => ({
  kind: 'mobile',
  item: {
    itemId: 1000,
    tab: 'trader',
    prices: [{ currency: 'dollar', amount: price, base: price }],
    discount: 0,
    limitedAt: null,
    limitedCount,
    teaser: '',
  },
  price,
});
const offer = (id: number, price: number, count = 1, xCoord = 50): BuySource => ({
  kind: 'market',
  offer: { id, count, itemId: 1000, buyNow: price } as any,
  townId: 1000 + xCoord,
  townName: `M${xCoord}`,
  at: { x: xCoord, y: 0 },
  price,
});
const need = (count = 1, itemId = 1000, itemLabel = 'Jug') => ({ itemId, name: itemLabel, count });
const choose = (
  needs: ReturnType<typeof need>[],
  sources: BuySource[] | Record<number, BuySource[]>,
  limits: Partial<BuyLimits> = {},
) =>
  chooseBuys(
    needs,
    (id) => (Array.isArray(sources) ? sources : (sources[id] ?? [])),
    { ...BUY_LIMITS, ...limits },
    (at) => at.x,
  );
const kinds = (result: ReturnType<typeof choose>) => result.picks.map((pick) => pick.source.kind);
const town = (result: ReturnType<typeof choose>, index = 0) =>
  (result.picks[index]!.source as { townId: number }).townId;

test('B1 nothing needed: nothing to buy, no problem', () => {
  assert.deepEqual(choose([], []), { picks: [], problem: null });
});

test('B2 one shop: price × count', () => {
  // 2 × $30 = $60.
  const result = choose([need(2)], [shop(1, 100, 30)]);
  assert.equal(result.problem, null);
  assert.deepEqual([town(result), result.picks[0]!.count, result.picks[0]!.cost], [1, 2, 60]);
});

test('B3 a nearer, slightly dearer shop wins', () => {
  // T1: 60 + 900 s × 0.25 = 285; T2: 70 + 100 × 0.25 = 95.
  assert.equal(town(choose([need(2)], [shop(1, 900, 30), shop(2, 100, 35)])), 2);
});

test('B4 a much cheaper shop is worth the longer walk', () => {
  // T1: 100 + 150 = 250; T2: 400 + 25 = 425.
  assert.equal(town(choose([need()], [shop(1, 600, 100), shop(2, 100, 400)])), 1);
});

test('B5 equal once walking is counted: the shorter walk', () => {
  // T1: 100 + 400 × 0.25 = 200; T2: 200 + 0 = 200. Time is scarcer than money: T2.
  assert.equal(town(choose([need()], [shop(1, 400, 100), shop(2, 0, 200)])), 2);
});

test('B6 a shop 10 s away beats a dear mobile trader offer', () => {
  // Shop: 5 + 2.5 = 7.5; mobile: 40.
  assert.deepEqual(kinds(choose([need()], [mobile(40), shop(1, 10, 5)])), ['shop']);
});

test('B7 the mobile trader beats a shop 50 min away', () => {
  // Shop: 30 + 3000 × 0.25 = 780; mobile: 40, no walk.
  assert.deepEqual(kinds(choose([need()], [mobile(40), shop(1, 3000, 30)])), ['mobile']);
});

test('B8 a cheap market offer beats a dear shop (not only a fallback)', () => {
  // Market: 300 + 200 × 0.25 = 350; shop: 2800 + 25 = 2825.
  assert.deepEqual(kinds(choose([need()], [shop(1, 100, 2800), offer(9, 300, 1, 200)])), ['market']);
});

test('B9 a shop where you stand beats a cheaper market offer far away', () => {
  // Shop: 100; market: 50 + 2000 × 0.25 = 550.
  assert.deepEqual(kinds(choose([need()], [shop(1, 0, 100), offer(9, 50, 1, 2000)])), ['shop']);
});

test('B10 a shop over the $3,000 quest limit: the market under $5,000 instead', () => {
  const result = choose([need()], [shop(1, 0, 3500), offer(9, 3200, 1, 100)]);
  assert.equal(result.problem, null);
  assert.deepEqual([kinds(result), result.picks[0]!.cost], [['market'], 3200]);
});

test('B11 the shop limit is per quest: the second item goes to the market', () => {
  // A: shop $2,000. B: shop $1,500 would make $3,500 > $3,000; the market's $1,600 fits its own $5,000.
  const result = choose([need(1, 1000, 'A'), need(1, 2000, 'B')], {
    1000: [shop(1, 0, 2000)],
    2000: [shop(1, 0, 1500), offer(9, 1600, 1, 0)],
  });
  assert.equal(result.problem, null);
  assert.deepEqual(kinds(result), ['shop', 'market']);
});

test('B12 the same without a market offer: B is the problem, and the message says why', () => {
  const result = choose([need(1, 1000, 'A'), need(1, 2000, 'B')], {
    1000: [shop(1, 0, 2000)],
    2000: [shop(1, 0, 1500)],
  });
  assert.equal(result.picks.length, 1);
  assert.equal(
    result.problem,
    'B: $1,500 (general store in T1), over the $3,000 quest buy limit (with $2,000 for the other items)',
  );
});

test('B13 the market limit is per quest too', () => {
  const result = choose([need(1, 1000, 'A'), need(1, 2000, 'B')], {
    1000: [offer(8, 3000, 1, 0)],
    2000: [offer(9, 2500, 1, 0)],
  });
  assert.equal(
    result.problem,
    'B: $2,500 on the market, over the $5,000 market limit (with $3,000 for the other items)',
  );
});

test('B14 market off: a market-only item cannot be had', () => {
  assert.equal(
    choose([need()], [offer(9, 10)], { market: false }).problem,
    'Jug: no job drops it, and no shop in reach or the mobile trader sells it',
  );
});

test('B15 nowhere at all', () => {
  assert.equal(
    choose([need()], []).problem,
    'Jug: no job drops it, and no shop in reach, the mobile trader or the market sells it',
  );
});

test('B16 the market has too few', () => {
  assert.equal(choose([need(3)], [offer(8, 10), offer(9, 10)]).problem, 'Jug: the market has only 2 of 3');
});

test('B17 a lot of 5 for 2 needed: the whole lot is bought', () => {
  const result = choose([need(2)], [offer(9, 100, 5)]);
  assert.deepEqual([result.picks.length, result.picks[0]!.count, result.picks[0]!.cost], [1, 5, 100]);
});

test('B18 the cheapest combination, not the cheapest per item first', () => {
  // Need 2. X: 3 for $150 ($50 each); Y: 1 for $55; Z: 1 for $56. Greedy by unit price takes X ($150);
  // Y + Z is $111. All in one town, so the walk is the same.
  const result = choose([need(2)], [offer(1, 150, 3), offer(2, 55), offer(3, 56)]);
  assert.deepEqual(result.picks.map((pick) => (pick.source as any).offer.id).sort(), [2, 3]);
  assert.equal(
    result.picks.reduce((accumulator, current) => accumulator + current.cost, 0),
    111,
  );
});

test('B19 one pickup town beats two when the second is far', () => {
  // X 3 for $150 and Y 1 for $55 at x = 50; Z 1 for $56 at x = 1000. Y + Z = 111 + (50 + 1000) × 0.25 = 373.5;
  // X alone = 150 + 12.5 = 162.5.
  const result = choose([need(2)], [offer(1, 150, 3, 50), offer(2, 55, 1, 50), offer(3, 56, 1, 1000)]);
  assert.deepEqual(
    result.picks.map((pick) => (pick.source as any).offer.id),
    [1],
  );
});

test('B20 the first item it cannot get stops the quest (no half shopping)', () => {
  const result = choose([need(1, 1000, 'A'), need(1, 2000, 'B'), need(1, 3000, 'C')], {
    1000: [shop(1, 0, 10)],
    3000: [shop(1, 0, 10)],
  });
  assert.equal(result.picks.length, 1);
  assert.match(result.problem!, /^B: no job drops it/);
});

test('B21 exactly the quest limit fits', () => {
  assert.equal(choose([need()], [shop(1, 0, 3000)]).problem, null);
});

test('B22 a dollar over the quest limit does not', () => {
  assert.match(choose([need()], [shop(1, 0, 3001)], { market: false }).problem!, /over the \$3,000 quest buy limit$/);
});

test('B23 exactly the market limit fits', () => {
  assert.equal(choose([need()], [offer(9, 5000)]).problem, null);
});

test('B24 a price of $0 is unknown, not free: left out', () => {
  assert.match(choose([need()], [shop(1, 0, 0)]).problem!, /no shop in reach/);
});

test('B25 a mobile offer limited to 1 cannot cover 2: the far shop instead', () => {
  assert.deepEqual(kinds(choose([need(2)], [mobile(40, 1), shop(1, 3000, 30)])), ['shop']);
});

test('B26 a mobile offer limited to 2 covers 2', () => {
  // Mobile: 80; shop: 60 + 750 = 810.
  assert.deepEqual(kinds(choose([need(2)], [mobile(40, 2), shop(1, 3000, 30)])), ['mobile']);
});

test('B27 walking worth nothing: the cheapest wins wherever it is', () => {
  assert.equal(town(choose([need()], [shop(1, 3000, 30), shop(2, 0, 35)], { walkValue: 0 })), 1);
});

test('B28 a shop beyond the furthest trip is out of reach; the mobile trader never is', () => {
  assert.match(choose([need()], [shop(1, 4000, 10)]).problem!, /no shop in reach/);
  assert.deepEqual(kinds(choose([need()], [shop(1, 4000, 10), mobile(500)])), ['mobile']);
});

test('B29 a market offer beyond the furthest trip is out of reach (it has to be picked up)', () => {
  assert.match(choose([need()], [offer(9, 10, 1, 3601)]).problem!, /no shop in reach/);
});

test('B30 shop and market allowances are separate: $2,900 + $4,900 both fit', () => {
  const result = choose([need(1, 1000, 'A'), need(1, 2000, 'B')], {
    1000: [shop(1, 0, 2900)],
    2000: [offer(9, 4900, 1, 0)],
  });
  assert.equal(result.problem, null);
  assert.deepEqual(kinds(result), ['shop', 'market']);
});

// ---- K: BuyCatalog -----------------------------------------------------------------------------------------

const towns = (id: number) =>
  (({ 3: { name: 'Slobozia', at: { x: 1, y: 1 } } }) as Record<number, { name: string; at: { x: number; y: number } }>)[
    id
  ];
const marketTown = (at: { x: number }) => (at.x === 7 ? 4 : undefined);
const src = (candidate: InstanceType<typeof BuyCatalog>, itemId = 300000, price = 10) =>
  candidate.sources(itemId, () => price, towns, marketTown);
const aShop = (options: Partial<{ items: number[]; charge: number; key: string }> = {}) => ({
  key: (options.key ?? 'tailor') as any,
  townId: 3,
  townName: 'Slobozia',
  level: 1,
  charge: options.charge ?? 1.5,
  items: options.items ?? [300000],
});
const anOffer = (options: Record<string, unknown> = {}) =>
  ({
    id: 9,
    itemId: 300000,
    count: 1,
    buyNow: 25,
    direction: 'SELL',
    town: { name: 'Far', x: 7, y: 7 },
    ...options,
  }) as any;

test("K1 shop price = item price × the shop's charge, rounded", () => {
  const candidate = new BuyCatalog();
  candidate.setShops(3, [aShop()]);
  assert.deepEqual(
    src(candidate).map((source) => [source.kind, source.price, (source as any).townName]),
    [['shop', 15, 'Slobozia']],
  );
});

test('K2 no charge: the item price', () => {
  const candidate = new BuyCatalog();
  candidate.setShops(3, [aShop({ charge: 0 })]);
  assert.equal(src(candidate)[0]!.price, 10);
});

test('K3 a shop that does not sell it is no source', () => {
  const candidate = new BuyCatalog();
  candidate.setShops(3, [aShop({ items: [205000] })]);
  assert.deepEqual(src(candidate), []);
});

test('K4 any upgrade level of the item counts', () => {
  const candidate = new BuyCatalog();
  candidate.setShops(3, [aShop({ items: [300001] })]);
  assert.equal(src(candidate).length, 1);
});

test('K5 a town no longer on the map is left out', () => {
  const candidate = new BuyCatalog();
  candidate.setShops(99, [{ ...aShop(), townId: 99 }]);
  assert.deepEqual(src(candidate), []);
});

test('K6 shops that could not be read sell nothing', () => {
  const candidate = new BuyCatalog();
  candidate.setShops(3, []);
  assert.deepEqual(src(candidate), []);
});

test('K7 the mobile trader only in dollars: nugget-only offers are left out', () => {
  const candidate = new BuyCatalog();
  candidate.setMobile({
    changesAt: null,
    items: [
      parseMobileTraderItem({ item_id: 300000, currency: 2, price_nuggets: 5 }),
      parseMobileTraderItem({ item_id: 300000, currency: 6, price_nuggets: 5, price_dollar: 700 }),
    ],
  });
  assert.deepEqual(
    src(candidate).map((source) => [source.kind, source.price]),
    [['mobile', 700]],
  );
});

test('K8 a mobile discount lowers the price', () => {
  // 20 % off $1,000.
  const candidate = new BuyCatalog();
  candidate.setMobile({
    changesAt: null,
    items: [parseMobileTraderItem({ item_id: 300000, currency: 4, price_dollar: 1000, reduced_value: 20 })],
  });
  assert.equal(src(candidate)[0]!.price, 800);
});

test('K9 a sold-out mobile offer (limited to 0) is left out', () => {
  const candidate = new BuyCatalog();
  candidate.setMobile({
    changesAt: null,
    items: [parseMobileTraderItem({ item_id: 300000, currency: 4, price_dollar: 10, limited_count: 0 })],
  });
  assert.deepEqual(src(candidate), []);
});

test('K10 market: only buy-now offers selling this item', () => {
  const candidate = new BuyCatalog();
  candidate.setMarket(300000, [
    anOffer(),
    anOffer({ id: 10, buyNow: null }),
    anOffer({ id: 11, direction: 'BUY' }),
    anOffer({ id: 12, itemId: 205000 }),
  ]);
  assert.deepEqual(
    src(candidate).map((source) => (source as any).offer.id),
    [9],
  );
});

test('K11 a market offer in a town not on the map is left out', () => {
  const candidate = new BuyCatalog();
  candidate.setMarket(300000, [anOffer({ town: { name: 'Nowhere', x: 8, y: 8 } })]);
  assert.deepEqual(src(candidate), []);
});

test('K12 a bought offer is forgotten, and every change bumps the version', () => {
  const candidate = new BuyCatalog();
  candidate.setMarket(300000, [anOffer()]);
  const versionBefore = candidate.version;
  candidate.dropOffer(9);
  assert.deepEqual(src(candidate), []);
  assert.ok(candidate.version > versionBefore);
});

test('K13 the mobile trader is read again after 30 min or once it rotates', () => {
  const candidate = new BuyCatalog();
  assert.equal(candidate.mobileStale(), true, 'never read');
  candidate.setMobile({ items: [], changesAt: Date.now() / 1000 + 600 });
  assert.equal(candidate.mobileStale(), false);
  assert.equal(candidate.mobileStale(Date.now() + 601_000), true, 'rotated');
  candidate.setMobile({ items: [], changesAt: null });
  assert.equal(candidate.mobileStale(Date.now() + 31 * 60_000), true, '30 min');
});

test('K14 a market offer with a $0 buy-now is no source', () => {
  const candidate = new BuyCatalog();
  candidate.setMarket(300000, [anOffer({ buyNow: 0 })]);
  assert.deepEqual(src(candidate), []);
});

// ---- P: planner trips --------------------------------------------------------------------------------------
// Level 32, 50/100 energy, at (0,0), one job J1 at (0,0): 1 h, 12 energy, 100 XP. Budget $1,000.

const currentValue = 1_000_000;
type Pt = { x: number; y: number };
const point = (xCoord: number, yCoord = 0): Pt => ({ x: xCoord, y: yCoord });
const way = (first: Pt, second: Pt) => Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
const J1 = (at = point(0)) => ({
  id: 1,
  groupid: 1,
  name: 'J1',
  jobPoints: 10,
  workPoints: 1,
  motivation: 1,
  danger: null,
  values: { long: { duration: 3600, energy: 12, experience: 100, money: 0, luck: 0, items: [] } },
  at: [at],
});
const trip = (townId: number, xCoord: number, cost = 60, what = [`Jug of water for "Q${townId}"`]) => ({
  townId,
  name: `T${townId}`,
  at: point(xCoord),
  cost,
  what,
});
function plan(
  options: {
    trips?: any[];
    config?: (configCallback: typeof DEFAULT_CONFIG) => void;
    start?: Record<string, unknown>;
    jobs?: any[];
    towns?: any[];
    hotels?: any[];
    homeTownId?: number;
    budget?: number;
    skip?: string[];
    rules?: Partial<typeof EMPTY_RULES>;
  } = {},
) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.modules.quests = true;
  options.config?.(config);
  const jobs = options.jobs ?? [J1()];
  return planAutopilot({
    start: {
      now: currentValue,
      at: point(0),
      energy: 50,
      maxEnergy: 100,
      health: 500,
      maxHealth: 500,
      energyRegen: 0.1,
      healthRegen: 0.1,
      level: 32,
      experience: levelStartXp(32),
      maxLevel: 250,
      cash: 0,
      ...options.start,
    },
    fixed: [],
    jobs,
    locations: (groupId) => jobs.find((jobInfo) => jobInfo.groupid === groupId)?.at,
    wayTime: way,
    config,
    rules: { ...structuredClone(EMPTY_RULES), ...options.rules },
    needs: [],
    itemValue: () => 0,
    hotels: options.hotels ?? [],
    consumables: [],
    homeTownId: options.homeTownId ?? 9,
    towns: options.towns ?? [],
    buyTrips: options.trips,
    budget: options.budget ?? 1000,
    skip: new Set(options.skip ?? []),
    maxJobs: 3,
  });
}
const keys = (pick: ReturnType<typeof plan>, countValue = 6) => pick.tasks.slice(0, countValue).map((task) => task.key);

test('P1 a trip 5 min away goes first: walk, then buy', () => {
  const pick = plan({ trips: [trip(3, 300)] });
  assert.deepEqual(keys(pick, 3), ['walk:3', 'buy:3', 'job:1:long']);
  assert.deepEqual(pick.tasks[1]!.action, { type: 'buy', townId: 3 });
});

test('P2 already in the town: just the buy', () => {
  assert.deepEqual(keys(plan({ trips: [trip(3, 0)] }), 2), ['buy:3', 'job:1:long']);
});

test('P3 a trip one second past the furthest trip (1 h) waits', () => {
  assert.equal(keys(plan({ trips: [trip(3, 3601)] }))[0], 'job:1:long');
});

test('P4 exactly the furthest trip is still made', () => {
  assert.equal(keys(plan({ trips: [trip(3, 3600)] }))[0], 'walk:3');
});

test('P5 two towns: the nearer first, then the other', () => {
  // From 0: T4 at 200 is nearer; from 200, T3 at 500 is 300 away, still within 1 h.
  assert.deepEqual(keys(plan({ trips: [trip(3, 500), trip(4, 200)] }), 4), ['walk:4', 'buy:4', 'walk:3', 'buy:3']);
});

test('P6 a trip dearer than what is left of the daily budget is not planned', () => {
  assert.ok(!plan({ trips: [trip(3, 300, 1200)] }).tasks.some((task) => task.action?.type === 'buy'));
});

test('P7 two $600 trips with $1,000 left: only the nearer one', () => {
  const pick = plan({ trips: [trip(3, 100, 600), trip(4, 200, 600)] });
  assert.deepEqual(
    pick.tasks.filter((task) => task.action?.type === 'buy').map((task) => task.key),
    ['buy:3'],
  );
});

test('P8 a trip that keeps failing (skipped) is not planned', () => {
  assert.equal(keys(plan({ trips: [trip(3, 300)], skip: ['buy:3'] }))[0], 'job:1:long');
});

test('P9 Quests module off: no shopping', () => {
  assert.equal(
    keys(plan({ trips: [trip(3, 300)], config: (configValue) => (configValue.modules.quests = false) }))[0],
    'job:1:long',
  );
});

test("P10 the purchase leaves the timeline's cash lower by its cost", () => {
  const pick = plan({ trips: [trip(3, 300)], start: { cash: 500 } });
  assert.equal(pick.timeline.steps[1]!.cash, 440);
});

test('P11 a pickup costs nothing: no price in the title, cash unchanged', () => {
  const pick = plan({ trips: [trip(3, 300, 0, ['pick up Jug of water (market) for "Q"'])], start: { cash: 500 } });
  assert.equal(pick.tasks[1]!.step.title, 'Buy at T3');
  assert.equal(pick.timeline.steps[1]!.cash, 500);
});

test('P12 banking comes before shopping', () => {
  // $5,000 is over the $4,500 line; home T9 is 100 away, the shop town 300.
  const pick = plan({ trips: [trip(3, 300)], towns: [{ id: 9, name: 'T9', at: point(100) }], start: { cash: 5000 } });
  assert.deepEqual(keys(pick, 4), ['walk:9', 'bank:9', 'walk:3', 'buy:3']);
});

test('P13 bank and shop in the same town: one walk', () => {
  const pick = plan({
    trips: [trip(3, 300)],
    towns: [{ id: 3, name: 'T3', at: point(300) }],
    homeTownId: 3,
    start: { cash: 5000 },
  });
  assert.deepEqual(keys(pick, 3), ['walk:3', 'bank:3', 'buy:3']);
});

test('P14 HP first: a low-HP sleep goes before shopping', () => {
  const hotel = {
    townId: 2,
    name: 'T2',
    at: point(0),
    rooms: [{ key: 'room', name: 'room', cost: 0, energyRate: 0.2, healthRate: 0.5 }],
  };
  const pick = plan({ trips: [trip(3, 300)], hotels: [hotel], start: { health: 200 } });
  assert.equal(pick.tasks[0]!.module, 'hpSleep');
  assert.ok(keys(pick).includes('buy:3'));
});

test('P15 a town out of reach comes into reach after a job: shop then', () => {
  // The job is at 3000; the shop town at 6000 is 6000 from the start, 3000 from the job.
  const pick = plan({ jobs: [J1(point(3000))], trips: [trip(3, 6000)] });
  assert.deepEqual(keys(pick, 3), ['job:1:long', 'walk:3', 'buy:3']);
});

test('P16 each trip once per plan', () => {
  assert.equal(plan({ trips: [trip(3, 0)] }).tasks.filter((task) => task.key === 'buy:3').length, 1);
});

test('P17 the reason lists what is bought for which quest', () => {
  const pick = plan({
    trips: [trip(3, 300, 70, ['2× Jug of water (general store) for "Party"', 'Grey rags (tailor) for "Clothing"'])],
  });
  assert.equal(
    pick.tasks[1]!.why,
    'quest items: 2× Jug of water (general store) for "Party"; Grey rags (tailor) for "Clothing"',
  );
});

test('P18 queuing jobs off: the shopping is still planned', () => {
  assert.deepEqual(keys(plan({ trips: [trip(3, 300)], config: (configValue) => (configValue.modules.jobs = false) })), [
    'walk:3',
    'buy:3',
  ]);
});

test('P19 your inserted sleep at its time comes before shopping', () => {
  const hotel = {
    townId: 2,
    name: 'T2',
    at: point(0),
    rooms: [{ key: 'room', name: 'room', cost: 0, energyRate: 0.5, healthRate: 0.2 }],
  };
  const pick = plan({
    trips: [trip(3, 300)],
    hotels: [hotel],
    rules: { inserts: [{ at: currentValue, kind: 'sleep' }] },
  });
  assert.match(pick.tasks[0]!.key, /^insert:sleep/);
  assert.equal(pick.tasks[1]!.key, 'walk:3');
});

test('P20 the walk is a server task to the town', () => {
  const pick = plan({ trips: [trip(3, 300)] });
  assert.equal(pick.tasks[0]!.step.kind, 'walk');
  assert.deepEqual(pick.tasks[0]!.post, walkPost(3, 'town'));
  assert.equal(pick.tasks[1]!.post, undefined, 'the buy is done on the spot');
});

test('P21 a paid HP sleep uses up the budget first: no money left to shop', () => {
  // Sleep $900 of $1,000; the $200 trip no longer fits.
  const hotel = {
    townId: 2,
    name: 'T2',
    at: point(0),
    rooms: [{ key: 'room', name: 'room', cost: 900, energyRate: 0.2, healthRate: 0.5 }],
  };
  const pick = plan({ trips: [trip(3, 300, 200)], hotels: [hotel], start: { health: 200 } });
  assert.ok(!pick.tasks.some((task) => task.action?.type === 'buy'));
});

test('P22 out of energy does not stop the walk to the shop (walking costs none)', () => {
  assert.equal(keys(plan({ trips: [trip(3, 300)], start: { energy: 2 } }))[0], 'walk:3');
});

// ---- S: GameState -----------------------------------------------------------------------------------------
// You stand at (100,100), travel 1 s per unit. Slobozia (3) is 300 s away, Marketville (5) 300 s, Hilltop (6)
// 1200 s, Far (4) 5000 s (past the 1 h furthest trip).

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
const ITEMS = [
  { id: 1856, name: 'Jug of water', type: 'yield', price: 30 },
  { id: 300, name: 'Grey rags', type: 'body', price: 10 },
  { id: 605, name: 'Quarter Horse', type: 'animal', price: 2800 },
  { id: 603, name: 'White horse', type: 'animal', price: 1250 },
  { id: 787, name: 'Saddle', type: 'yield', price: 80 },
  { id: 2737, name: 'Honey', type: 'yield', price: 135 },
];
const TOWNS = [
  { id: 3, x: 100, y: 400, name: 'Slobozia' },
  { id: 5, x: 400, y: 100, name: 'Marketville' },
  { id: 6, x: 100, y: 1300, name: 'Hilltop' },
  { id: 4, x: 100, y: 5100, name: 'Far' },
].map((target) => ({ ...target, members: 1, npc: false, points: 0 }));
const JUG = 1856;

function makeState(options: { bag?: Record<number, number> } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const bootstrap: any = {
    h: 'abc123',
    game: { sincepoch: now, travelSpeed: 1, currentWorldName: 'Quebec', jobs: [] },
    premium: null,
    bag: [],
    character: {
      playerId: 42,
      name: 'tester',
      level: 30,
      charClass: { type: 'adventurer' },
      experience: 1000,
      cash: 1000,
      deposit: 10,
      nuggets: 0,
      pos: { x: 100, y: 100 },
      town: { id: 3, coords: { x: 100, y: 400 } },
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
  };
  const client = new GameClient({
    worldUrl: WORLD,
    h: bootstrap.h,
    jar: new CookieJar(),
    identity: { userAgent: 'UA', acceptLanguage: 'en' },
    policy: FAST,
  });
  const state = new GameState({ client, bootstrap }, async () => ({ client, bootstrap }));
  state.autopilot = parseAutopilotFile(null);
  state.items = ItemCatalog.fromSlim(ITEMS as any);
  state.inventory.bag.clear();
  for (const [id, countValue] of Object.entries(options.bag ?? {})) {
    state.inventory.applyChanges([
      { item_id: Number(id) * 1000, count: countValue, inv_id: 100 + Number(id), type: 'yield' },
    ]);
  }
  state.world.towns = TOWNS;
  return state;
}
const name = (id: number) => ITEMS.find((index) => index.id === id)!.name;
const has = (id: number, count: number, solved = false) => ({
  solved,
  info: `${name(id)} 0/${count}`,
  itemId: id * 1000,
  count,
  kind: 'item',
});
const wears = (id: number) => ({
  solved: false,
  info: `Equip ${name(id)} 0/1`,
  itemId: id * 1000,
  count: 1,
  kind: 'wear',
});
const bought = (item: string) => ({ solved: false, info: `Item '${item}' bought`, kind: 'bought', buy: item });
const other = (info: string) => ({ solved: false, info, kind: 'other' });
const windowReq = () => ({
  solved: false,
  info: "This quest is only available between 06:00 and 11:00 o'clock.",
  kind: 'window',
  window: { from: '06:00', to: '11:00' },
});
const quest = (id: number, requirements: any[], options: Record<string, unknown> = {}) =>
  ({
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
    ...options,
  }) as any;
const sells = (state: InstanceType<typeof GameState>, townId: number, ids: number[], key = 'general', charge = 1) =>
  state.buyCatalog.setShops(townId, [
    {
      key: key as any,
      townId,
      townName: TOWNS.find((target) => target.id === townId)!.name,
      level: 1,
      charge,
      items: ids.map((index) => index * 1000),
    },
  ]);
const mobileSells = (state: InstanceType<typeof GameState>, id: number, price: number) =>
  state.buyCatalog.setMobile({
    changesAt: null,
    items: [parseMobileTraderItem({ item_id: id * 1000, currency: 4, price_dollar: price })],
  });
const marketSells = (state: InstanceType<typeof GameState>, id: number, price: number, count = 1, offerId = 77) =>
  state.buyCatalog.setMarket(id * 1000, [
    {
      id: offerId,
      itemId: id * 1000,
      count,
      buyNow: price,
      direction: 'SELL',
      town: { name: 'Marketville', x: 400, y: 100 },
    } as any,
  ]);
const trips = (state: InstanceType<typeof GameState>) =>
  state.buyTrips().map((target) => [target.townId, target.cost, target.what]);

test('S1 nothing sells it: blocked, and the blocker says so', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  assert.equal(
    state.questBlocker(state.quests[0]!),
    'Jug of water: no job drops it, and no shop in reach, the mobile trader or the market sells it',
  );
});

test('S2 a shop 5 min away sells it: in scope, one trip for 2 × $30', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  assert.equal(state.questBlocker(state.quests[0]!), null);
  assert.deepEqual(trips(state), [[3, 60, ['2× Jug of water (general store) for "Q1"']]]);
});

test('S3 one already in the bag: buy the one missing', () => {
  const state = makeState({ bag: { [JUG]: 1 } });
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  assert.deepEqual(trips(state), [[3, 30, ['Jug of water (general store) for "Q1"']]]);
});

test('S4 enough in the bag: nothing to buy', () => {
  const state = makeState({ bag: { [JUG]: 2 } });
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  assert.equal(state.questBlocker(state.quests[0]!), null);
  assert.deepEqual(trips(state), []);
});

function withJob(state: InstanceType<typeof GameState>, doable: boolean) {
  state.catalog = new JobCatalog({
    jobs: [{ id: 7, groupid: 1, name: 'Fetch water', yields: { [JUG * 1000]: { prop: 0.3 } } }],
  });
  state.jobs = [
    {
      id: 7,
      groupid: 1,
      name: 'Fetch water',
      jobPoints: doable ? 10 : 0,
      workPoints: 1,
      laborPoints: 9,
      motivation: 1,
      danger: null,
      durations: {},
      luckValue: [0, 0],
      values: { long: { duration: 3600, energy: 12, money: 10, experience: 50, luck: 0, items: [] } },
    } as any,
  ];
  state.world.jobGroups = new Map([[1, [{ x: 110, y: 100 }]]]);
}

test('S5 a doable job drops it: work for it, do not buy', () => {
  const state = makeState();
  withJob(state, true);
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  assert.equal(state.questBlocker(state.quests[0]!), null);
  assert.deepEqual(trips(state), []);
});

test('S6 the job that drops it is not doable yet: buy', () => {
  const state = makeState();
  withJob(state, false);
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  assert.deepEqual(trips(state), [[3, 60, ['2× Jug of water (general store) for "Q1"']]]);
});

test('S7 an item to wear that you lack: bought at the tailor (the wear step does the rest)', () => {
  const state = makeState();
  state.quests = [quest(1, [wears(300)])];
  sells(state, 3, [300], 'tailor');
  assert.deepEqual(trips(state), [[3, 10, ['Grey rags (tailor) for "Q1"']]]);
});

test('S8 an item to wear that is in the bag: nothing to buy', () => {
  const state = makeState({ bag: { 300: 1 } });
  state.quests = [quest(1, [wears(300)])];
  sells(state, 3, [300], 'tailor');
  assert.deepEqual(trips(state), []);
});

test('S9 "Quarter Horse 0/1" and "Equip Quarter Horse": one horse, not two', () => {
  const state = makeState();
  state.quests = [quest(1, [has(605, 1), wears(605)])];
  sells(state, 3, [605]);
  assert.deepEqual(trips(state), [[3, 2800, ['Quarter Horse (general store) for "Q1"']]]);
});

test('S10 "Item \'White horse\' bought" means a purchase, even with one in the bag', () => {
  const state = makeState({ bag: { 603: 1 } });
  state.quests = [quest(1, [bought('White horse')])];
  sells(state, 3, [603]);
  assert.deepEqual(trips(state), [[3, 1250, ['White horse (general store) for "Q1"']]]);
});

test('S11 a "bought" item it does not know: blocked', () => {
  const state = makeState();
  state.quests = [quest(1, [bought('Golden unicorn')])];
  assert.equal(state.questBlocker(state.quests[0]!), "Item 'Golden unicorn' bought: unknown item");
});

test('S12 a quest it cannot finish anyway ("Go to …") buys nothing', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2), other('Go to The Mexican')])];
  sells(state, 3, [JUG]);
  assert.equal(state.questBlocker(state.quests[0]!), 'Go to The Mexican: the autopilot cannot do this');
  assert.deepEqual(trips(state), []);
});

test('S13 a time window does not stop the shopping', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2), windowReq()])];
  sells(state, 3, [JUG]);
  assert.equal(state.questBlocker(state.quests[0]!), null);
  assert.equal(trips(state).length, 1);
});

test('S14 buying off: blocked as before', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  state.autopilot.config.quests.buy = false;
  assert.equal(state.questBlocker(state.quests[0]!), 'Jug of water 0/2: no doable job drops it');
  assert.deepEqual(trips(state), []);
});

test('S15 market off and only the market has it: blocked', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1)])];
  marketSells(state, JUG, 40);
  state.autopilot.config.quests.market = false;
  assert.equal(
    state.questBlocker(state.quests[0]!),
    'Jug of water: no job drops it, and no shop in reach or the mobile trader sells it',
  );
});

test('S16 only a town past the furthest trip sells it: blocked, no trip', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1)])];
  sells(state, 4, [JUG]);
  assert.match(state.questBlocker(state.quests[0]!)!, /no shop in reach/);
  assert.deepEqual(trips(state), []);
});

test('S17 an excluded quest gets no shopping', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  state.autopilot.rules.excludedQuests = [1];
  assert.deepEqual(trips(state), []);
});

test('S18 two quests want 2 jugs each: one stop buys 4', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)]), quest(2, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  assert.deepEqual(trips(state), [
    [3, 120, ['2× Jug of water (general store) for "Q1"', '2× Jug of water (general store) for "Q2"']],
  ]);
});

test('S19 two jugs in the bag go to the first quest; the second buys its own', () => {
  const state = makeState({ bag: { [JUG]: 2 } });
  state.quests = [quest(1, [has(JUG, 2)]), quest(2, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  assert.deepEqual(trips(state), [[3, 60, ['2× Jug of water (general store) for "Q2"']]]);
});

test('S20 three in the bag: 2 for the first, 1 left for the second, which buys 1', () => {
  const state = makeState({ bag: { [JUG]: 3 } });
  state.quests = [quest(1, [has(JUG, 2)]), quest(2, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  assert.deepEqual(trips(state), [[3, 30, ['Jug of water (general store) for "Q2"']]]);
});

test('S21 a solved requirement still counts on its items (they go when it is handed in)', () => {
  // Q1 has its 2 saddles (solved); Q2 needs 1 more, and the bag holds only those 2.
  const state = makeState({ bag: { 787: 2 } });
  state.quests = [quest(1, [has(787, 2, true), has(JUG, 1)]), quest(2, [has(787, 1)])];
  sells(state, 3, [787, JUG]);
  assert.deepEqual(trips(state), [
    [3, 110, ['Jug of water (general store) for "Q1"', 'Saddle (general store) for "Q2"']],
  ]);
});

test('S22 market goods to pick up are a trip even with buying off (already paid)', () => {
  const state = makeState();
  state.autopilot.config.quests.buy = false;
  state.autopilot.pickups = [
    {
      offerId: 77,
      itemId: JUG * 1000,
      count: 2,
      townId: 5,
      townName: 'Marketville',
      at: { x: 400, y: 100 },
      quest: 'Q1',
    },
  ];
  assert.deepEqual(trips(state), [[5, 0, ['pick up 2× Jug of water (market) for "Q1"']]]);
});

test('S23 the quest limit is per quest: two quests may each buy a $2,800 horse', () => {
  const state = makeState();
  state.quests = [quest(1, [has(605, 1)]), quest(2, [has(605, 1)])];
  sells(state, 3, [605]);
  assert.equal(trips(state)[0]![1], 5600);
});

test('S24 repeatable quests are left alone by default', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)], { group: 'Repeatable quests' })];
  sells(state, 3, [JUG]);
  assert.deepEqual(trips(state), []);
});

test('S25 a route limited to other quests: no shopping for this one', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  state.autopilot.rules.onlyQuests = [2];
  assert.deepEqual(trips(state), []);
});

test('S26 where you are decides what is in reach', () => {
  // At Far, Slobozia is 4700 s away and Far's own shop 0.
  const state = makeState();
  state.character.position = { x: 100, y: 5100 };
  state.quests = [quest(1, [has(JUG, 1)])];
  sells(state, 3, [JUG]);
  state.buyCatalog.setShops(4, [
    { key: 'general', townId: 4, townName: 'Far', level: 1, charge: 1, items: [JUG * 1000] },
  ]);
  assert.deepEqual(
    trips(state).map((items) => items[0]),
    [4],
  );
});

test('S27 the mobile trader has it: in scope, no walk to plan', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1)])];
  mobileSells(state, JUG, 40);
  assert.equal(state.questBlocker(state.quests[0]!), null);
  assert.deepEqual(trips(state), []);
});

test('S28 a market offer: bought on the spot, so no trip until it is bought', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1)])];
  marketSells(state, JUG, 40);
  assert.equal(state.questBlocker(state.quests[0]!), null);
  assert.deepEqual(trips(state), []);
});

test('S29 a dearer shop nearby beats a cheap one 20 min away', () => {
  // Slobozia charges 2×: 2 × $60 + 300 s × $0.25 = 195. Hilltop: 2 × $30 + 1200 × 0.25 = 360.
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG], 'general', 2);
  sells(state, 6, [JUG]);
  assert.deepEqual(
    trips(state).map((items) => [items[0], items[1]]),
    [[3, 120]],
  );
});

test('S30 walking worth $0: the cheaper shop, however far', () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG], 'general', 2);
  sells(state, 6, [JUG]);
  state.autopilot.config.quests.walkValue = 0;
  assert.deepEqual(
    trips(state).map((items) => [items[0], items[1]]),
    [[6, 60]],
  );
});

// ---- M: buying (quest module against a fake server) --------------------------------------------------------

interface Call {
  url: string;
  body: string;
}
let calls: Call[];
let routes: Record<string, (body: string) => unknown>;
let realFetch: typeof fetch;
const params = (body: string) => new URLSearchParams(body);
const callTo = (part: string) => calls.filter((candidate) => candidate.url.includes(part));

beforeEach(() => {
  calls = [];
  routes = { '/game.php?window=inventory&action=inventory_changed': () => ({ changes: false, wear: {} }) };
  realFetch = globalThis.fetch;
  resetThrottle();
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body });
    const route = routes[url.replace(WORLD, '').replace(/&h=\w+/, '')];
    return route ? Response.json(route(body)) : new Response(`unexpected ${url}`, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function quests(state: InstanceType<typeof GameState>, options: { budget?: number; skip?: string[] } = {}) {
  const spent: number[] = [];
  const fails: [string, string][] = [];
  const set = new QuestModule({
    state: state,
    get config() {
      return state.autopilot.config;
    },
    budget: () => options.budget ?? 10_000,
    spend: (countValue) => spent.push(countValue),
    skipped: () => new Set(options.skip ?? []),
    fail: (entryKey, msg) => fails.push([entryKey, msg]),
  });
  return { m: set, spent, fails };
}
const inSlobozia = (state: InstanceType<typeof GameState>) => (state.character.position = { x: 100, y: 400 });
const shopRoute = (price: number, start = 1000) => {
  let countValue = 0;
  routes['/game.php?window=building_general&action=buy'] = (body) => {
    countValue++;
    const id = Number(params(body).get('item_id'));
    return {
      changes: [{ item_id: id, count: countValue, inv_id: 500 + countValue, type: 'yield' }],
      money: { barrows: start - price * countValue, deposit: 10 },
    };
  };
};
const settle = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

test("M1 in the shop's town: buys the jugs one by one, bag and cash follow, the spend is counted", async () => {
  const state = makeState();
  inSlobozia(state);
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  shopRoute(30);
  const { m: match, spent, fails } = quests(state);
  assert.equal(await match.buyHere(), true);
  const buys = callTo('building_general&action=buy');
  assert.equal(buys.length, 2);
  assert.deepEqual([params(buys[0]!.body).get('item_id'), params(buys[0]!.body).get('town_id')], ['1856000', '3']);
  assert.equal(state.inventory.countBase(JUG * 1000), 2);
  assert.equal(state.character.cash, 940);
  assert.deepEqual(spent, [60]);
  assert.deepEqual(fails, []);
});

test("M2 not in the shop's town: nothing is bought (the planner walks there)", async () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  const { m: match } = quests(state);
  assert.equal(await match.buyHere(), false);
  assert.equal(calls.length, 0);
});

test('M3 the mobile trader: bought from anywhere, in dollars, then the trader and bag are read again', async () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  mobileSells(state, JUG, 40);
  routes['/game.php?window=shop_trader&action=buy'] = () => ({ cash: 960, deposit: 10, msg: 'ok' });
  const { m: match, spent } = quests(state);
  assert.equal(await match.buyHere(), true);
  const buys = callTo('shop_trader&action=buy');
  assert.equal(buys.length, 2);
  assert.deepEqual(
    ['item_id', 'category', 'currency'].map((entryKey) => params(buys[0]!.body).get(entryKey)),
    ['1856000', 'trader', 'dollar'],
  );
  assert.deepEqual(spent, [80]);
  assert.equal(state.buyCatalog.mobile, null);
  assert.equal(callTo('inventory_changed').length, 1);
});

test('M4 a market offer: bought at its buy-now price with cash, recorded for pickup in its town', async () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 2)])];
  marketSells(state, JUG, 50, 2);
  routes['/game.php?window=building_market&action=bid'] = () => ({
    msg: { instantBuy: true, money: 950, deposit: 10 },
  });
  const { m: match, spent } = quests(state);
  assert.equal(await match.buyHere(), true);
  const bid = params(callTo('building_market&action=bid')[0]!.body);
  assert.deepEqual(
    ['bidtype', 'bid', 'market_offer_id', 'direction'].map((entryKey) => bid.get(entryKey)),
    ['0', '50', '77', 'SELL'],
  );
  assert.deepEqual(state.autopilot.pickups, [
    {
      offerId: 77,
      itemId: JUG * 1000,
      count: 2,
      townId: 5,
      townName: 'Marketville',
      at: { x: 400, y: 100 },
      quest: 'Q1',
    },
  ]);
  assert.deepEqual(spent, [50]);
  assert.equal(state.buyCatalog.market.get(JUG)!.offers.length, 0, 'the offer is gone');
});

test('M5 cash short of the price: paid from the bank', async () => {
  const state = makeState();
  state.character.cash = 20;
  state.quests = [quest(1, [has(JUG, 1)])];
  marketSells(state, JUG, 50);
  routes['/game.php?window=building_market&action=bid'] = () => ({ msg: { instantBuy: true } });
  await quests(state).m.buyHere();
  assert.equal(params(callTo('building_market&action=bid')[0]!.body).get('bidtype'), '1');
});

test('M6 the market took a bid instead of selling: a failure, no pickup, no spend', async () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1)])];
  marketSells(state, JUG, 50);
  routes['/game.php?window=building_market&action=bid'] = () => ({ msg: { instantBuy: false } });
  const { m: match, spent, fails } = quests(state);
  await match.buyHere();
  assert.deepEqual(state.autopilot.pickups, []);
  assert.deepEqual(spent, []);
  assert.equal(fails[0]![0], 'item:1856');
  assert.match(fails[0]![1], /did not sell at its buy-now price/);
});

const pickup = {
  offerId: 77,
  itemId: JUG * 1000,
  count: 2,
  townId: 5,
  townName: 'Marketville',
  at: { x: 400, y: 100 },
  quest: 'Q1',
};

test('M7 in the market town: the goods are picked up and the record dropped', async () => {
  const state = makeState();
  state.character.position = { x: 400, y: 100 };
  state.autopilot.pickups = [pickup];
  routes['/game.php?window=building_market&action=fetch'] = () => ({ msg: { money: 0 } });
  assert.equal(await quests(state).m.buyHere(), true);
  assert.equal(params(callTo('building_market&action=fetch')[0]!.body).get('market_offer_id'), '77');
  assert.deepEqual(state.autopilot.pickups, []);
  assert.ok(state.log.some((line) => /picked up Jug of water at the market in Marketville \(for Q1\)/.test(line.msg)));
});

test('M8 a pickup that fails is left to you, once (no endless walking back)', async () => {
  const state = makeState();
  state.character.position = { x: 400, y: 100 };
  state.autopilot.pickups = [pickup];
  routes['/game.php?window=building_market&action=fetch'] = () => ({ error: true, msg: 'Not here' });
  await quests(state).m.buyHere();
  assert.deepEqual(state.autopilot.pickups, []);
  assert.ok(state.log.some((line) => line.level === 'error' && /Pick it up on the market tab/.test(line.msg)));
});

test("M9 the rest of today's spend cap is short: nothing bought, said once", async () => {
  const state = makeState();
  inSlobozia(state);
  state.quests = [quest(1, [has(JUG, 2)])];
  sells(state, 3, [JUG]);
  const { m: match } = quests(state, { budget: 50 });
  assert.equal(await match.buyHere(), false);
  await match.buyHere();
  assert.equal(callTo('action=buy').length, 0);
  assert.equal(state.log.filter((line) => /over what is left of today's spend cap \(\$50\)/.test(line.msg)).length, 1);
});

test('M10 an item that keeps failing (backing off) is not tried', async () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1)])];
  mobileSells(state, JUG, 40);
  assert.equal(await quests(state, { skip: ['item:1856'] }).m.buyHere(), false);
  assert.equal(calls.length, 0);
});

test('M11 nothing is bought for a quest it cannot finish', async () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1), other('Lose against Billy the blind eagle')])];
  mobileSells(state, JUG, 40);
  assert.equal(await quests(state).m.buyHere(), false);
  assert.equal(calls.length, 0);
});

test('M12 buying off: nothing is bought', async () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1)])];
  mobileSells(state, JUG, 40);
  state.autopilot.config.quests.buy = false;
  assert.equal(await quests(state).m.buyHere(), false);
});

test('M13 one purchase per tick: the jug now, the honey next time', async () => {
  const state = makeState();
  inSlobozia(state);
  state.quests = [quest(1, [has(JUG, 1), has(2737, 1)])];
  sells(state, 3, [JUG, 2737]);
  shopRoute(30);
  const { m: match } = quests(state);
  await match.buyHere();
  assert.deepEqual(
    callTo('action=buy').map((candidate) => params(candidate.body).get('item_id')),
    ['1856000'],
  );
  await settle(); // the runner skips ticks while the quest log refresh holds the busy lock
  await match.buyHere();
  assert.deepEqual(
    callTo('action=buy').map((candidate) => params(candidate.body).get('item_id')),
    ['1856000', '2737000'],
  );
});

test('M14 the shop refuses: a failure under the item key with the reason', async () => {
  const state = makeState();
  inSlobozia(state);
  state.quests = [quest(1, [has(JUG, 1)])];
  sells(state, 3, [JUG]);
  routes['/game.php?window=building_general&action=buy'] = () => ({ error: true, msg: 'Not enough money' });
  const { m: match, fails, spent } = quests(state);
  await match.buyHere();
  assert.deepEqual(fails, [['item:1856', 'buying Jug of water (general store in Slobozia): Not enough money']]);
  assert.deepEqual(spent, []);
});

test('M15 two quests each want a jug: the second buys its own after the first has one', async () => {
  const state = makeState();
  state.quests = [quest(1, [has(JUG, 1)]), quest(2, [has(JUG, 1)])];
  mobileSells(state, JUG, 40);
  let countValue = 0;
  routes['/game.php?window=shop_trader&action=buy'] = () => ({ cash: 1000 - 40 * ++countValue });
  routes['/game.php?window=inventory&action=inventory_changed'] = () => ({
    changes: [{ item_id: JUG * 1000, count: countValue, inv_id: 900 + countValue, type: 'yield' }],
    wear: {},
  });
  const { m: match, spent } = quests(state);
  await match.buyHere();
  await settle();
  mobileSells(state, JUG, 40); // read again after the purchase
  await match.buyHere();
  await settle();
  assert.equal(callTo('shop_trader&action=buy').length, 2);
  assert.deepEqual(spent, [40, 40]);
  mobileSells(state, JUG, 40);
  assert.equal(await match.buyHere(), false, 'both covered now');
});

const rawWindowQuest = {
  id: 9,
  title: 'Afternoon in the saloon',
  accepted: true,
  finishable: false,
  requirements: [
    { solved: false, info: "This quest is only available between 06:00 and 11:00 o'clock.", jsInfo: null },
  ],
};

test('M16 waiting only for the time window: the quest log is re-read, then not again for 10 min', async () => {
  const state = makeState();
  state.quests = [parseQuest(rawWindowQuest)];
  routes['/game.php?window=building_quest&mode=get_open_quests'] = () => ({ quests: [rawWindowQuest], capacity: 20 });
  const { m: match } = quests(state);
  assert.equal(await match.step(), true);
  await settle();
  assert.equal(await match.step(), false);
  assert.equal(callTo('get_open_quests').length, 1);
});

test('M17 items still missing: no re-reading for the window yet', async () => {
  const state = makeState();
  state.quests = [quest(9, [windowReq(), has(JUG, 20)])];
  const { m: match } = quests(state);
  assert.equal(await match.step(), false);
  assert.equal(callTo('get_open_quests').length, 0);
});
