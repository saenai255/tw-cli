// Inventory, skills, quests, hotel, live updates (chat long-poll) and their TUI screens.
// Fixtures: bag_init / items / open_quests are trimmed from the downloaded game.php, items_en_DK.json and
// the captured quest log reply (game-c450166a72a56.php); other replies follow the client JS.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'twcli-feat-'));
process.env.TW_CLI_HOME = home;
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
process.env.TW_ITEMS_FILE = `${FIX}items.sample.json`;

const React = (await import('react')).default;
const { render } = await import('ink');
const { CookieJar } = await import('../src/http/cookie-jar.ts');
const { GameClient } = await import('../src/http/game-client.ts');
const { resetThrottle, throttledFetch } = await import('../src/http/throttle.ts');
const { GameState } = await import('../src/game/state.ts');
const { ItemCatalog, bonusText, slimItem } = await import('../src/game/items.ts');
const { Inventory } = await import('../src/game/inventory.ts');
const { Skills, adjustPlan, emptyPlan, plannedDelta, savePayload } = await import('../src/game/skills.ts');
const { parseQuest, plainText, groupByChain } = await import('../src/game/quests.ts');
const { parseHotel, defaultRoom } = await import('../src/game/hotel.ts');
const { ChatPoller, encodeChatRequest, makeClientId } = await import('../src/realtime/chat.ts');
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

const SKILL_DATA = {
  attributes: { strength: 4, flexibility: 0, dexterity: 0, charisma: 26 },
  attributeBonus: { strength: 14, flexibility: 14, dexterity: 12, charisma: 14 },
  skills: {
    build: 5,
    punch: 5,
    tough: 5,
    endurance: 4,
    health: 7,
    ride: 1,
    reflex: 0,
    dodge: 0,
    hide: 0,
    swim: 0,
    aim: 1,
    shot: 0,
    pitfall: 0,
    finger_dexterity: 0,
    repair: 1,
    leadership: 27,
    tactic: 26,
    trade: 111,
    animal: 27,
    appearance: 27,
  },
  skillBonus: { build: 43, trade: 115 },
  freeAttribute: 1,
  freeSkill: 3,
};

function bootstrap(): any {
  const now = Math.floor(Date.now() / 1000);
  return {
    h: 'abc123',
    player: { h: 'abc123' },
    game: {
      sincepoch: now,
      travelSpeed: 1,
      currentWorldName: 'Quebec',
      jobs: [],
      itemsFile: 'cache/items_en_DK.json?42',
    },
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
      skillData: SKILL_DATA,
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
  return new GameState({ client, bootstrap: second }, async () => ({ client, bootstrap: second }));
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

test('items: base id / upgrade level, names and bonus text', () => {
  const candidate = ItemCatalog.fromRaw(ITEMS);
  assert.equal(candidate.name(110001), 'Rusty rifle ☆1');
  assert.equal(candidate.get(54997000)?.type, 'right_arm');
  const withSkills = ITEMS.find((index: any) => !Array.isArray(index.bonus.skills));
  if (withSkills) {
    assert.match(bonusText(candidate.get(withSkills.item_id)), /^\+\d/);
  }
});

test('item stats: computed like the web popup (upgrade level, per-level rounding, sets)', async () => {
  const { itemStats, calculateItemLevelBonus, upgradedSpeed, speedPercent, mergedStages, setBonusLines } = await import(
    '../src/game/itemstats.ts'
  );
  const candidate = ItemCatalog.fromRaw(ITEMS);
  // ItemManager.calculateItemLevelBonus: ≥1 → round(max(1, v·lvl/10)); <1 → round(max(1, v·1000·lvl))/10000
  assert.equal(calculateItemLevelBonus(1, 22), 2);
  assert.equal(calculateItemLevelBonus(1, 6), 1);
  assert.equal(calculateItemLevelBonus(3, 1), 1);
  assert.equal(calculateItemLevelBonus(2, 0.5), 0.1);
  assert.equal(calculateItemLevelBonus(0, 10), 0);
  // Bowie knife ☆1 at level 30: damage 22-34 → 24-37; +0.19 Appearance per level → ceil(5.7)=6, +1 upgrade = 7
  const knife = itemStats(candidate.get(16000)!, 16001, { charLevel: 30 });
  assert.deepEqual(knife.damage, { min: 24, max: 37 });
  assert.equal(knife.lines[0]!.text, '24-37 Damage');
  assert.ok(
    knife.lines.some((line) => line.text === '+ 7 Appearance'),
    JSON.stringify(knife.lines),
  );
  assert.equal(knife.totals.appearance, 7);
  // Without a character: per-level description as the game writes it
  const plain = itemStats(candidate.get(16000)!, 16000);
  assert.ok(plain.lines.some((line) => line.text === '+0.19 Appearance (per Level)'));
  // Tomahawk: damage per level is folded into the damage range when the character is known
  const tom = itemStats(candidate.get(75000)!, 75000, { charLevel: 20 });
  assert.deepEqual(tom.damage, { min: 16, max: 25 });
  assert.ok(!tom.lines.some((line) => /Damage$/.test(line.text) && line.kind !== 'damage'));
  assert.equal(itemStats(candidate.get(75000)!, 75000).lines[0]!.text, '1-10 Base damage');
  // Fixed attribute + upgrade: The Joker +1 Charisma → ☆2: 1 + max(1, round(0.2)) = 2
  assert.equal(itemStats(candidate.get(2716000)!, 2716002, { charLevel: 10 }).totals.charisma, 2);
  // Speed (Item.parseSpeed) and the popup's percentage
  const bat = candidate.get(54994000)!;
  assert.equal(speedPercent(bat.speed!), 272);
  const upgradedSpeedValue = upgradedSpeed(bat.speed, 1)!;
  assert.ok(upgradedSpeedValue < bat.speed!, 'upgrade makes the horse faster');
  assert.ok(
    itemStats(bat, 54994001, { charLevel: 50 }).lines.some(
      (line) => line.text === `Speed: +${speedPercent(upgradedSpeedValue)}%`,
    ),
  );
  // Set stages merge per bonus and stop at the worn count
  const set = {
    key: 's',
    name: 'S',
    items: [1, 2, 3],
    bonus: {
      2: [
        { type: 'attribute', name: 'strength', value: 1 },
        { type: 'job', job: 'all', value: 10 },
      ],
      3: [
        { type: 'attribute', name: 'strength', value: 2 },
        {
          type: 'character',
          key: 'level',
          roundingMethod: 'ceil',
          bonus: { type: 'skill', name: 'build', value: 0.25 },
        },
      ],
    },
  };
  assert.equal(mergedStages(set, 1).length, 0);
  assert.deepEqual(setBonusLines(set, 2, { charLevel: 10 }), ['+ 1 Strength', '+ 10 labor points']);
  assert.deepEqual(setBonusLines(set, 3, { charLevel: 10 }), ['+ 3 Strength', '+ 3 Construction', '+ 10 labor points']);
});

test('quest route: needs from requirements, greedy plan per energy, unmet reasons', async () => {
  const { questNeeds, planRoute } = await import('../src/game/route.ts');
  const req = (options: any) => ({ solved: false, info: '', ...options });
  const quests: any[] = [
    {
      id: 1,
      title: 'A',
      soloTitle: 'A',
      requirements: [
        req({ itemId: 700000, count: 5, info: 'Ham 0/5' }),
        req({ jobId: 92, count: 4, info: 'Mucking out the stables (0/4)' }),
      ],
    },
    {
      id: 2,
      title: 'B',
      soloTitle: 'B',
      requirements: [
        req({ itemId: 700000, count: 2 }),
        req({ itemId: 999000, count: 1 }),
        req({ jobId: 36, count: 3600, info: 'Trading (30 minutes)' }),
      ],
    },
  ];
  const needs = questNeeds(
    quests,
    (id) => (id === 700000 ? 1 : 0),
    (id) => `item${id}`,
    (id) => `job${id}`,
  );
  const by = Object.fromEntries(needs.map((need) => [need.key, need]));
  assert.equal(by['item:700']?.amount, 6, '5 + 2 needed, 1 in the bag');
  assert.deepEqual([by['job:92:runs']?.amount, by['job:36:seconds']?.amount], [4, 1800]);
  const job = (id: number, groupid: number, items: Record<string, number>, ok = true): any => ({
    id,
    groupid,
    name: `job${id}`,
    jobPoints: ok ? 10 : 0,
    workPoints: 1,
    laborPoints: ok ? 9 : -1,
    durations: {},
    values: {
      short: {
        duration: 15,
        energy: 1,
        money: 1,
        experience: 1,
        luck: 0,
        items: Object.entries(items).map(([text, value]) => ({
          itemId: +text,
          expected: value * 0.02,
          percent: value * 2,
        })),
      },
      long: {
        duration: 3600,
        energy: 12,
        money: 100,
        experience: 50,
        luck: 0,
        items: Object.entries(items).map(([text, value]) => ({
          itemId: +text,
          expected: value * 1.5,
          percent: value * 150,
        })),
      },
    },
  });
  const jobs = [job(10, 1, { 700000: 1 }), job(92, 2, {}), job(36, 3, {}, false), job(11, 4, { 999000: 1 }, false)];
  const locs: Record<number, any[]> = {
    1: [{ x: 10, y: 0 }],
    2: [{ x: 20, y: 0 }],
    3: [{ x: 5, y: 0 }],
    4: [{ x: 1, y: 1 }],
  };
  const plan = planRoute({
    needs,
    jobs,
    locations: (value) => locs[value],
    from: { x: 0, y: 0 },
    wayTime: (position, positionValue) =>
      Math.abs(position.x - positionValue.x) + Math.abs(position.y - positionValue.y),
  });
  const ham = plan.stops.find((source) => source.job.id === 10)!;
  assert.equal(ham.duration, 'long', 'per energy, 1 h runs drop far more per point');
  assert.equal(ham.runs, 4, '6 ham at ~1.5 per run');
  const muck = plan.stops.find((source) => source.job.id === 92)!;
  assert.deepEqual([muck.duration, muck.runs], ['short', 4], 'count-based job requirement: cheapest runs');
  assert.equal(plan.totals.runs, 8);
  assert.deepEqual(plan.unmet.map((value) => value.need.key).sort(), ['item:999', 'job:36:seconds']);
  assert.match(plan.unmet.find((value) => value.need.key === 'item:999')!.why, /labor points/);
  assert.match(plan.unmet.find((value) => value.need.key === 'job:36:seconds')!.why, /labor points/);
  assert.deepEqual(plan.leftover, {});
});

test('inventory: Bag.init, worn slots, and Bag.handleChanges semantics (new totals, 0 removes)', () => {
  const candidate = ItemCatalog.fromRaw(ITEMS);
  const inv = Inventory.fromInit(BAG);
  assert.ok(
    [...inv.wear.keys()].every((key) => key.startsWith('#')),
    'slots unknown before items load',
  );
  inv.retype(candidate);
  assert.equal(inv.wear.get('animal'), 54994000);
  assert.equal(inv.wear.get('left_arm'), 110001);
  const knife = BAG.bag.right_arm[0];
  assert.equal(inv.count(knife.item_id), 1);
  assert.equal(
    inv.lastInvId,
    Math.max(
      ...Object.values<any>(BAG.bag)
        .flat()
        .map((index: any) => index.inv_id),
    ),
  );
  inv.applyChanges([
    { item_id: knife.item_id, count: 0, inv_id: 1, type: 'right_arm' },
    { item_id: 700000, count: 5, inv_id: 99999999, type: 'yield' },
  ]);
  assert.equal(inv.count(knife.item_id), 0);
  assert.equal(inv.count(700000), 5);
  assert.equal(inv.lastInvId, 99999999);
  inv.applyWear({ head: null, neck: 41058000 });
  assert.equal(inv.wear.has('head'), false);
  assert.equal(inv.wear.get('neck'), 41058000);
});

test('skills: planning respects free points; attribute points raise their skills; save payload', () => {
  const source = Skills.fromInit(SKILL_DATA);
  assert.equal(source.total('trade'), 226);
  assert.equal(source.total('charisma'), 40);
  const plan = emptyPlan();
  assert.ok(adjustPlan(plan, source, 'strength', 1));
  assert.equal(adjustPlan(plan, source, 'charisma', 1), false, 'only one free attribute point');
  for (let index = 0; index < 3; index++) {
    assert.ok(adjustPlan(plan, source, 'build', 1));
  }
  assert.equal(adjustPlan(plan, source, 'trade', 1), false);
  assert.equal(plannedDelta(plan, 'build'), 4); // 3 skill + 1 from strength
  assert.equal(plannedDelta(plan, 'punch'), 1);
  assert.equal(plannedDelta(plan, 'trade'), 0);
  const pick = savePayload(plan);
  assert.equal(pick.modifier, 'add');
  assert.deepEqual(JSON.parse(pick.data), {
    attribute_modifications: { strength: 1 },
    skill_modifications: { build: 3 },
    attribute_points_used: 1,
    skill_points_used: 3,
  });
  assert.ok(adjustPlan(plan, source, 'build', -1));
  assert.equal(plan.skills.build, 2);
});

test('quests: captured quest log parses (requirements, rewards, HTML stripped)', () => {
  const qs = QUESTS.quests.map((query: any) => parseQuest(query, (id) => `#${id}`));
  const mike = qs.find((query: any) => query.id === 280)!;
  assert.equal(mike.finishable, true);
  assert.equal(mike.accepted, true);
  assert.deepEqual(mike.requirements, [
    { solved: true, info: 'Trading (30 minutes)', kind: 'job', jobId: 36, count: 3600 },
  ]);
  const kinds = qs.flatMap((query: any) => query.requirements.map((result: any) => result.kind));
  assert.ok(
    kinds.includes('wear') && kinds.includes('item') && kinds.includes('bought'),
    'wear / item / bought told apart',
  );
  const bought = qs.flatMap((query: any) => query.requirements).find((result: any) => result.kind === 'bought');
  assert.equal(bought.buy, 'White horse');
  assert.deepEqual(
    mike.rewards.map((result: any) => result.text),
    ['125 Experience points', '50 Dollars'],
  );
  const horse = qs.find((query: any) => query.id === 3063)!;
  assert.equal(horse.requirements.filter((result: any) => !result.solved).length, 3);
  assert.ok(horse.rewards.some((result: any) => result.item === 722000 && result.text === '#722000'));
  assert.doesNotMatch(horse.description, /<|&hellip;|&nbsp;/);
  assert.equal(plainText('<p>a&nbsp;b</p><p>c</p>'), 'a b\n\nc');
  assert.equal(plainText('<div>Motivation</div><div>82 &#37;</div>', { compact: true }), 'Motivation\n82 %');
  assert.equal(plainText('<table><tr><td>Money</td><td>&#036; 47</td></tr></table>', { compact: true }), 'Money $ 47');
  assert.equal(plainText('Cempas&uacute;chil &amp; co'), 'Cempasúchil & co');
  assert.equal(horse.soloTitle, 'Times of trial');
  const chains = groupByChain(qs);
  assert.deepEqual(
    chains.map((candidate) => [candidate.title, candidate.quests.length, candidate.finishable]),
    [
      ['Angel of love', 1, 1],
      ['Repeatable quests', 1, 0],
      ['The Headless Horseman', 1, 0],
    ],
  );
});

test('hotel: rooms sorted, default room like HotelWindow', () => {
  const hotelInfo = parseHotel(1421, {
    hotel_level: 2,
    town_name: 'Slobozia',
    own_hotel: true,
    waytime: '0:00',
    rooms: {
      bedroom: { name: 'Bedroom', level: 2, available: true, free: false, costs: 5, energy: 40, health: 30 },
      cubby: { name: 'Cubby', level: 1, available: true, free: true, costs: 0, energy: 20, health: 15 },
      hotel_room: { name: 'Hotel room', level: 3, available: false, free: false, costs: 10, energy: 60, health: 50 },
    },
  });
  assert.deepEqual(
    hotelInfo.rooms.map((room) => room.key),
    ['cubby', 'bedroom', 'hotel_room'],
  );
  assert.equal(defaultRoom(hotelInfo)?.key, 'bedroom');
  assert.equal(defaultRoom({ ...hotelInfo, own: false })?.key, 'cubby');
});

test('chat long-poll: request format, Status/UserUpdate → character, invalid sid stops', async () => {
  fakeServer();
  const state = makeState();
  let count = 0;
  routes['/gameservice/chat/'] = (body) => {
    const req: any = JSON.parse(decodeURIComponent(body));
    assert.equal(req.messageid, ++count);
    assert.deepEqual(
      req.batch.map((second: any) => second.op),
      ['nop'],
    );
    assert.equal(req.clid.length, 22);
    if (count === 1) {
      return {
        timenow: Date.now(),
        batch: [
          {
            id: 'Status',
            t: 1,
            payload: {
              sessionHash: 'x',
              clients: [],
              rooms: [],
              self: { id: 'client_42', westid: 42, x: 100, y: 100, level: 30, experience: 1000, money: 50 },
            },
          },
        ],
      };
    }
    if (count === 2) {
      return {
        timenow: Date.now(),
        batch: [
          {
            id: 'UserUpdate',
            t: 3,
            payload: {
              id: 'client_42',
              x: 555,
              y: 666,
              level: 31,
              experience: 1500,
              money: 80,
              deposit: 10,
              energy: 30,
              health: 280,
            },
          },
          { id: 'UserUpdate', t: 2, payload: { id: 'client_7', x: 1, y: 1, money: 1 } },
          { id: 'ReportChanged', t: 4, payload: {} },
        ],
      };
    }
    return { error: 'invalid sid' };
  };
  const poller = new ChatPoller(state.client, { policy: { ...FAST, lane: 'chat' } as any, errorPauseMs: 10 });
  state.live = poller;
  poller.on('self', (value) => state.applySelf(value));
  let invalid = '';
  poller.on('invalid', (text) => (invalid = text));
  assert.equal(await poller.pollOnce(), true);
  assert.equal(poller.myId, 'client_42');
  assert.equal(await poller.pollOnce(), true);
  assert.deepEqual(state.character.position, { x: 555, y: 666 });
  assert.equal(state.character.level, 31);
  assert.equal(state.character.experience, 1500);
  assert.equal(state.character.cash, 80);
  assert.equal(state.character.energy, 30);
  assert.equal(await poller.pollOnce(), false);
  assert.match(invalid, /invalid sid/);
  const call = calls.find((candidate) => candidate.url === `${WORLD}/gameservice/chat/`)!;
  assert.match(call.body, /^%7B%22messageid%22%3A1/);
  assert.equal(encodeChatRequest({ a: 'x\ny' }), encodeURIComponent('{"a":"x\\ny"}'));
  assert.match(
    makeClientId(1793696400339, () => 0.5),
    /^[a-z0-9]{18}0339$/,
  );
});

test('chat lane: a pending long-poll does not block game requests', async () => {
  let release!: () => void;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/gameservice/chat/')) {
      await new Promise<void>((transform) => (release = transform));
      return Response.json({ batch: [] });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  const poll = throttledFetch(`${WORLD}/gameservice/chat/`, { method: 'POST' }, { ...FAST, lane: 'chat' });
  await new Promise((transform) => setTimeout(transform, 20));
  const startedAt = Date.now();
  const game = await throttledFetch(`${WORLD}/game.php?window=task&mode=get_tasks`, { method: 'POST' }, FAST);
  assert.equal(game.status, 200);
  assert.ok(Date.now() - startedAt < 500);
  release();
  await poll;
});

test('state: wear/unwear, skills save, quest accept/finish, sleep send the client requests', async () => {
  fakeServer();
  const state = makeState();
  routes['/game.php?window=skill&mode=overview'] = () => ({
    attributes: SKILL_DATA.attributes,
    skills: SKILL_DATA.skills,
    attributeBonuspoints: {},
    skillBonuspoints: {},
    open_attrPoints: 1,
    open_skillPoints: 3,
  });
  routes['/game.php?window=work&mode=index'] = () => ({ jobs: {} });
  routes['/game.php?window=map&ajax=get_minimap'] = () => ({ towns: {}, job_groups: {} });
  routes['/game.php?window=inventory&action=carry'] = () => ({
    changes: [
      { item_id: 16000, count: 0, inv_id: 1592886, type: 'right_arm' },
      { item_id: 54997000, count: 1, inv_id: 99999999, type: 'right_arm' },
    ],
    speed: 0.8,
    wearSets: {},
    bonus: { allBonuspoints: {} },
  });
  routes['/game.php?window=inventory&action=uncarry'] = () => ({
    changes: [{ item_id: 54994000, count: 1, inv_id: 99999998, type: 'animal' }],
    wearSets: {},
    bonus: { allBonuspoints: {} },
  });
  routes['/game.php?window=inventory&mode=show_equip'] = () => ({
    data: [
      {
        equip_manager_id: 1334,
        name: 'xp',
        head: 54988000,
        body: 54990000,
        foot: 54993000,
        right_arm: 54997000,
        animal: 54994000,
        neck: 54989000,
        yield: null,
        pants: 54981000,
        belt: 11118000,
        left_arm: null,
      },
    ],
    max: 3,
    premium_max: 20,
    hasPremium: false,
    price: 50,
  });
  routes['/game.php?window=inventory&action=switch_equip'] = () => ({
    changes: [],
    speed: 1.1,
    wear: [54988000, 54990000, 54993000, 54997000, 54994000, 54989000, 54981000, 11118000],
    setItems: [54977, 54979, 54982, 54986, 54983, 54978, 54984, 54981, 54980],
    bonus: { allBonuspoints: {} },
  });
  routes['/game.php?window=inventory&action=save_equip'] = () => ({
    error: false,
    data: {
      equip_manager_id: 2000,
      name: 'mine',
      head: 54988000,
      body: 54990000,
      foot: 54993000,
      right_arm: 54997000,
      animal: 54994000,
      neck: 54989000,
      yield: null,
      pants: 54981000,
      belt: 11118000,
      left_arm: null,
    },
  });
  routes['/game.php?window=inventory&action=replace_equip'] = () => ({ error: false });
  routes['/game.php?window=skill&action=save_skill_changes'] = () => ({ error: false, msg: 'Skills changed.' });
  routes['/game.php?window=building_quest&mode=get_open_quests'] = () => QUESTS;
  routes['/game.php?window=quest&action=accept_quest'] = () => ({ error: false, finishable: false });
  routes['/game.php?window=quest&action=finish_quest'] = () => ({
    error: false,
    msg: 'Done',
    allRewards: [{ isItem: false, info: { text: 125, popup_text: 'Experience points' } }],
    eval: 'alert(1)',
  });
  routes['/game.php?window=building_hotel&mode=get_data'] = () => ({
    hotel_level: 1,
    town_name: 'Slobozia',
    own_hotel: true,
    rooms: { cubby: { name: 'Cubby', level: 1, available: true, free: true, energy: 20, health: 10 } },
  });
  routes['/game.php?window=task&action=add'] = () => ({
    tasks: {
      0: {
        task: {
          queue_id: 9,
          type: 'sleep',
          date_start: 1,
          date_done: 2,
          data: { coords: { x: 200, y: 200 }, title: 'Slobozia' },
        },
      },
    },
  });

  await state.loadItems();
  assert.equal(state.inventory.wear.get('animal'), 54994000);
  await state.wear(16000);
  const carry = calls.find((candidate) => candidate.url.includes('action=carry'))!;
  assert.match(carry.url, /h=abc123/);
  assert.equal(
    carry.body,
    `item_id=16000&last_inv_id=${Math.max(
      ...Object.values<any>(BAG.bag)
        .flat()
        .map((index: any) => index.inv_id),
    )}`,
  );
  assert.equal(state.inventory.wear.get('right_arm'), 16000);
  assert.equal(state.inventory.count(16000), 0);
  assert.equal(state.character.speed, 0.8);
  await state.unwear('animal');
  assert.equal(
    calls.find((candidate) => candidate.url.includes('action=uncarry'))!.body,
    'last_inv_id=99999999&type=animal',
  );
  assert.equal(state.inventory.wear.has('animal'), false);

  // Equipment sets: list and switch; the flat wear list is mapped back to slots.
  await state.loadEquipSets();
  assert.deepEqual([state.equipSets!.sets.length, state.equipSets!.sets[0]!.name], [1, 'xp']);
  await state.switchEquipSet(1334);
  assert.deepEqual(
    Object.fromEntries(
      new URLSearchParams(calls.find((candidate) => candidate.url.includes('action=switch_equip'))!.body),
    ),
    { id: '1334', last_inv_id: '99999999' },
  );
  assert.equal(state.inventory.wear.get('head'), 54988000);
  assert.equal(state.inventory.wear.get('belt'), 11118000);
  assert.equal(state.character.speed, 1.1);
  assert.equal(await state.saveEquipSet('mine'), 2000);
  assert.deepEqual(
    Object.fromEntries(
      new URLSearchParams(calls.find((candidate) => candidate.url.includes('action=save_equip'))!.body),
    ),
    { name: 'mine' },
  );
  assert.ok(await state.replaceEquipSet(1334));
  assert.deepEqual(
    Object.fromEntries(
      new URLSearchParams(calls.find((candidate) => candidate.url.includes('action=replace_equip'))!.body),
    ),
    { id: '1334' },
  );

  const plan = emptyPlan();
  adjustPlan(plan, state.skills, 'trade', 1);
  assert.ok(await state.saveSkills(plan));
  const save = calls.find((candidate) => candidate.url.includes('save_skill_changes'))!;
  const form = new URLSearchParams(save.body);
  assert.equal(form.get('modifier'), 'add');
  assert.deepEqual((JSON.parse(form.get('data')!) as any).skill_modifications, { trade: 1 });

  await state.loadQuests();
  const mike = state.quests.find((quest) => quest.id === 280)!;
  await state.finishQuest(mike);
  assert.equal(
    calls.find((candidate) => candidate.url.includes('finish_quest'))!.body,
    'quest_id=280&reward_option_id=',
  );
  assert.ok(state.log.some((line) => /Finished: .*125 Experience points/.test(line.msg)));
  await state.acceptQuest(state.quests.find((quest) => quest.id === 3063)!);
  assert.equal(calls.find((candidate) => candidate.url.includes('accept_quest'))!.body, 'quest_id=3063');

  const hotel = (await state.openHotel(1421))!;
  assert.equal(calls.find((candidate) => candidate.url.includes('building_hotel'))!.body, 'town_id=1421');
  assert.ok(await state.sleep(hotel, hotel.rooms[0]!));
  const add = calls.find((candidate) => candidate.url.includes('task&action=add'))!;
  assert.equal(decodeURIComponent(add.body), 'tasks[0][town_id]=1421&tasks[0][room]=cubby&tasks[0][taskType]=sleep');
  assert.equal(state.queue.at(-1)?.type, 'sleep');

  await state.walkToQuestGiver('indianvillage', "Waupee's Indian village", { x: 28002, y: 16658 });
  const walk = calls.filter((candidate) => candidate.url.includes('task&action=add')).at(-1)!;
  assert.equal(
    decodeURIComponent(walk.body).replace(/\+/g, ' '),
    'tasks[1][unitId]=indianvillage&tasks[1][type]=questgiver&tasks[1][x]=28002&tasks[1][y]=16658&tasks[1][taskType]=walk',
  );
});

test('TUI: character screen (wear, plan + save skills) and quests screen (finish with confirm), hotel overlay', async () => {
  fakeServer();
  const state = makeState();
  routes['/game.php?window=skill&mode=overview'] = () => ({
    attributes: SKILL_DATA.attributes,
    skills: SKILL_DATA.skills,
    attributeBonuspoints: SKILL_DATA.attributeBonus,
    skillBonuspoints: SKILL_DATA.skillBonus,
    open_attrPoints: 1,
    open_skillPoints: 3,
  });
  routes['/game.php?window=work&mode=index'] = () => ({ jobs: {} });
  routes['/game.php?window=map&ajax=get_minimap'] = () => ({ towns: {}, job_groups: {} });
  routes['/game.php?window=inventory&action=carry'] = () => ({
    changes: [],
    wearSets: {},
    bonus: { allBonuspoints: {} },
  });
  routes['/game.php?window=inventory&mode=show_equip'] = () => ({
    data: [
      {
        equip_manager_id: 1334,
        name: 'xp',
        head: 54988000,
        body: 54990000,
        foot: 54993000,
        right_arm: 54997000,
        animal: 54994000,
        neck: 54989000,
        yield: null,
        pants: 54981000,
        belt: 11118000,
        left_arm: null,
      },
    ],
    max: 3,
    premium_max: 20,
    hasPremium: false,
    price: 50,
  });
  routes['/game.php?window=inventory&action=switch_equip'] = () => ({
    changes: [],
    speed: 1,
    wear: [54988000, 54990000, 54993000, 54997000, 54994000, 54989000, 54981000, 11118000],
    setItems: [],
    bonus: { allBonuspoints: {} },
  });
  routes['/game.php?window=inventory&action=save_equip'] = () => ({
    error: false,
    data: { equip_manager_id: 2000, name: 'mine' },
  });
  routes['/game.php?window=inventory&action=replace_equip'] = () => ({ error: false });
  routes['/game.php?window=skill&action=save_skill_changes'] = () => ({ error: false, msg: 'Skills changed.' });
  routes['/game.php?window=building_quest&mode=get_open_quests'] = () => QUESTS;
  routes['/game.php?window=building_quest&mode='] = () => ({
    questEmployer: [{ key: 'barkeeper', name: 'Barkeeper' }],
  });
  routes['/game.php?window=building_quest'] = routes['/game.php?window=building_quest&mode='];
  routes['/game.php?window=quest&action=finish_quest'] = () => ({ error: false, msg: 'Done', allRewards: [] });
  routes['/game.php?window=building_hotel&mode=get_data'] = () => ({
    hotel_level: 1,
    town_name: 'Slobozia',
    own_hotel: true,
    rooms: { cubby: { name: 'Cubby', level: 1, available: true, free: true, energy: 20, health: 10 } },
  });
  routes['/game.php?window=itemuse&action=use_item'] = () => ({
    error: false,
    msg: {
      changes: [{ item_id: 2128000, count: 0, inv_id: 3000001, type: 'yield' }],
      effects: [{ type: 'energy', energy: 70 }],
    },
  });
  await state.loadQuests();
  // A usable, non-wearable item: Enter must offer Use, not Equip.
  state.items = ItemCatalog.fromRaw(ITEMS);
  state.inventory.retype(state.items);
  state.items.add(
    slimItem({
      item_id: 2128000,
      name: 'Coffee',
      type: 'yield',
      usetype: 'single',
      action: true,
      usebonus: ['Energy increase: 25%'],
      level: 0,
      price: 7,
      sell_price: 0,
    }),
  );
  state.inventory.bag.set(2128000, { itemId: 2128000, count: 1, invId: 3000000, type: 'yield' });
  state.inventory.lastInvId = 3000000;

  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { columns: 120, rows: 36, isTTY: true });
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (flag: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (data) => (out += data.toString()));
  const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const settle = (ms = 120) => new Promise((transform) => setTimeout(transform, ms));
  const keys = async (...ks: string[]) => {
    for (const key of ks) {
      stdin.write(key);
      await settle();
    }
  };
  const app = render(React.createElement(App, { state }), {
    stdout: stdout as any,
    stdin: stdin as any,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await settle();
    assert.match(plain(), /1 quest\(s\) to finish/);
    await keys('g', 'i');
    await settle(300);
    assert.match(plain(), /Equipped/);
    assert.match(plain(), /Vampire's bat/);
    // Search the bag for the knife and wear it.
    out = '';
    await keys('/', 'b', 'o', 'w', 'i', 'e', '\r');
    assert.match(plain(), /Bowie knife/);
    await keys('\r');
    assert.equal(calls.filter((candidate) => candidate.url.includes('action=carry')).length, 1);
    // Coffee is usable but not wearable: Enter opens the use form instead of trying to equip it.
    await keys('\x1b', '\x1b', 'g', 'i');
    await settle(200);
    out = '';
    await keys('t', 't', 't', 't', 't', 't'); // type filter: Product (yield)
    assert.match(plain(), /t Product/);
    assert.match(plain(), /Coffee/);
    await keys('\r');
    assert.match(plain(), /Use Coffee/);
    await keys('\r');
    assert.equal(
      new URLSearchParams(calls.find((candidate) => candidate.url.includes('action=use_item'))!.body).get('item_id'),
      '2128000',
    );
    // Sets tab: list the saved set and switch with Enter → y.
    await keys('\x1b[C');
    await settle(200);
    assert.match(plain(), /Equipment sets/);
    assert.match(plain(), /xp/);
    await keys('\r');
    assert.match(plain(), /Switch to xp\? y \/ n/);
    await keys('y');
    await settle(200);
    assert.equal(
      new URLSearchParams(calls.find((candidate) => candidate.url.includes('action=switch_equip'))!.body).get('id'),
      '1334',
    );
    // Save the current wear, then replace the selected set with it.
    await keys('S', 'm', 'i', 'n', 'e', '\r');
    await settle(200);
    assert.equal(
      new URLSearchParams(calls.find((candidate) => candidate.url.includes('action=save_equip'))!.body).get('name'),
      'mine',
    );
    await keys('R');
    assert.match(plain(), /Replace xp with the current wear\? y \/ n/);
    await keys('y');
    await settle(200);
    assert.equal(
      new URLSearchParams(calls.find((candidate) => candidate.url.includes('action=replace_equip'))!.body).get('id'),
      '1334',
    );
    // Skills: plan +1 Trading with '+', save with Enter → y.
    await keys('\x1b[C');
    assert.match(plain(), /Free: .*1 attribute.*3 skill/);
    for (let index = 0; index < 21; index++) {
      stdin.write('j'); // charisma group: row 18, Trading row 21
      await settle(25);
    }
    await keys('+');
    assert.match(plain(), /Trading.*\+1/);
    out = '';
    await keys('?');
    assert.match(plain(), /shortcuts · character/); // ink redraws only changed cells
    await keys('x'); // closes help; the plan survives
    await keys('\r');
    assert.match(plain(), /permanent\. y \/ n/);
    await keys('y');
    await settle(200);
    const save = calls.find((candidate) => candidate.url.includes('save_skill_changes'));
    assert.ok(save, 'skills saved');
    assert.deepEqual((JSON.parse(new URLSearchParams(save.body).get('data')!) as any).skill_modifications, {
      trade: 1,
    });

    // Quests: finishable quest is listed first; Enter → confirm → finish_quest.
    await keys('\x1b');
    await settle(100);
    await keys('g', 'q');
    assert.match(plain(), /Quest log 3\//);
    assert.match(plain(), /Mike and Jenny/);
    assert.match(plain(), /Angel of love\s+1 ✔1/); // chain header with count and ready-to-finish
    assert.match(plain(), /The Headless Horseman\s+1/);
    await keys('\r');
    assert.match(plain(), /Finish "Mike and Jenny/);
    await keys('y');
    await settle(200);
    assert.equal(
      calls.find((candidate) => candidate.url.includes('finish_quest'))!.body,
      'quest_id=280&reward_option_id=',
    );
    await keys('\t');
    await settle(200);
    assert.match(plain(), /Barkeeper \(saloon\)/);

    // Hotel overlay from anywhere: s → rooms → Esc.
    await keys('\x1b', 'g', 's');
    await settle(200);
    assert.match(plain(), /Hotel · Slobozia/);
    assert.match(plain(), /Cubby/);
    await keys('\x1b');
  } finally {
    app.unmount();
    state.stopLive();
  }
});

test('quest item sources: jobs whose yields drop the item, nearest first; g marks them on the map', async () => {
  const state = makeState();
  const { JobCatalog } = await import('../src/game/jobs.ts');
  state.catalog = new JobCatalog({
    jobs: [
      { id: 1, groupid: 12, name: 'Tending pigs', malus: 1, level: 4, yields: { 700000: { prop: 0.45 } }, skills: {} },
      { id: 9, groupid: 3, name: 'Saddler', malus: 5, level: 10, yields: { 1987000: { prop: 0.12 } }, skills: {} },
      { id: 7, groupid: 4, name: 'Leather work', malus: 5, level: 10, yields: { 1987000: { prop: 0.3 } }, skills: {} },
    ],
  });
  state.jobs = [...state.catalog.byId.values()].map((jobInfo) => ({
    ...jobInfo,
    jobPoints: 50,
    workPoints: jobInfo.malus + 1,
    laborPoints: 49,
    motivation: 1,
    valuesMotivation: 1,
    danger: 0,
    luckValue: [0, 0] as [number, number],
    values: {},
  }));
  state.world.jobGroups = new Map([
    [3, [{ x: 150, y: 100 }]],
    [4, [{ x: 5000, y: 100 }]],
    [12, [{ x: 120, y: 100 }]],
  ]);
  assert.deepEqual(
    state.catalog.yielding(1987000).map((yCoord) => yCoord.job.id),
    [7, 9],
  ); // best chance first
  const horse = parseQuest(QUESTS.quests.find((query: any) => query.id === 3063));
  const reins = horse.requirements.find((requirement) => requirement.itemId === 1987000)!;
  assert.equal(reins.count, 2);
  const src = state.requirementSources(reins);
  assert.deepEqual(
    src.map((source) => [source.job.name, source.chance]),
    [
      ['Leather work', 0.3],
      ['Saddler', 0.12],
    ],
  );
  const at = state.highlightQuest(horse);
  assert.deepEqual(at, { x: 150, y: 100 }); // nearest source location from the queue end (100,100)
  assert.deepEqual([...state.mapHighlight!.jobIds].sort(), [7, 9]);
});

test('TUI: loading screen, job filter by product + sort + LP toggle, map layers, quest route + estimates', async () => {
  fakeServer();
  routes['/game.php?window=job&mode=job'] = (body) => {
    const urlValue = new URLSearchParams(body);
    return { id: Number(urlValue.get('jobId')), danger: 37, motivation: 0.55 };
  };
  const state = makeState();
  const { JobCatalog } = await import('../src/game/jobs.ts');
  routes['/game.php?window=building_quest&mode='] = () => ({ questEmployer: [] });
  routes['/game.php?window=building_quest'] = routes['/game.php?window=building_quest&mode='];
  state.items = ItemCatalog.fromRaw(ITEMS);
  state.catalog = new JobCatalog({
    jobs: [
      { id: 1, groupid: 12, name: 'Tending pigs', malus: 1, level: 1, yields: { 700000: { prop: 45 } }, skills: {} },
      { id: 9, groupid: 3, name: 'Saddler', malus: 500, level: 20, yields: { 1987000: { prop: 12 } }, skills: {} },
      { id: 7, groupid: 4, name: 'Leather work', malus: 5, level: 10, yields: { 1987000: { prop: 30 } }, skills: {} },
    ],
  });
  const vals = (
    xp: number,
    money: number,
    luck: number,
    items: { itemId: number; expected: number; percent: number }[],
  ) => ({
    short: {
      duration: 15,
      energy: 1,
      money: 1,
      experience: 1,
      luck: 0,
      items: items.map((index) => ({ ...index, expected: index.expected / 50, percent: index.percent / 50 })),
    },
    long: { duration: 3600, energy: 12, money, experience: xp, luck, items },
  });
  const value: Record<number, any> = {
    1: vals(50, 90, 0.1, [{ itemId: 700000, expected: 2, percent: 200 }]),
    9: vals(500, 900, 0.9, [{ itemId: 1987000, expected: 1, percent: 100 }]),
    7: vals(80, 300, 0.5, [{ itemId: 1987000, expected: 1.5, percent: 150 }]),
  };
  state.jobs = [...state.catalog.byId.values()]
    .map((jobInfo) => ({
      ...jobInfo,
      jobPoints: jobInfo.id === 9 ? 0 : 50,
      workPoints: jobInfo.malus + 1,
      laborPoints: jobInfo.id === 9 ? -500 : 49,
      motivation: 1,
      valuesMotivation: 1,
      danger: 0,
      luckValue: [0, { 1: 400, 9: 20, 7: 250 }[jobInfo.id]!] as [number, number],
      values: value[jobInfo.id],
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
  state.world.jobGroups = new Map([
    [3, [{ x: 150, y: 100 }]],
    [4, [{ x: 400, y: 100 }]],
    [12, [{ x: 120, y: 100 }]],
  ]);
  state.quests = QUESTS.quests.map((query: any) => parseQuest(query, (id: number) => state.itemName(id)));
  state.startup = { steps: [{ label: 'Jobs and map', status: 'running', startedAt: Date.now() }], done: false };
  routes['/game.php?window=reports&action=get_reports'] = () => ({
    count: 1,
    page: 1,
    reports: [
      {
        report_id: 501,
        title: 'Job report: Tending pigs',
        hash: 'h',
        read: false,
        date_received: '10:12',
        popupData: 'You worked 1 hour',
      },
    ],
  });
  // A 1 h job, a quarter done: home shows its progress and the long duration's rewards.
  const now = state.clock.now();
  state.queue = [
    {
      queueId: 5,
      type: 'job',
      start: now - 900,
      end: now + 2700,
      coords: { x: 120, y: 100 },
      title: 'Tending pigs',
      jobId: 1,
      raw: {},
    },
  ];

  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { columns: 130, rows: 40, isTTY: true });
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (flag: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (data) => (out += data.toString()));
  const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const settle = (ms = 120) => new Promise((transform) => setTimeout(transform, ms));
  const keys = async (...ks: string[]) => {
    for (const key of ks) {
      stdin.write(key);
      await settle();
    }
  };
  const app = render(React.createElement(App, { state }), {
    stdout: stdout as any,
    stdin: stdin as any,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await settle();
    assert.match(plain(), /Jobs and map/);
    assert.match(plain(), /Esc skip/);
    await keys('\x1b');
    await settle(200);
    // Starts on home; g j opens the jobs view. Jobs without enough labor points are hidden until `a`.
    assert.match(plain(), /Task queue \d+\/\d+/);
    assert.match(plain(), / 25% {2}45:00 left/);
    assert.match(plain(), /\+50 xp {2}\$90 {2}luck \$0–\$400/);
    assert.match(plain(), /Drops: Ham 200%/);
    assert.match(plain(), /•Job report: Tending pigs/);
    assert.match(plain(), /measuring…/);
    await keys('g', 'j');
    assert.match(plain(), /ends (\w{3} )?[\d:]+(\s?[AP]M)? · \+50 xp \$90/, 'a weekday when it ends after midnight');
    state.queue = [];
    assert.match(plain(), /enough LP only/);
    assert.doesNotMatch(plain(), /Saddler/);
    // Filter by a product name.
    out = '';
    await keys('/', 'h', 'a', 'm', '\r');
    assert.match(plain(), /Tending pigs/);
    assert.match(plain(), /Luck \$0–\$400/);
    assert.match(plain(), /Drops: Ham 200%/);
    await settle(500);
    assert.match(plain(), /motiv 55%/);
    assert.match(plain(), /danger 37%/);
    assert.equal(
      state
        .jobOptions('ham')
        .map((options) => options.job.name)
        .join(),
      'Tending pigs',
    );
    await keys('/', '\x1b');
    await keys('a');
    assert.equal(state.jobOptions('', { showAll: true }).length, 3);
    out = '';
    await keys('S');
    assert.match(plain(), /sort: XP \(S\)/);
    assert.match(plain(), /job +xp +\$ +LP +travel/);
    assert.deepEqual(
      state.jobOptions('', { sort: 'xp', showAll: true }).map((options) => options.job.id),
      [9, 7, 1],
    );
    assert.deepEqual(
      state.jobOptions('', { sort: 'money' }).map((options) => options.job.id),
      [7, 1],
    );
    // Luck sorts by the $ value of a lucky find (maxLuck), not the duration's luck chance.
    assert.deepEqual(
      state.jobOptions('', { sort: 'luck' }).map((options) => options.job.id),
      [1, 7],
    );
    // Map layers.
    out = '';
    await keys('m', 'v');
    assert.match(plain(), /Map layers/);
    await keys('\r');
    assert.equal(state.mapLayers.jobs, false);
    await keys('a');
    assert.equal(state.mapLayers.jobs, true);
    await keys('\x1b', '\x1b'); // layers closed, then back to jobs
    // Quest route: the horse quest needs 2 reins → Leather work (Saddler lacks LP).
    out = '';
    await keys('g', 'q');
    await settle(300);
    assert.match(plain(), /~\d+h/, 'estimate in the quest list');
    out = '';
    await keys('R', '3');
    await settle(200);
    assert.match(plain(), /Route · all quests/);
    assert.match(plain(), /Leather work · 2× 1 h/);
    assert.match(plain(), /item 1990000: no job drops it/);
  } finally {
    app.unmount();
    app.cleanup();
  }
});
