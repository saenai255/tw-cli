// Autopilot scenarios: one situation each, with the result a good player would want, reasoned out by hand
// (the comment says why). They pin down the timeline, the planner (planAutopilot) and the cancel rule.
// Default character: level 32 at the start of the level (3297 XP to 33), 50/100 energy, 10 %/h regen
// (1 energy per 360 s), 500/500 HP, 10 %/h HP regen, $0, at (0,0). Walking: 1 map unit = 1 s.
// A level-up refills energy, so each XP point is worth 100 / 3297 ≈ 0.03 energy back.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCancel, type Plan, planAutopilot } from '../src/game/autopilot.ts';
import { DEFAULT_CONFIG, EMPTY_RULES } from '../src/game/autopilot-config.ts';
import { levelStartXp } from '../src/game/character.ts';
import { projectTimeline, type TimelineStart, type TimelineStep } from '../src/game/timeline.ts';

type Pt = { x: number; y: number };
const point = (xCoord: number, yCoord = 0): Pt => ({ x: xCoord, y: yCoord });
const START_TIME = 1_000_000;
const XP0 = levelStartXp(32);
const GAP = levelStartXp(33) - XP0;
const way = (first: Pt, second: Pt) => Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
const start = (options: Partial<TimelineStart> = {}): TimelineStart => ({
  now: START_TIME,
  at: point(0),
  energy: 50,
  maxEnergy: 100,
  health: 500,
  maxHealth: 500,
  energyRegen: 0.1,
  healthRegen: 0.1,
  level: 32,
  experience: XP0,
  maxLevel: 250,
  cash: 0,
  ...options,
});
const project = (steps: TimelineStep[], options: Partial<TimelineStart> = {}) =>
  projectTimeline(start(options), steps, { wayTime: way });

/** [xp, money, energy?, drops? {itemId: expected per run}] per duration (long 3600 s / middle 600 s / short 15 s). */
type Run = [number, number, number?, Record<number, number>?];
interface JobOpt {
  at?: Pt[] | undefined;
  long?: Run;
  middle?: Run;
  short?: Run;
  danger?: number;
  motivation?: number;
  doable?: boolean;
}
const DUR = { long: [3600, 12], middle: [600, 5], short: [15, 1] } as const;
function job(id: number, options: JobOpt): any {
  const values: Record<string, unknown> = {};
  for (const key of ['long', 'middle', 'short'] as const) {
    const result = options[key];
    if (!result) {
      continue;
    }
    values[key] = {
      duration: DUR[key][0],
      energy: result[2] ?? DUR[key][1],
      experience: result[0],
      money: result[1],
      luck: 0,
      items: Object.entries(result[3] ?? {}).map(([itemId, expected]) => ({
        itemId: Number(itemId),
        expected,
        percent: expected * 100,
      })),
    };
  }
  return {
    id,
    groupid: id,
    name: `J${id}`,
    shortname: `j${id}`,
    level: 0,
    malus: 0,
    skills: {},
    durations: {},
    yields: {},
    jobPoints: options.doable === false ? 0 : 10,
    workPoints: 1,
    laborPoints: 9,
    motivation: options.motivation ?? 1,
    danger: options.danger ?? null,
    luckValue: [0, 0],
    values,
    at: options.at ?? [point(0)],
  };
}
const hotel = (
  townId: number,
  at: Pt,
  rate: number,
  options: { key?: string; cost?: number; healthRate?: number } = {},
) => ({
  townId,
  name: `T${townId}`,
  at,
  rooms: [
    {
      key: options.key ?? 'room',
      name: options.key ?? 'room',
      cost: options.cost ?? 0,
      energyRate: rate,
      healthRate: options.healthRate ?? 0.2,
    },
  ],
});
const town = (id: number, at: Pt) => ({ id, name: `T${id}`, at });
const itemNeed = (itemId: number, amount: number, options: { weight?: number; xpPerUnit?: number } = {}) => ({
  key: `item:${Math.floor(itemId / 1000)}`,
  label: `item ${itemId}`,
  amount,
  unit: 'items' as const,
  itemId,
  quests: ['Q'],
  ...options,
});

interface Scenario {
  start?: Partial<TimelineStart>;
  jobs?: any[];
  specialJobs?: any[];
  fixed?: TimelineStep[];
  hotels?: any[];
  towns?: any[];
  needs?: any[];
  consumables?: any[];
  config?: (configValue: typeof DEFAULT_CONFIG) => void;
  rules?: Partial<typeof EMPTY_RULES>;
  skip?: string[];
  budget?: number;
  homeTownId?: number;
  bankTownId?: number;
  maxJobs?: number;
  itemValue?: (id: number) => number;
}
function plan(source: Scenario): Plan {
  const config = structuredClone(DEFAULT_CONFIG);
  source.config?.(config);
  const jobs = source.jobs ?? [];
  return planAutopilot({
    start: start(source.start),
    fixed: source.fixed ?? [],
    jobs,
    specialJobs: source.specialJobs ?? [],
    locations: (groupId) => jobs.find((jobInfo) => jobInfo.groupid === groupId)?.at,
    wayTime: way,
    config,
    rules: { ...structuredClone(EMPTY_RULES), ...source.rules },
    needs: source.needs ?? [],
    itemValue: source.itemValue ?? (() => 0),
    hotels: source.hotels ?? [],
    consumables: source.consumables ?? [],
    homeTownId: source.homeTownId ?? 9,
    towns: source.towns ?? [],
    bankTownId: source.bankTownId,
    budget: source.budget ?? 1000,
    skip: new Set(source.skip ?? []),
    maxJobs: source.maxJobs ?? 6,
  });
}
const keys = (pick: Plan, count = 6) => pick.tasks.slice(0, count).map((task) => task.key);
const jobStep = (id: number, xp: number, energy = 12, options: Partial<TimelineStep> = {}): TimelineStep =>
  ({
    kind: 'job',
    title: `J${id}`,
    jobId: id,
    at: point(0),
    duration: 3600,
    energy,
    xp,
    money: 0,
    ...options,
  }) as TimelineStep;
const near = (actual: number, expected: number, epsilon = 0.5) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≉ ${expected}`);

// ---- Timeline: what happens to energy, HP, XP and cash -----------------------------------------------------

test('T1 walking regenerates energy at the base rate', () => {
  // 1 h of walking at 10 %/h: +10.
  const target = project([{ kind: 'walk', title: 'w', at: point(3600) }]);
  near(target.final.energy, 60);
  assert.deepEqual(target.final.at, point(3600));
  assert.equal(target.steps[0]!.travel, 3600);
});

test('T2 regen stops at max energy', () => {
  near(project([{ kind: 'walk', title: 'w', at: point(3600) }], { energy: 95 }).final.energy, 100);
});

test('T3 a job pays its energy when it starts and regen runs while working', () => {
  // 50 − 12 + 10 (one hour) = 48.
  const target = project([jobStep(1, 10)]);
  near(target.steps[0]!.energyBefore, 50);
  near(target.final.energy, 48);
});

test('T4 a job waits for the energy it needs', () => {
  // 5 → 12 takes 7 × 360 s; after the job: 0 + 10 regen.
  const target = project([jobStep(1, 10)], { energy: 5 });
  near(target.steps[0]!.waited, 2520);
  near(target.final.energy, 10);
});

test('T5 XP arrives at the end; a level-up refills energy and HP', () => {
  const target = project([jobStep(1, 20)], { experience: XP0 + GAP - 10, energy: 20, health: 300 });
  assert.equal(target.final.level, 33);
  assert.ok(target.steps[0]!.levelUp);
  near(target.final.energy, 100);
  near(target.final.health, 500);
});

test('T6 a level-up raises max HP by healthPerLevel and fills it', () => {
  const target = project([jobStep(1, 20)], { experience: XP0 + GAP - 10, health: 300, healthPerLevel: 10 });
  near(target.final.health, 510);
});

test('T7 one run can cross two levels', () => {
  const target = project([jobStep(1, levelStartXp(34) - XP0)]);
  assert.equal(target.final.level, 34);
});

test('T8 no level-up past the max level (and no refill)', () => {
  const target = project([jobStep(1, 1000)], { level: 250, experience: levelStartXp(250), energy: 20 });
  assert.equal(target.final.level, 250);
  near(target.final.energy, 18);
});

test('T9 a timed sleep regenerates at the room rate', () => {
  const target = project(
    [{ kind: 'sleep', title: 's', at: point(0), energyRate: 0.5, healthRate: 0.2, seconds: 3600 }],
    {
      energy: 0,
    },
  );
  near(target.final.energy, 50);
});

test('T10 an open-ended sleep lasts until energy and HP are both full', () => {
  // Energy 50 → 100 at 50/h: 1 h. HP 400 → 500 at 100/h: 1 h.
  const target = project([{ kind: 'sleep', title: 's', at: point(0), energyRate: 0.5, healthRate: 0.2 }], {
    health: 400,
  });
  near(target.steps[0]!.end - target.steps[0]!.start, 3600);
});

test('T11 a queued (server) job costs no energy here: it was paid when queued', () => {
  const target = project([jobStep(1, 10, 12, { fixed: { start: START_TIME, end: START_TIME + 3600 } } as any)]);
  near(target.final.energy, 60);
});

test('T12 a queued task that started in the past runs from now', () => {
  const target = project([jobStep(1, 10, 12, { fixed: { start: START_TIME - 100, end: START_TIME + 3500 } } as any)]);
  assert.equal(target.steps[0]!.start, START_TIME);
  assert.equal(target.end, START_TIME + 3500);
});

test('T13 a queued walk walks the gap until its server time', () => {
  const target = project([
    { kind: 'walk', title: 'w', at: point(600), fixed: { start: START_TIME + 600, end: START_TIME + 600 } },
  ]);
  assert.equal(target.steps[0]!.travel, 600);
});

test('T14 a deposit empties cash on the spot', () => {
  const target = project([{ kind: 'action', title: 'Deposit', cash: -5000 }], { cash: 5000 });
  assert.equal(target.final.cash, 0);
  assert.equal(target.end, START_TIME);
});

test('T15 HP lost on a run that also levels up comes back with the refill', () => {
  const target = project([jobStep(1, 20, 12, { hpLoss: 100 } as any)], { experience: XP0 + GAP - 10, health: 300 });
  near(target.final.health, 500);
});

test('T16 waiting for energy regenerates HP too', () => {
  // 0 → 12 energy: 4320 s; HP 400 + 60 while waiting, + 50 while working → full.
  const target = project([jobStep(1, 10)], { energy: 0, health: 400 });
  near(target.steps[0]!.waited, 4320);
  near(target.final.health, 500);
});

test('T17 job pay is added to cash at the end', () => {
  assert.equal(project([jobStep(1, 10, 12, { money: 50 } as any)], { cash: 100 }).final.cash, 150);
});

// ---- Choosing jobs --------------------------------------------------------------------------------------------

test('J1 same place and energy: the job with more XP', () => {
  const pick = plan({ jobs: [job(1, { long: [100, 0] }), job(2, { long: [50, 0] })] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('J2 money on top: the job that pays more', () => {
  const pick = plan({
    jobs: [job(1, { long: [100, 10] }), job(2, { long: [10, 200] })],
    config: (configValue) => (configValue.priority = ['money', 'xp', 'quests', 'products']),
  });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test('J3 XP per energy, not per run: 100 XP for 6 energy beats 150 XP for 12', () => {
  const pick = plan({ jobs: [job(1, { long: [150, 0, 12] }), job(2, { long: [100, 0, 6] })] });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test('J4 a 10 % better job 2 h away is not worth the walk', () => {
  // 2 h of walking is ~20 energy of regen: far more than 10 XP.
  const pick = plan({ jobs: [job(1, { long: [100, 0] }), job(2, { long: [110, 0], at: [point(7200)] })] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('J5 a 3× better job 10 min away is worth the walk', () => {
  const pick = plan({ jobs: [job(1, { long: [50, 0] }), job(2, { long: [150, 0], at: [point(600)] })] });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test('J6 a job you cannot do (labor points) is never planned', () => {
  const pick = plan({ jobs: [job(1, { long: [1000, 0], doable: false }), job(2, { long: [10, 0] })] });
  assert.ok(pick.tasks.every((task) => task.key !== 'job:1:long'));
});

test('J7 a job with no place on the map is never planned', () => {
  const pick = plan({ jobs: [job(1, { long: [1000, 0], at: [] }), job(2, { long: [10, 0] })] });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test('J8 an excluded job is never planned', () => {
  const pick = plan({ jobs: [job(1, { long: [1000, 0] }), job(2, { long: [10, 0] })], rules: { excludedJobs: [1] } });
  assert.ok(pick.tasks.every((task) => !task.key.startsWith('job:1:')));
});

test("J9 a failing duration is left out; the job's other durations still count", () => {
  const pick = plan({
    jobs: [job(1, { long: [100, 0], middle: [50, 0] }), job(2, { long: [20, 0] })],
    skip: ['job:1:long'],
  });
  assert.equal(pick.tasks[0]!.key, 'job:1:middle');
});

test('J10 at 54 % HP a run that could cost 50 HP (under 50 %) waits; a safe job goes first', () => {
  const pick = plan({
    start: { health: 270 },
    jobs: [job(1, { long: [300, 0], danger: 100 }), job(2, { long: [100, 0] })],
  });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test('J11 at full HP a dangerous job paying 3× is worth the HP (it regenerates in an hour)', () => {
  const pick = plan({ jobs: [job(1, { long: [300, 0], danger: 100 }), job(2, { long: [100, 0] })] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('J12 per hour with energy to spare: 50 XP in 10 min beats 200 XP in 1 h', () => {
  const pick = plan({
    start: { energyRegen: 1 },
    jobs: [job(1, { long: [200, 0] }), job(2, { middle: [50, 0] })],
    config: (configValue) => {
      configValue.per = 'time';
      configValue.slotCost = 0;
    },
  });
  assert.equal(pick.tasks[0]!.key, 'job:2:middle');
});

test('J13 only a money job: still worth doing with XP on top', () => {
  const pick = plan({ jobs: [job(1, { long: [0, 300] })] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('J14 a job that gives nothing is not planned', () => {
  const pick = plan({ jobs: [job(1, { long: [0, 0] })] });
  assert.equal(pick.tasks.length, 0);
  assert.match(pick.why, /Nothing worth doing/);
});

test('J15 Queue jobs off: no jobs', () => {
  const pick = plan({
    jobs: [job(1, { long: [100, 0] })],
    config: (configValue) => (configValue.modules.jobs = false),
  });
  assert.equal(pick.tasks.length, 0);
  assert.match(pick.why, /Queue jobs is off/);
});

test('J16 products on top: the job dropping a $50 item beats a pure XP job', () => {
  const pick = plan({
    jobs: [job(1, { long: [10, 0, 12, { 800000: 1 }] }), job(2, { long: [100, 0] })],
    itemValue: (id) => (id === 800000 ? 50 : 0),
    config: (configValue) => (configValue.priority = ['products', 'xp', 'money', 'quests']),
  });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test("J17 the nearest of a job's places is used", () => {
  const pick = plan({ jobs: [job(1, { long: [100, 0], at: [point(5000), point(100)] })] });
  assert.deepEqual((pick.tasks[0]!.step as any).at, point(100));
});

test('J18 custom weights (money only) pick the money job', () => {
  const pick = plan({
    jobs: [job(1, { long: [200, 10] }), job(2, { long: [10, 200] })],
    config: (configValue) => (configValue.customWeights = { quests: 0, xp: 0, money: 1, products: 0 }),
  });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test('J19 quests on top with no open quest: the next goal (XP) decides', () => {
  const pick = plan({ jobs: [job(1, { long: [100, 10] }), job(2, { long: [20, 300] })] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

// ---- Short of energy: wait, sleep or an item ------------------------------------------------------------------

const oneJob = [job(1, { long: [100, 0] })];

test('E1 out of energy and no hotel: the job waits for regen', () => {
  const pick = plan({ start: { energy: 0 }, jobs: oneJob });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
  near(pick.timeline.steps[0]!.waited, 4320);
});

test('E2 out of energy with a fast room here: sleep (50/h) rather than regen (10/h)', () => {
  const pick = plan({ start: { energy: 0 }, jobs: oneJob, hotels: [hotel(9, point(0), 0.5)] });
  assert.deepEqual(keys(pick, 2), ['sleep:9:room', 'job:1:long']);
});

test('E3 a room over the daily budget is not used', () => {
  const pick = plan({
    start: { energy: 0 },
    jobs: oneJob,
    hotels: [hotel(9, point(0), 0.5, { cost: 2000 })],
    budget: 1000,
  });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('E4 energy sleeps off: wait', () => {
  const pick = plan({
    start: { energy: 0 },
    jobs: oneJob,
    hotels: [hotel(9, point(0), 0.5)],
    config: (configValue) => (configValue.modules.energySleep = false),
  });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('E5 a failing room is left out; another room is used', () => {
  const item = hotel(9, point(0), 0.5, { key: 'cubby' });
  item.rooms.push({ key: 'lux', name: 'lux', cost: 0, energyRate: 0.3, healthRate: 0.2 });
  const pick = plan({ start: { energy: 0 }, jobs: oneJob, hotels: [item], skip: ['sleep:9:cubby'] });
  assert.equal(pick.tasks[0]!.key, 'sleep:9:lux');
});

test("E6 the own town's hotel within reach beats a slightly faster one elsewhere", () => {
  const pick = plan({
    start: { energy: 0 },
    jobs: oneJob,
    hotels: [hotel(9, point(1000), 0.3), hotel(8, point(500), 0.5)],
  });
  assert.equal(pick.tasks[0]!.key, 'sleep:9:room');
});

const beans = { itemId: 1, name: 'Beans', count: 1, value: 50, effect: { energy: 0.2, health: 0, motivation: 0 } };
const withItems = (configValue: typeof DEFAULT_CONFIG) => (configValue.modules.consumables = true);

test('E7 no hotel, 72 min to wait: an energy item', () => {
  const pick = plan({ start: { energy: 0 }, jobs: oneJob, consumables: [beans], config: withItems });
  assert.deepEqual(keys(pick, 2), ['use:1', 'job:1:long']);
});

test('E8 a hotel close by beats using an item', () => {
  const pick = plan({
    start: { energy: 0 },
    jobs: oneJob,
    consumables: [beans],
    hotels: [hotel(9, point(0), 0.5)],
    config: withItems,
  });
  assert.equal(pick.tasks[0]!.key, 'sleep:9:room');
});

test('E9 only 18 min to wait: no item, wait', () => {
  const pick = plan({ start: { energy: 9 }, jobs: oneJob, consumables: [beans], config: withItems });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('E10 consumables off: wait instead of an item', () => {
  const pick = plan({ start: { energy: 0 }, jobs: oneJob, consumables: [beans] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('E11 an item with none left (all reserved) is not used', () => {
  const pick = plan({ start: { energy: 0 }, jobs: oneJob, consumables: [{ ...beans, count: 0 }], config: withItems });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

const nibble = { itemId: 2, name: 'Nibble', count: 2, value: 50, effect: { energy: 0.1, health: 0, motivation: 0 } };
const coffee = { itemId: 3, name: 'Coffee', count: 2, value: 7, effect: { energy: 0.25, health: 0, motivation: 0 } };
const guarana = { itemId: 4, name: 'Guarana', count: 2, value: 7, effect: { energy: 0.5, health: 0, motivation: 0 } };
const tea = { itemId: 5, name: 'Mate tea', count: 2, value: 7, effect: { energy: 1, health: 0, motivation: 0 } };

test('E12 near a level-up: the smallest item that covers the level need, not the 100 % tea', () => {
  // 200 XP to 33 with 100 XP runs: 2 runs, 24 energy; 3 %/h gives 6 back during the 2 h, so 18 is needed.
  // Coffee (25 %) is the smallest that covers 18; the tea would waste 82 of its 100.
  const pick = plan({
    start: { energy: 0, energyRegen: 0.03, experience: XP0 + GAP - 200 },
    jobs: oneJob,
    consumables: [nibble, coffee, guarana, tea],
    config: withItems,
  });
  assert.equal(pick.tasks[0]!.key, 'use:3');
  assert.match(pick.tasks[0]!.why!, /for level 33/);
  assert.deepEqual(keys(pick, 2), ['use:3', 'job:1:long']);
});

test('E13 near a level-up within an hour of regen: wait instead of using an item', () => {
  // Energy 7 and 2 runs of 12: 20 regen during the runs leaves 4 needed, but the first run waits 5 energy
  // (30 min) and the second 2 (12 min): 42 min to the level-up, so no item and the job waits.
  const pick = plan({
    start: { energy: 7, experience: XP0 + GAP - 200 },
    jobs: oneJob,
    consumables: [coffee, tea],
    config: withItems,
  });
  assert.ok(pick.tasks.every((task) => task.module !== 'consumables'));
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
  near(pick.timeline.steps[0]!.waited, 1800);
  assert.match(pick.tasks[0]!.why!, /level-up in ~42 min: waiting/);
});

test('E14 level out of reach: the smallest item that covers the run, not the tea', () => {
  // 33 runs to 33: no refill caps the need, so only the next run (12) matters. Coffee (25 %) covers it.
  const pick = plan({ start: { energy: 0 }, jobs: oneJob, consumables: [coffee, tea], config: withItems });
  assert.equal(pick.tasks[0]!.key, 'use:3');
});

test('E15 no item covers the level need: the largest goes first, then the plan sizes again', () => {
  // 200 XP to 33 with 100 XP runs of 30 energy, no regen: 60 needed. Coffee (25) cannot start a run;
  // Guarana (50) can and makes the most progress; the shortfall left is 10, so Coffee goes after it.
  const heavy = [job(1, { long: [100, 0, 30] })];
  const pick = plan({
    start: { energy: 0, energyRegen: 0, experience: XP0 + GAP - 200 },
    jobs: heavy,
    consumables: [coffee, guarana],
    config: withItems,
  });
  assert.equal(pick.tasks[0]!.key, 'use:4');
  assert.deepEqual(keys(pick, 4), ['use:4', 'job:1:long', 'use:3', 'job:1:long']);
});

test('E16 near the max, items cap to the same energy: the smallest is used', () => {
  // 95/100, a 100-energy run: every item adds only 5. Nibble (10 %) wastes the least of its bar.
  const pick = plan({
    start: { energy: 95 },
    jobs: [job(1, { long: [100, 0, 100] })],
    consumables: [nibble, coffee, tea],
    config: withItems,
  });
  assert.equal(pick.tasks[0]!.key, 'use:2');
});

test('E17 a 10 % item cannot cover a 12-energy run: the tea is still used', () => {
  const pick = plan({ start: { energy: 0 }, jobs: oneJob, consumables: [nibble, tea], config: withItems });
  assert.equal(pick.tasks[0]!.key, 'use:5');
});

test('E18 waiting for a level-up off: the item is used even when the level is close', () => {
  const pick = plan({
    start: { energy: 7, experience: XP0 + GAP - 200 },
    jobs: oneJob,
    consumables: [coffee],
    config: (configValue) => {
      configValue.modules.consumables = true;
      configValue.consumables.levelUpWait = 0;
    },
  });
  assert.equal(pick.tasks[0]!.key, 'use:3');
});

test('E19 the item must cover the level need, not only the next run', () => {
  // 7 energy, 2 runs of 12 to 33: 5 short for the first run, but 11 short for the level-up (18 external).
  // Nibble (10) covers only the run; Coffee (25) is the smallest that covers the level need.
  const pick = plan({
    start: { energy: 7, energyRegen: 0.03, experience: XP0 + GAP - 200 },
    jobs: oneJob,
    consumables: [nibble, coffee],
    config: withItems,
  });
  assert.equal(pick.tasks[0]!.key, 'use:3');
});

// ---- How long to sleep ----------------------------------------------------------------------------------------

const room = [hotel(9, point(0), 0.5)];

test('W1 the next run levels up by itself: sleep just for its 12 energy', () => {
  const pick = plan({ start: { energy: 0, experience: XP0 + GAP - 50 }, jobs: oneJob, hotels: room });
  assert.equal(pick.tasks[0]!.step.kind, 'sleep');
  assert.equal(pick.tasks[0]!.wake!.energy, 12);
});

test('W2 three runs reach the level: sleep for 36 energy, the level-up refills the rest', () => {
  const pick = plan({ start: { energy: 0, experience: XP0 + GAP - 250 }, jobs: oneJob, hotels: room });
  assert.equal(pick.tasks[0]!.wake!.energy, 36);
  assert.match(pick.tasks[0]!.why!, /enough to level up/);
});

test('W3 the level is out of reach of one refill (33 runs): sleep until full', () => {
  const pick = plan({ start: { energy: 0 }, jobs: oneJob, hotels: room });
  assert.equal(pick.tasks[0]!.wake!.energy, 100);
});

test('W4 "full" on: sleep to 100 even when the level is near', () => {
  const pick = plan({
    start: { energy: 0, experience: XP0 + GAP - 250 },
    jobs: oneJob,
    hotels: room,
    config: (configValue) => (configValue.wake.full = true),
  });
  assert.equal(pick.tasks[0]!.wake!.energy, 100);
});

test('W5 "level up" off: sleep to full', () => {
  const pick = plan({
    start: { energy: 0, experience: XP0 + GAP - 250 },
    jobs: oneJob,
    hotels: room,
    config: (configValue) => (configValue.wake.levelUp = false),
  });
  assert.equal(pick.tasks[0]!.wake!.energy, 100);
});

test('W6 "next stretch" only: 4 runs of 12 = 48', () => {
  const pick = plan({
    start: { energy: 0 },
    jobs: oneJob,
    hotels: room,
    config: (configValue) => {
      configValue.wake.levelUp = false;
      configValue.wake.stretch = true;
    },
  });
  assert.equal(pick.tasks[0]!.wake!.energy, 48);
});

test('W7 "HP safe": an energy sleep at 60 % HP also sleeps HP to 70 %', () => {
  const pick = plan({ start: { energy: 0, health: 300 }, jobs: oneJob, hotels: room });
  assert.equal(pick.tasks[0]!.module, 'energySleep');
  assert.equal(pick.tasks[0]!.wake!.health, 350);
});

test('W8 an HP sleep wakes at 70 % HP', () => {
  const pick = plan({ start: { health: 200 }, jobs: oneJob, hotels: room });
  assert.equal(pick.tasks[0]!.module, 'hpSleep');
  assert.equal(pick.tasks[0]!.wake!.health, 350);
});

test('W9 a hotel 1 h away: the sleep counts the 10 energy regenerated on the way (no oversleeping)', () => {
  // Target 36: arrive with 10, so 26 more at 50/h = 1872 s; waking with 36, not 46.
  const pick = plan({
    start: { energy: 0, experience: XP0 + GAP - 250 },
    jobs: oneJob,
    hotels: [hotel(9, point(3600), 0.5)],
  });
  const index = pick.tasks.findIndex((task) => task.step.kind === 'sleep');
  assert.ok(index >= 0, 'sleeps');
  near(pick.timeline.steps[index]!.energy, 36, 1);
});

test('W10 the run after the sleep levels up although a cheaper XP job could too: its energy, not full', () => {
  const pick = plan({
    start: { energy: 2, experience: XP0 + GAP - 50 },
    hotels: room,
    config: (configValue) => (configValue.priority = ['money', 'xp', 'quests', 'products']),
    jobs: [job(1, { long: [100, 500, 10] }), job(2, { long: [60, 0, 1] })],
  });
  assert.equal(pick.tasks[0]!.wake!.energy, 10);
});

// ---- HP ---------------------------------------------------------------------------------------------------------

test('H1 HP under 50 %: sleep first', () => {
  const pick = plan({ start: { health: 200 }, jobs: oneJob, hotels: room });
  assert.equal(pick.tasks[0]!.module, 'hpSleep');
});

const salve = { itemId: 2, name: 'Salve', count: 1, value: 10, effect: { energy: 0, health: 0.2, motivation: 0 } };

test('H2 HP 48 %: a health item that lifts it over 50 % instead of a sleep', () => {
  const pick = plan({ start: { health: 240 }, jobs: oneJob, hotels: room, consumables: [salve], config: withItems });
  assert.equal(pick.tasks[0]!.key, 'use:2');
  assert.equal(pick.tasks[1]!.key, 'job:1:long');
});

test('H3 a health item too weak to get over 50 %: sleep', () => {
  const pick = plan({
    start: { health: 240 },
    jobs: oneJob,
    hotels: room,
    consumables: [{ ...salve, effect: { energy: 0, health: 0.01, motivation: 0 } }],
    config: withItems,
  });
  assert.equal(pick.tasks[0]!.module, 'hpSleep');
});

test('H4 HP sleeps off: a run that could take HP under 50 % is still skipped', () => {
  // The toggle is about sleeping, not about taking the risk: 260 − 50 = 210 is under the line.
  const pick = plan({
    start: { health: 260 },
    jobs: [job(1, { long: [300, 0], danger: 100 }), job(2, { long: [100, 0] })],
    config: (configValue) => (configValue.modules.hpSleep = false),
  });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test('H5 HP low and no hotel: keep working safe jobs (HP regenerates meanwhile)', () => {
  const pick = plan({ start: { health: 200 }, jobs: oneJob });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('H6 HP low and no hotel: the dangerous job waits, the safe one goes', () => {
  const pick = plan({
    start: { health: 200 },
    jobs: [job(1, { long: [300, 0], danger: 100 }), job(2, { long: [100, 0] })],
  });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

// ---- Bank -------------------------------------------------------------------------------------------------------

const home = [town(9, point(300))];

test('B1 cash over $4,500 and home 5 min away: walk there and deposit first', () => {
  const pick = plan({ start: { cash: 5000 }, jobs: oneJob, towns: home });
  assert.deepEqual(keys(pick, 3), ['walk:9', 'bank:9', 'job:1:long']);
});

test('B2 cash under the limit: no bank', () => {
  assert.equal(plan({ start: { cash: 4000 }, jobs: oneJob, towns: home }).tasks[0]!.key, 'job:1:long');
});

test('B3 cash exactly at the limit: no bank (over means over)', () => {
  assert.equal(plan({ start: { cash: 4500 }, jobs: oneJob, towns: home }).tasks[0]!.key, 'job:1:long');
});

test('B4 bank off: no bank', () => {
  assert.equal(
    plan({
      start: { cash: 5000 },
      jobs: oneJob,
      towns: home,
      config: (configValue) => (configValue.modules.bank = false),
    }).tasks[0]!.key,
    'job:1:long',
  );
});

test('B5 home far away: the nearest town within the detour', () => {
  const pick = plan({ start: { cash: 5000 }, jobs: oneJob, towns: [town(9, point(5000)), town(8, point(1000))] });
  assert.deepEqual(keys(pick, 2), ['walk:8', 'bank:8']);
});

test('B6 no town within the detour and none on the way: no bank this plan', () => {
  const pick = plan({ start: { cash: 5000 }, jobs: oneJob, towns: [town(9, point(5000))] });
  assert.ok(pick.tasks.every((task) => task.module !== 'bank'));
});

test('B7 no town close now, but the next job is next to one: bank after that job', () => {
  const pick = plan({
    start: { cash: 5000 },
    jobs: [job(1, { long: [100, 0], at: [point(4500)] })],
    towns: [town(9, point(5000))],
  });
  assert.deepEqual(keys(pick, 3), ['job:1:long', 'walk:9', 'bank:9']);
});

test('B8 standing in the town: deposit, no walk', () => {
  const pick = plan({ start: { cash: 5000, at: point(300) }, jobs: oneJob, towns: home });
  assert.equal(pick.tasks[0]!.key, 'bank:9');
});

const walkHome: TimelineStep = {
  kind: 'walk',
  title: 'T9',
  at: point(300),
  fixed: { start: START_TIME + 300, end: START_TIME + 300 },
};

test('B9 the queued bank walk ends in town: deposit first even under the limit', () => {
  const pick = plan({ start: { cash: 4000 }, fixed: [walkHome], jobs: oneJob, towns: home, bankTownId: 9 });
  assert.equal(pick.tasks[0]!.key, 'bank:9');
});

test('B10 a remembered bank walk whose queue does not end in town: no forced deposit', () => {
  const pick = plan({ start: { cash: 4000 }, jobs: oneJob, towns: home, bankTownId: 9 });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('B11 cash goes over the limit when a queued job pays: bank after the queue', () => {
  const pick = plan({
    start: { cash: 4000 },
    fixed: [jobStep(1, 10, 12, { money: 600, fixed: { start: START_TIME, end: START_TIME + 3600 } } as any)],
    jobs: oneJob,
    towns: home,
  });
  assert.deepEqual(keys(pick, 2), ['walk:9', 'bank:9']);
});

test('B12 a failing bank town is left out: the next town', () => {
  const pick = plan({ start: { cash: 5000 }, jobs: oneJob, towns: [...home, town(8, point(500))], skip: ['bank:9'] });
  assert.deepEqual(keys(pick, 2), ['walk:8', 'bank:8']);
});

test('B13 HP low and cash high: HP first (safety before money)', () => {
  const pick = plan({ start: { cash: 5000, health: 200 }, jobs: oneJob, towns: home, hotels: room });
  assert.equal(pick.tasks[0]!.module, 'hpSleep');
});

// ---- Quests -----------------------------------------------------------------------------------------------------

const questJob = (drop: number, xp = 10, at?: Pt[]) => job(1, { long: [xp, 0, 12, { 700000: drop }], at });
const xpJob = job(2, { long: [100, 0] });

test('Q1 2 items needed, 1 per run: 2 runs, then XP', () => {
  const pick = plan({ jobs: [questJob(1), xpJob], needs: [itemNeed(700000, 2)] });
  assert.deepEqual(keys(pick, 3), ['job:1:long', 'job:1:long', 'job:2:long']);
});

test('Q2 2 items needed at 0.5 per run: 4 runs', () => {
  const pick = plan({ jobs: [questJob(0.5), xpJob], needs: [itemNeed(700000, 2)] });
  assert.deepEqual(keys(pick, 5), ['job:1:long', 'job:1:long', 'job:1:long', 'job:1:long', 'job:2:long']);
});

test('Q3 "do job 1 three times": 3 runs, then XP', () => {
  const pick = plan({
    jobs: [job(1, { long: [10, 0] }), xpJob],
    needs: [{ key: 'job:1', label: 'J1', amount: 3, unit: 'runs', jobId: 1, quests: ['Q'] }],
  });
  assert.deepEqual(keys(pick, 4), ['job:1:long', 'job:1:long', 'job:1:long', 'job:2:long']);
});

test('Q4 "30 min of job 1": one 1 h run (12 energy) beats three 10 min runs (15)', () => {
  const pick = plan({
    jobs: [job(1, { long: [10, 0], middle: [3, 0] }), xpJob],
    needs: [{ key: 'job:1', label: 'J1', amount: 1800, unit: 'seconds', jobId: 1, quests: ['Q'] }],
  });
  assert.deepEqual(keys(pick, 2), ['job:1:long', 'job:2:long']);
});

test('Q5 the queued run already covers the quest: not planned again', () => {
  const pick = plan({
    fixed: [jobStep(1, 10, 12, { fixed: { start: START_TIME, end: START_TIME + 3600 } } as any)],
    jobs: [job(1, { long: [10, 0] }), xpJob],
    needs: [{ key: 'job:1', label: 'J1', amount: 1, unit: 'runs', jobId: 1, quests: ['Q'] }],
  });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test('Q6 the urgent quest (weight 2) first', () => {
  const pick = plan({
    jobs: [questJob(1), job(3, { long: [10, 0, 12, { 710000: 1 }] })],
    needs: [itemNeed(710000, 1), itemNeed(700000, 1, { weight: 2 })],
  });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('Q7 quests on top: the quest job before a better XP job', () => {
  const pick = plan({ jobs: [questJob(1, 10), job(2, { long: [200, 0] })], needs: [itemNeed(700000, 1)] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('Q8 XP on top, quests second: the much better XP job first', () => {
  const pick = plan({
    jobs: [questJob(1, 10), job(2, { long: [200, 0] })],
    needs: [itemNeed(700000, 1)],
    config: (configValue) => (configValue.priority = ['xp', 'quests', 'money', 'products']),
  });
  assert.equal(pick.tasks[0]!.key, 'job:2:long');
});

test("Q9 XP on top: the quest's XP reward makes the quest job the best XP", () => {
  // 100 XP + 200 XP of quest reward per item beats 150 XP.
  const pick = plan({
    jobs: [questJob(1, 100), job(3, { long: [150, 0] })],
    needs: [itemNeed(700000, 1, { xpPerUnit: 200 })],
    config: (configValue) => (configValue.priority = ['xp', 'quests', 'money', 'products']),
  });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('Q10 quests on top: walk 30 min for the quest job', () => {
  const pick = plan({
    jobs: [questJob(1, 10, [point(1800)]), job(2, { long: [200, 0] })],
    needs: [itemNeed(700000, 1)],
  });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('Q11 a crumb left (0.1 item at 0.5 per run): one run, then XP', () => {
  const pick = plan({ jobs: [questJob(0.5), xpJob], needs: [itemNeed(700000, 0.1)] });
  assert.deepEqual(keys(pick, 2), ['job:1:long', 'job:2:long']);
});

test('Q12 a drop of a better grade of the needed item counts', () => {
  const pick = plan({ jobs: [job(1, { long: [10, 0, 12, { 700001: 1 }] }), xpJob], needs: [itemNeed(700000, 1)] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

// ---- Motivation, inserts, the server queue -----------------------------------------------------------------

test('M1 motivation drops in 25 % steps: three 100 XP runs, then the 95 XP job', () => {
  // Long runs cost 12 %: 100 %, 88 %, 76 % still pay 100 %; the fourth would pay 75 % (under 95).
  const pick = plan({
    jobs: [job(1, { long: [100, 0] }), job(2, { long: [95, 0] })],
  });
  assert.deepEqual(keys(pick, 4), ['job:1:long', 'job:1:long', 'job:1:long', 'job:2:long']);
});

test('M1b the step is not linear: 90 % motivation keeps full pay for two runs', () => {
  // Step: 100, 100, then 75 (below 98). A linear 2 %/run model would pay 97.8 on the first run.
  const pick = plan({
    jobs: [job(1, { long: [100, 0], motivation: 0.9 }), job(2, { long: [98, 0] })],
  });
  assert.deepEqual(keys(pick, 3), ['job:1:long', 'job:1:long', 'job:2:long']);
});

test('M2 the best job is at 50 % motivation and a motivation item is on hand: use it first', () => {
  const pick = plan({
    jobs: [job(1, { long: [100, 0], motivation: 0.5 })],
    consumables: [{ itemId: 5, name: 'Coffee', count: 1, value: 5, effect: { energy: 0, health: 0, motivation: 0.3 } }],
    config: (configValue) => {
      configValue.modules.consumables = true;
      configValue.consumables.motivation = true;
    },
  });
  assert.deepEqual(keys(pick, 2), ['use:5', 'job:1:long']);
});

test('S1 a discovered gold job at 100 s still beats the normal job: real boosted values', () => {
  const normal = job(1, { long: [100, 0] });
  const special = {
    job: normal,
    at: point(100),
    special: 'gold',
    values: {
      long: { duration: 3600, energy: 12, experience: 200, money: 0, luck: 0, items: [] },
    },
    valuesMotivation: 1,
  };
  const pick = plan({ jobs: [normal], specialJobs: [special] });
  assert.equal(pick.tasks[0]!.key, 'job:1:long:gold:100,0');
  assert.equal((pick.tasks[0]!.step as { xp: number }).xp, 200);
  const off = plan({ jobs: [normal] });
  assert.equal(off.tasks[0]!.key, 'job:1:long');
});

test('S2 a special job does not scale its products with motivation', () => {
  const normal = job(1, { long: [0, 0, 12, { 700000: 1 }], motivation: 0.5 });
  const special = {
    job: normal,
    at: point(0),
    special: 'silver',
    values: {
      long: {
        duration: 3600,
        energy: 12,
        experience: 0,
        money: 0,
        luck: 0,
        items: [{ itemId: 700000, expected: 1.5, percent: 150 }],
      },
    },
    valuesMotivation: 0.5,
  };
  const pick = plan({
    jobs: [normal],
    specialJobs: [special],
    needs: [itemNeed(700000, 10)],
  });
  assert.equal(pick.tasks[0]!.key, 'job:1:long:silver:0,0');
  assert.equal((pick.tasks[0]!.step as { xp: number }).xp, 0);
});

test('S3 a silver job at 74 % motivation still beats a full normal job: 150 vs 118 XP', () => {
  const normal = job(1, { long: [118, 0] });
  const special = {
    job: job(2, { long: [200, 0], motivation: 0.74 }),
    at: point(0),
    special: 'silver',
    values: {
      long: { duration: 3600, energy: 12, experience: 150, money: 0, luck: 0, items: [] },
    },
    valuesMotivation: 0.74,
  };
  const pick = plan({ jobs: [normal], specialJobs: [special], maxJobs: 1 });
  assert.equal(pick.tasks[0]!.key, 'job:2:long:silver:0,0');
});

test('S4 at 50 % motivation silver pays 100 XP, under the 118 XP normal job', () => {
  const normal = job(1, { long: [118, 0] });
  const special = {
    job: job(2, { long: [200, 0], motivation: 0.5 }),
    at: point(0),
    special: 'silver',
    values: {
      long: { duration: 3600, energy: 12, experience: 100, money: 0, luck: 0, items: [] },
    },
    valuesMotivation: 0.5,
  };
  const pick = plan({ jobs: [normal], specialJobs: [special], maxJobs: 1 });
  assert.equal(pick.tasks[0]!.key, 'job:1:long');
});

test('S5 same-spot jobs win unless another spot is more than 20 % better', () => {
  const moneyFirst = (configValue: typeof DEFAULT_CONFIG) => {
    configValue.priority = ['money', 'xp', 'quests', 'products'];
  };
  const same = job(1, { long: [0, 100] });
  const slightlyBetter = job(2, { long: [0, 120], at: [point(10)] });
  assert.equal(plan({ jobs: [same, slightlyBetter], maxJobs: 1, config: moneyFirst }).tasks[0]!.key, 'job:1:long');
  const clearlyBetter = job(3, { long: [0, 130], at: [point(10)] });
  assert.equal(plan({ jobs: [same, clearlyBetter], maxJobs: 1, config: moneyFirst }).tasks[0]!.key, 'job:3:long');
});

test('I1 a sleep you inserted now comes first', () => {
  const pick = plan({ jobs: oneJob, hotels: room, rules: { inserts: [{ at: START_TIME, kind: 'sleep' }] } });
  assert.equal(pick.tasks[0]!.step.kind, 'sleep');
  assert.match(pick.tasks[0]!.why!, /you inserted a sleep/);
});

test('I2 a bank stop you inserted happens even under the limit', () => {
  const pick = plan({
    start: { cash: 1000 },
    jobs: oneJob,
    towns: home,
    rules: { inserts: [{ at: START_TIME, kind: 'bank' }] },
  });
  assert.deepEqual(
    pick.tasks.slice(0, 2).map((task) => task.step.kind),
    ['walk', 'action'],
  );
  assert.deepEqual(pick.tasks[1]!.action, { type: 'deposit', townId: 9 });
});

test('I3 a sleep inserted mid-job goes right after that job', () => {
  const pick = plan({ jobs: oneJob, hotels: room, rules: { inserts: [{ at: START_TIME + 1800, kind: 'sleep' }] } });
  assert.deepEqual(
    pick.tasks.slice(0, 2).map((task) => task.step.kind),
    ['job', 'sleep'],
  );
});

test('F1 the plan starts where the queue ends', () => {
  const pick = plan({
    fixed: [
      jobStep(1, 10, 12, { at: point(1000), fixed: { start: START_TIME + 1000, end: START_TIME + 4600 } } as any),
    ],
    jobs: [job(2, { long: [100, 0] })],
  });
  assert.equal(pick.timeline.steps[1]!.travel, 1000);
});

test('F2 the plan runs to the 6 h horizon', () => {
  const pick = plan({ start: { energy: 100 }, jobs: oneJob, maxJobs: 200 });
  const last = pick.timeline.steps.at(-1)!;
  assert.ok(pick.timeline.end >= START_TIME + 6 * 3600 && last.depart < START_TIME + 6 * 3600);
});

test('F3 queued jobs were paid: the first planned job starts with 50 + 10 regen', () => {
  const pick = plan({
    fixed: [jobStep(1, 10, 12, { fixed: { start: START_TIME, end: START_TIME + 3600 } } as any)],
    jobs: oneJob,
  });
  near(pick.timeline.steps[1]!.energyBefore, 60);
});

test('F4 walking in the server queue counts as walking', () => {
  const pick = plan({
    fixed: [{ kind: 'walk', title: 'w', at: point(600), fixed: { start: START_TIME + 600, end: START_TIME + 600 } }],
    jobs: [job(2, { long: [100, 0], at: [point(600)] })],
  });
  near(pick.walk, 600);
});

test('F5 nothing to plan: the queue is still projected', () => {
  const pick = plan({ fixed: [jobStep(1, 10, 12, { fixed: { start: START_TIME, end: START_TIME + 3600 } } as any)] });
  assert.equal(pick.tasks.length, 0);
  assert.equal(pick.timeline.steps.length, 1);
});

// ---- Cancelling the queue -----------------------------------------------------------------------------------

const cancelCfg = DEFAULT_CONFIG.cancel; // margin 20 %, same within 2 %, 10 min less walking
const cut = (from: number, value: number, walk = 0) => ({ from, value, walk });

test('C1 a cut 25 % better: cancel', () => {
  assert.equal(chooseCancel(cut(4, 10), [cut(1, 12.5)], cancelCfg)?.why, 'better');
});

test('C1b exactly 20 % better: keep (the margin is strict)', () => {
  assert.equal(chooseCancel(cut(4, 10), [cut(1, 12)], cancelCfg), null);
});

test('C2 5 % better, same walking: keep (not worth the churn)', () => {
  assert.equal(chooseCancel(cut(4, 10), [cut(1, 10.5)], cancelCfg), null);
});

test('C3 same value, 20 min less walking: cancel', () => {
  const result = chooseCancel(cut(4, 10, 3000), [cut(2, 10, 1800)], cancelCfg);
  assert.equal(result?.why, 'walk');
  assert.equal(result?.from, 2);
});

test('C4 same value, 5 min less walking: keep', () => {
  assert.equal(chooseCancel(cut(4, 10, 3000), [cut(2, 10, 2700)], cancelCfg), null);
});

test('C5 3 % worse even with 30 min less walking: keep', () => {
  assert.equal(chooseCancel(cut(4, 10, 3000), [cut(2, 9.7, 1200)], cancelCfg), null);
});

test('C6 two cuts equally good: cancel less (the later cut)', () => {
  assert.equal(chooseCancel(cut(4, 10), [cut(1, 12.5), cut(2, 12.5)], cancelCfg)?.from, 2);
});

test('C7 the queue is worth nothing and a fresh plan is worth something: cancel', () => {
  assert.equal(chooseCancel(cut(4, 0), [cut(1, 5)], cancelCfg)?.why, 'better');
});

test('C8 a better cut beats a less-walking cut', () => {
  const result = chooseCancel(cut(4, 10, 3000), [cut(1, 12.5, 3000), cut(3, 10, 1000)], cancelCfg);
  assert.equal(result?.from, 1);
  assert.equal(result?.why, 'better');
});
