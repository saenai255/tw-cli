import assert from 'node:assert/strict';
import { test } from 'node:test';
import { levelStartXp } from '../src/game/character.ts';
import { projectTimeline, regenSeconds, type TimelineStart, type TimelineStep } from '../src/game/timeline.ts';

const way = (first: { x: number; y: number }, second: { x: number; y: number }) =>
  Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
// 100 max energy, 10 %/h regen: 1 energy per 360 s.
const start = (options: Partial<TimelineStart> = {}): TimelineStart => ({
  now: 1_000_000,
  at: { x: 0, y: 0 },
  energy: 50,
  maxEnergy: 100,
  health: 400,
  maxHealth: 500,
  energyRegen: 0.1,
  healthRegen: 0.1,
  level: 10,
  experience: levelStartXp(10),
  cash: 0,
  ...options,
});
const job = (options: Partial<Extract<TimelineStep, { kind: 'job' }>> = {}): TimelineStep => ({
  kind: 'job',
  title: 'job',
  jobId: 1,
  at: { x: 0, y: 0 },
  duration: 3600,
  energy: 12,
  xp: 50,
  money: 100,
  ...options,
});

test('regenSeconds: time to regenerate, capped at max, Infinity without regen', () => {
  assert.equal(regenSeconds(50, 60, 100, 0.1), 3600);
  assert.equal(regenSeconds(90, 200, 100, 0.1), 3600, 'capped at max');
  assert.equal(regenSeconds(60, 50, 100, 0.1), 0);
  assert.equal(regenSeconds(0, 1, 100, 0), Infinity);
});

test('timeline: travel, energy paid at start, regen during the job, rewards at the end', () => {
  const tl = projectTimeline(start(), [job({ at: { x: 600, y: 0 } })], { wayTime: way });
  const task = tl.steps[0]!;
  assert.equal(task.travel, 600);
  assert.equal(task.start, 1_000_600);
  assert.equal(task.end, 1_004_200);
  assert.ok(Math.abs(task.energyBefore - (50 + 600 / 360)) < 1e-9, 'regen while walking');
  assert.ok(Math.abs(task.energy - (50 + 4200 / 360 - 12)) < 1e-9, 'cost paid, regen during the job');
  assert.equal(task.cash, 100);
  assert.equal(tl.gained.xp, 50);
  assert.deepEqual(tl.final.at, { x: 600, y: 0 });
});

test('timeline: a planned job waits for energy; a server-queued job costs none', () => {
  const short = projectTimeline(start({ energy: 2 }), [job({ energy: 12 })], { wayTime: way });
  assert.ok(Math.abs(short.steps[0]!.waited - 3600) < 1e-6, '10 energy at 1 per 360 s');
  const fixed = projectTimeline(start({ energy: 2 }), [job({ fixed: { start: 999_000, end: 1_001_800 } })], {
    wayTime: way,
  });
  const task = fixed.steps[0]!;
  assert.equal(task.waited, 0);
  assert.equal(task.start, 1_000_000, 'already running: from now');
  assert.equal(task.end, 1_001_800);
  assert.ok(Math.abs(task.energy - (2 + 5)) < 1e-9, 'no cost, 1800 s of regen');
});

test('timeline: level-up refills energy and health', () => {
  const need = levelStartXp(11) - levelStartXp(10);
  const tl = projectTimeline(
    start({ energy: 30, health: 100 }),
    [
      job({ xp: need - 10, energy: 12, duration: 15 }),
      job({ xp: 20, energy: 12, duration: 15 }),
      job({ xp: 5, energy: 12, duration: 15 }),
    ],
    { wayTime: way },
  );
  const [task, taskInfo, followingStep] = tl.steps;
  assert.equal(task!.levelUp, false);
  assert.equal(taskInfo!.levelUp, true);
  assert.equal(taskInfo!.level, 11);
  assert.equal(taskInfo!.energy, 100);
  assert.equal(taskInfo!.health, 500);
  assert.ok(followingStep!.energy < 100 && followingStep!.energy > 87, 'the next job pays from the refilled energy');
  assert.equal(tl.gained.levels, 1);
});

test('timeline: sleep until full at room rates, or a partial sleep; cost and actions', () => {
  // Room: 50 %/h energy, 20 %/h health. Energy 20 → 100 takes 1.6 h; health 400 → 500 takes 1 h.
  const sleep: TimelineStep = {
    kind: 'sleep',
    title: 'Hotel',
    at: { x: 0, y: 0 },
    energyRate: 0.5,
    healthRate: 0.2,
    cost: 25,
  };
  const full = projectTimeline(start({ energy: 20, cash: 100 }), [sleep], { wayTime: way }).steps[0]!;
  assert.ok(Math.abs(full.end - full.start - 5760) < 1e-6);
  assert.equal(full.energy, 100);
  assert.equal(full.health, 500);
  assert.equal(full.cash, 75);
  const part = projectTimeline(start({ energy: 20 }), [{ ...sleep, seconds: 1800 }], { wayTime: way }).steps[0]!;
  assert.ok(Math.abs(part.energy - 45) < 1e-9, 'wake early: 30 min at 50 %/h');
  const used = projectTimeline(start({ energy: 95 }), [{ kind: 'action', title: 'Coffee', energy: 20, cash: -10 }], {
    wayTime: way,
  });
  assert.equal(used.steps[0]!.energy, 100, 'capped at max');
  assert.equal(used.final.cash, -10);
  assert.equal(used.end, 1_000_000, 'no time passes');
});

test('autopilot file: defaults, merge of saved values, ranking repaired, bad input ignored', async () => {
  const { parseAutopilotFile, DEFAULT_CONFIG, goalWeights, fingerprint, loadAutopilot, saveAutopilot } = await import(
    '../src/game/autopilot-config.ts'
  );
  const empty = parseAutopilotFile(null);
  assert.deepEqual(empty.config, DEFAULT_CONFIG);
  assert.equal(empty.plan, null);
  const autopilotFile = parseAutopilotFile({
    config: {
      running: true,
      priority: ['xp', 'bogus', 'money'],
      hp: { sleepBelow: 0.4, wakeAbove: 'x' },
      modules: { quests: true },
      unknown: 1,
    },
    rules: { excludedJobs: [5] },
    plan: { fingerprint: 'abc', savedAt: 7, tasks: [] },
  });
  assert.equal(autopilotFile.config.running, true);
  assert.deepEqual(autopilotFile.config.priority, ['xp', 'money', 'quests', 'products']);
  assert.deepEqual(autopilotFile.config.hp, { sleepBelow: 0.4, wakeAbove: 0.7 }, 'wrong types keep the default');
  assert.equal(autopilotFile.config.modules.quests, true);
  assert.equal(autopilotFile.config.modules.jobs, true, 'unsaved keys keep the default');
  assert.equal('unknown' in autopilotFile.config, false);
  assert.deepEqual(autopilotFile.rules.excludedJobs, [5]);
  assert.equal(autopilotFile.plan?.fingerprint, 'abc');
  assert.deepEqual(goalWeights(autopilotFile.config), { xp: 1, money: 0.25, quests: 0.06, products: 0.015 });
  assert.deepEqual(goalWeights({ ...autopilotFile.config, customWeights: { xp: 60, money: -1 } }), {
    quests: 0,
    xp: 60,
    money: 0,
    products: 0,
  });
  assert.equal(
    fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] }),
    fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }),
    'key order does not matter',
  );
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tw-ap-'));
  try {
    const file = join(dir, 'sub', 'autopilot.json');
    saveAutopilot(autopilotFile, file);
    assert.deepEqual(loadAutopilot(file), autopilotFile, 'round trip');
    assert.deepEqual(loadAutopilot(join(dir, 'missing.json')).config, DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autopilot screen: toggles, values and ranking change the saved config; queue projection shown', async () => {
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { AutopilotScreen } = await import('../src/tui/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const { CharacterState } = await import('../src/game/character.ts');
  const { ServerClock } = await import('../src/game/clock.ts');
  const clock = new ServerClock();
  const character = CharacterState.fromInit(
    {
      level: 10,
      experience: levelStartXp(10),
      energy: 50,
      maxEnergy: 100,
      health: 100,
      cash: 1234,
      energyRegenFactor: 0.1,
      pos: { x: 0, y: 0 },
    },
    clock,
  );
  const now = clock.now();
  const saved: unknown[] = [];
  const state: any = {
    autopilot: parseAutopilotFile(null),
    clock,
    character,
    travelSpeed: 1,
    logs: [] as string[],
    runner: { plan: null },
    info(message: string) {
      this.logs.push(message);
    },
    updateAutopilot(fn: (value: any) => void) {
      fn(this.autopilot);
      saved.push(structuredClone(this.autopilot.config));
    },
    timeline() {
      return projectTimeline(
        {
          now,
          at: { x: 0, y: 0 },
          energy: 50,
          maxEnergy: 100,
          health: 100,
          maxHealth: 100,
          energyRegen: 0.1,
          healthRegen: 0,
          level: 10,
          experience: levelStartXp(10),
          cash: 0,
        },
        [job({ title: 'Cutting tobacco', xp: 45, fixed: { start: now, end: now + 900 } })],
        { wayTime: way },
      );
    },
  };
  const stdout = new PassThrough() as any;
  Object.assign(stdout, { columns: 120, rows: 40, isTTY: true });
  const stdin = new PassThrough() as any;
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (data: Buffer) => (out += data.toString()));
  const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const settle = (ms = 80) => new Promise((transform) => setTimeout(transform, ms));
  const keys = async (...ks: string[]) => {
    for (const key of ks) {
      stdin.write(key);
      await settle();
    }
  };
  // GameState emits 'change' and the App re-renders; the stub re-renders by hand.
  const el = () =>
    React.createElement(AutopilotScreen, { state, width: 120, height: 38, onCapture: () => {}, onExit: () => {} });
  const app = render(el(), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  try {
    await settle();
    assert.match(plain(), /‖ paused/);
    assert.match(plain(), /1 Quests completed/);
    assert.match(plain(), /Cutting tobacco/);
    assert.match(plain(), /\+45 XP/);
    assert.match(plain(), /In the queue/);
    assert.match(plain(), /Goals {2}Quests › XP › Money › Products/);
    await keys('J'); // quests down one rank
    assert.deepEqual(state.autopilot.config.priority, ['xp', 'quests', 'money', 'products']);
    await keys('j', 'j', 'j', 'j', ' '); // the "Queue jobs" toggle
    assert.equal(state.autopilot.config.modules.jobs, false);
    await keys('R');
    assert.equal(state.autopilot.config.running, true);
    app.rerender(el());
    await settle();
    assert.match(plain(), /● running/);
    // Down to "below" (HP sleep threshold) and raise it by 5 %.
    for (let index = 0; index < 9; index++) {
      await keys('j');
    }
    await keys('+');
    assert.equal(state.autopilot.config.hp.sleepBelow, 0.55);
    await keys('X');
    assert.equal(state.autopilot.config.running, false);
    assert.match(state.logs.at(-1), /stopped/);
    assert.ok(saved.length >= 5, 'every change is saved');
  } finally {
    app.unmount();
  }
});

// ---- planner ----------------------------------------------------------------------------------

const planJob = (
  id: number,
  groupid: number,
  options: { xp: number; money: number; energy?: number; danger?: number; items?: any[] },
): any => ({
  id,
  groupid,
  name: `job${id}`,
  jobPoints: 10,
  workPoints: 1,
  laborPoints: 9,
  motivation: 1,
  danger: options.danger ?? null,
  durations: {},
  values: {
    long: {
      duration: 3600,
      energy: options.energy ?? 12,
      money: options.money,
      experience: options.xp,
      luck: 0,
      items: options.items ?? [],
    },
  },
});

async function planWith(
  transform: {
    start?: Partial<TimelineStart>;
    config?: (candidate: any) => void;
    jobs?: any[];
    hotels?: any[];
    needs?: any[];
    towns?: any[];
    consumables?: any[];
    buyTrips?: any[];
  } = {},
) {
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const autopilotFile = parseAutopilotFile(null);
  transform.config?.(autopilotFile.config);
  const jobs = transform.jobs ?? [planJob(1, 1, { xp: 100, money: 10 }), planJob(2, 2, { xp: 10, money: 200 })];
  const locs: Record<number, any[]> = { 1: [{ x: 100, y: 0 }], 2: [{ x: 200, y: 0 }], 3: [{ x: 50, y: 0 }] };
  return planAutopilot({
    start: start(transform.start),
    fixed: [],
    jobs,
    locations: (value) => locs[value],
    wayTime: way,
    config: autopilotFile.config,
    rules: autopilotFile.rules,
    needs: transform.needs ?? [],
    itemValue: () => 5,
    hotels: transform.hotels ?? [],
    consumables: transform.consumables ?? [],
    homeTownId: 9,
    towns: transform.towns ?? [],
    buyTrips: transform.buyTrips,
    budget: 1000,
    maxJobs: 6,
  });
}

test('planner: the top goal decides the job; per hour vs per energy', async () => {
  const xp = await planWith({ config: (candidate) => (candidate.priority = ['xp', 'money', 'quests', 'products']) });
  assert.equal((xp.tasks[0]!.step as any).jobId, 1);
  assert.match(xp.why, /best XP per energy/);
  const money = await planWith({ config: (candidate) => (candidate.priority = ['money', 'xp', 'quests', 'products']) });
  assert.equal((money.tasks[0]!.step as any).jobId, 2);
  assert.ok(money.value > 0);
  const off = await planWith({ config: (candidate) => (candidate.modules.jobs = false) });
  assert.equal(off.tasks.length, 0);
  assert.match(off.why, /Queue jobs is off/);
});

test("planner: per hour counts the time to regenerate a run's energy (no 15 s runs when energy is short)", async () => {
  const durations = (pct: [number, number, number]) => ({
    short: {
      duration: 15,
      energy: 1,
      money: 25,
      experience: 5,
      luck: 0,
      items: [{ itemId: 700000, expected: pct[0] / 100, percent: pct[0] }],
    },
    middle: {
      duration: 600,
      energy: 5,
      money: 116,
      experience: 23,
      luck: 0,
      items: [{ itemId: 700000, expected: pct[1] / 100, percent: pct[1] }],
    },
    long: {
      duration: 3600,
      energy: 12,
      money: 246,
      experience: 48,
      luck: 0,
      items: [{ itemId: 700000, expected: pct[2] / 100, percent: pct[2] }],
    },
  });
  const jobs = [{ ...planJob(3, 3, { xp: 0, money: 0 }), values: durations([6, 128, 767]) }];
  const needs = [{ key: 'item:700', label: 'Tobacco', amount: 40, unit: 'items', itemId: 700000, quests: ['Q'] }];
  const perHour = (candidate: any) => (candidate.per = 'time');
  // 3 energy an hour (the log that found this): energy is the limit, the long run wins.
  const slow = await planWith({ jobs, needs, config: perHour, start: { energyRegen: 0.03 } });
  assert.equal(slow.tasks[0]!.key, 'job:3:long');
  // A fast hotel room makes energy cheap again: still long (12 energy back in ~11 min of sleep).
  const hotels = [
    {
      townId: 9,
      name: 'Home',
      at: { x: 0, y: 0 },
      rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.64, healthRate: 0.2 }],
    },
  ];
  assert.equal(
    (await planWith({ jobs, needs, hotels, config: perHour, start: { energyRegen: 0.03 } })).tasks[0]!.key,
    'job:3:long',
  );
  // Energy regenerates faster than short runs spend it: per hour, the short run is best (standing at the job).
  const fast = await planWith({
    jobs,
    needs,
    config: (candidate) => {
      perHour(candidate);
      candidate.slotCost = 0;
    },
    start: { energyRegen: 40, at: { x: 50, y: 0 } },
  });
  assert.equal(fast.tasks[0]!.key, 'job:3:short');
});

test('planner: quest needs come first with Quests on top; dangerous jobs are skipped near the HP threshold', async () => {
  const jobs = [
    planJob(1, 1, { xp: 100, money: 10 }),
    planJob(3, 3, { xp: 1, money: 1, items: [{ itemId: 700000, expected: 1, percent: 100 }] }),
  ];
  const needs = [{ key: 'item:700', label: 'Ham', amount: 2, unit: 'items', itemId: 700000, quests: ['Q'] }];
  const pick = await planWith({ jobs, needs });
  assert.deepEqual(
    pick.tasks.slice(0, 2).map((task) => (task.step as any).jobId),
    [3, 3],
    'two runs cover the 2 ham',
  );
  assert.equal((pick.tasks[2]!.step as any).jobId, 1, 'then the next goal (XP)');
  const risky = [planJob(1, 1, { xp: 1000, money: 0, danger: 100 }), planJob(2, 2, { xp: 10, money: 10 })];
  const safe = await planWith({
    jobs: risky,
    start: { health: 270 },
    config: (candidate) => (candidate.priority = ['xp', 'money', 'quests', 'products']),
  });
  assert.equal((safe.tasks[0]!.step as any).jobId, 2, '1000 XP job could take HP (270/500) under 50 %');
});

test('planner: out of energy → sleeps until enough to level up when that beats waiting; HP sleep first', async () => {
  const hotels = [
    {
      townId: 9,
      name: 'Home',
      at: { x: 0, y: 0 },
      rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.5, healthRate: 0.2 }],
    },
  ];
  const gap = levelStartXp(11) - levelStartXp(10);
  const jobs = [planJob(1, 1, { xp: Math.ceil(gap / 3), money: 0, energy: 10 })];
  const pick = await planWith({ jobs, hotels, start: { energy: 0 } });
  const sl = pick.tasks[0]!;
  assert.equal(sl.step.kind, 'sleep');
  assert.equal(sl.module, 'energySleep');
  assert.equal(sl.wake!.energy, 30, '3 runs of 10 energy reach the next level');
  assert.match(sl.why!, /enough to level up/);
  assert.deepEqual(sl.post, { town_id: 9, room: 'cubby', taskType: 'sleep' });
  assert.ok(
    pick.timeline.steps.some((task) => task.levelUp),
    'the level-up is in the projection',
  );
  const hp = await planWith({ jobs, hotels, start: { health: 100 } });
  assert.equal(hp.tasks[0]!.module, 'hpSleep');
  assert.equal(hp.tasks[0]!.wake!.health, 350, 'up at 70 %');
  const noSleep = await planWith({
    jobs,
    hotels,
    start: { energy: 0 },
    config: (candidate) => (candidate.modules.energySleep = false),
  });
  assert.equal(noSleep.tasks[0]!.step.kind, 'job', 'waits for regen instead');
});

test('planner: sleeps only for the next run when that run levels up (not until full)', async () => {
  const hotels = [
    {
      townId: 9,
      name: 'Home',
      at: { x: 0, y: 0 },
      rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.5, healthRate: 0.2 }],
    },
  ];
  // Money first: the 10-energy job runs next; a 1-energy XP job could level up on the 2 energy left, which used
  // to leave no wake reason, so the sleep went to full.
  const jobs = [planJob(1, 1, { xp: 100, money: 500, energy: 10 }), planJob(2, 2, { xp: 60, money: 0, energy: 1 })];
  const pick = await planWith({
    jobs,
    hotels,
    start: { energy: 2, experience: levelStartXp(11) - 50 },
    config: (candidate) => (candidate.priority = ['money', 'xp', 'quests', 'products']),
  });
  const sl = pick.tasks[0]!;
  assert.equal(sl.step.kind, 'sleep');
  assert.equal(sl.wake!.energy, 10);
  assert.match(sl.why!, /enough for job1, which levels up/);
  assert.equal((pick.tasks[1]!.step as any).jobId, 1);
});

test('planner: banks cash over the limit at home when close, not beyond the detour', async () => {
  const towns = [
    { id: 9, name: 'Home', at: { x: 300, y: 0 } },
    { id: 8, name: 'Far', at: { x: 9000, y: 0 } },
  ];
  const pick = await planWith({ towns, start: { cash: 5000 } });
  assert.deepEqual(
    pick.tasks.slice(0, 2).map((task) => task.step.kind),
    ['walk', 'action'],
  );
  assert.deepEqual(pick.tasks[1]!.action, { type: 'deposit', townId: 9 });
  assert.equal(pick.timeline.steps[1]!.cash, 0);
  const far = await planWith({ towns: [towns[1]], start: { cash: 5000 } });
  assert.equal(far.tasks[0]!.step.kind, 'job', 'Far is past the 30 min detour: bank later');
});

test('planner: queued jobs are scored like planned ones; walking inside the horizon is counted', async () => {
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const autopilotFile = parseAutopilotFile(null);
  const jobs = [planJob(1, 1, { xp: 100, money: 10 })];
  const plan = (fixed: TimelineStep[], rates?: any) =>
    planAutopilot({
      start: start({ energy: 100 }),
      fixed,
      jobs,
      locations: () => [{ x: 100, y: 0 }],
      wayTime: way,
      config: autopilotFile.config,
      rules: autopilotFile.rules,
      needs: [],
      itemValue: () => 0,
      hotels: [],
      towns: [],
      budget: 1000,
      maxJobs: 3,
      rates,
    });
  const fresh = plan([]);
  assert.equal(fresh.queuedValue, 0);
  const run: TimelineStep = {
    kind: 'job',
    title: 'job1',
    jobId: 1,
    at: { x: 100, y: 0 },
    duration: 3600,
    energy: 0,
    xp: 100,
    money: 10,
    fixed: { start: 1_000_100, end: 1_003_700 },
  };
  const queued = plan([run], fresh.rates);
  assert.ok(
    Math.abs(queued.queuedValue - fresh.tasks[0]!.value!) < 1e-6,
    'the queued run is worth what planning it is worth',
  );
  // Town at 300: walk there, a job at 100, walk back (the live double trip) walks 400 s more than staying.
  const town: TimelineStep = {
    kind: 'walk',
    title: 'Town',
    at: { x: 300, y: 0 },
    fixed: { start: 1_000_300, end: 1_000_300 },
  };
  const back: TimelineStep = {
    kind: 'walk',
    title: 'Town',
    at: { x: 300, y: 0 },
    fixed: { start: 1_004_300, end: 1_004_300 },
  };
  const trip = plan([town, { ...run, fixed: { start: 1_000_500, end: 1_004_100 } }, back], fresh.rates);
  const stay = plan([town], fresh.rates);
  assert.ok(trip.walk - stay.walk >= 400, `${trip.walk} vs ${stay.walk}`);
});

test('planner: a queued bank walk gets its deposit first even when the cash projection dips under the limit', async () => {
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const autopilotFile = parseAutopilotFile(null);
  const towns = [{ id: 9, name: 'Home', at: { x: 300, y: 0 } }];
  const fixed: TimelineStep[] = [
    {
      kind: 'walk',
      title: 'Home',
      at: { x: 300, y: 0 },
      fixed: { start: 1000, end: 1000 + way({ x: 0, y: 0 }, { x: 300, y: 0 }) },
    },
  ];
  const plan = (bankTownId?: number) =>
    planAutopilot({
      start: start({ cash: 4000 }),
      fixed,
      jobs: [planJob(1, 1, { xp: 100, money: 10 })],
      locations: () => [{ x: 100, y: 0 }],
      wayTime: way,
      config: autopilotFile.config,
      rules: autopilotFile.rules,
      needs: [],
      itemValue: () => 0,
      hotels: [],
      homeTownId: 9,
      towns,
      budget: 1000,
      maxJobs: 3,
      bankTownId,
    });
  // The live bug: $4,000 < $4,500, so a job went in behind the bank walk and a second walk to town followed it.
  assert.equal(plan().tasks[0]!.step.kind, 'job');
  const pick = plan(9);
  assert.deepEqual(pick.tasks[0]!.action, { type: 'deposit', townId: 9 });
  assert.match(pick.tasks[0]!.why!, /queued bank walk/);
  assert.equal(pick.tasks.filter((task) => task.module === 'bank').length, 1, 'no second walk to town');
});

test('consumables: effects parsed from usebonus; energy item when it saves 30+ min, health item instead of a sleep', async () => {
  const { parseConsumable } = await import('../src/game/autopilot.ts');
  assert.deepEqual(parseConsumable(['Energy increase: 15%'], 'single'), { energy: 0.15, health: 0, motivation: 0 });
  assert.deepEqual(parseConsumable(['Health point bonus: 10%', 'Energy increase: 10%'], 'single'), {
    energy: 0.1,
    health: 0.1,
    motivation: 0,
  });
  assert.deepEqual(parseConsumable(['Work motivation increase: 15%'], 'single'), {
    energy: 0,
    health: 0,
    motivation: 0.15,
  });
  assert.equal(parseConsumable(['+15 Vigor', 'Uses: 5'], 'buff'), null, 'buffs are not consumables here');
  assert.equal(parseConsumable(['Active waytime shortening: 25%'], 'single'), null);

  const coffee = {
    itemId: 1,
    name: 'Gingerbread',
    count: 1,
    value: 31,
    effect: { energy: 0.15, health: 0, motivation: 0 },
  };
  const cookie = {
    itemId: 2,
    name: 'Chocolate cookie',
    count: 3,
    value: 29,
    effect: { energy: 0, health: 0.2, motivation: 0 },
  };
  const on = (candidate: any) => (candidate.modules.consumables = true);
  const pick = await planWith({ start: { energy: 0 }, consumables: [coffee], config: on });
  assert.equal(pick.tasks[0]!.module, 'consumables');
  assert.deepEqual(pick.tasks[0]!.action, { type: 'use', itemId: 1 });
  assert.equal(pick.tasks[1]!.step.kind, 'job', 'the 15 energy pays the next run');
  assert.equal(pick.tasks.filter((task) => task.module === 'consumables').length, 1, 'only what is above the reserve');
  const off = await planWith({ start: { energy: 0 }, consumables: [coffee] });
  assert.equal(off.tasks[0]!.step.kind, 'job', 'module off: waits for regen');
  const close = await planWith({ start: { energy: 9 }, consumables: [coffee], config: on });
  assert.equal(close.tasks[0]!.step.kind, 'job', '3 energy short regenerates in 18 min: not worth an item');
  const hotels = [
    {
      townId: 9,
      name: 'Home',
      at: { x: 0, y: 0 },
      rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.5, healthRate: 0.2 }],
    },
  ];
  const hp = await planWith({ start: { health: 200 }, consumables: [cookie], hotels, config: on });
  assert.deepEqual(hp.tasks[0]!.action, { type: 'use', itemId: 2 }, '200 + 100 lifts HP over 50 % of 500');
  const low = await planWith({ start: { health: 100 }, consumables: [cookie], hotels, config: on });
  assert.equal(low.tasks[0]!.step.kind, 'sleep', '100 + 100 is still under 50 %: sleep');
  const near = await planWith({ start: { energy: 0 }, consumables: [coffee], hotels, config: on });
  assert.equal(near.tasks[0]!.step.kind, 'sleep', 'a hotel within the own-town distance beats an energy item');
  const farHotels = [{ ...hotels[0], at: { x: 1e6, y: 0 } }];
  const far = await planWith({ start: { energy: 0 }, consumables: [coffee], hotels: farHotels, config: on });
  assert.deepEqual(far.tasks[0]!.action, { type: 'use', itemId: 1 }, 'hotel past the own-town distance: the item');
});

test('planner: plans to the 6 h horizon (jobs of any length cover the same time); inserted sleep goes in at its time', async () => {
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const autopilotFile = parseAutopilotFile(null);
  const hotels = [
    {
      townId: 9,
      name: 'Home',
      at: { x: 0, y: 0 },
      rooms: [{ key: 'cubby', name: 'Cubby', cost: 0, energyRate: 0.5, healthRate: 0.2 }],
    },
  ];
  const input = (rules = autopilotFile.rules) => ({
    start: start({ energy: 100 }),
    fixed: [],
    jobs: [planJob(1, 1, { xp: 100, money: 10, energy: 5 })],
    locations: () => [{ x: 10, y: 0 }],
    wayTime: way,
    config: autopilotFile.config,
    rules,
    needs: [],
    itemValue: () => 0,
    hotels,
    towns: [],
    budget: 1000,
  });
  const pick = planAutopilot(input());
  assert.equal(pick.tasks.filter((task) => task.step.kind === 'job').length, 6, 'six one-hour jobs reach the horizon');
  assert.ok(pick.timeline.end - start().now >= 6 * 3600);
  assert.ok(pick.rates.xp > 0, 'the plan carries its exchange rates');
  const at = start().now + 2 * 3600;
  const ins = planAutopilot(input({ ...autopilotFile.rules, inserts: [{ at, kind: 'sleep' }] }));
  const index = ins.tasks.findIndex((task) => task.key === `insert:sleep:${at}`);
  assert.equal(index, 2, 'after the two jobs that end by then');
  assert.equal(ins.tasks[index]!.step.kind, 'sleep');
});

test('queue view (Q): queued + planned rows; d excludes a planned job, s inserts a sleep, c cancels a queued task', async () => {
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { AutopilotScreen } = await import('../src/tui/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const { ServerClock } = await import('../src/game/clock.ts');
  const clock = new ServerClock();
  const now = clock.now();
  const st = start({ now });
  const steps = [
    job({ title: 'Queued job', fixed: { start: now, end: now + 600 } }),
    job({ title: 'Planned job', jobId: 5 }),
  ];
  const timeline = projectTimeline(st, steps, { wayTime: way });
  const cancelled: number[] = [];
  const state: any = {
    autopilot: parseAutopilotFile(null),
    clock,
    character: { cash: 0 },
    logs: [] as string[],
    runner: {
      plan: {
        tasks: [{ module: 'jobs', key: 'job:5:long', step: steps[1], why: 'best xp' }],
        timeline,
        why: 'best xp',
        value: 1,
      },
    },
    info(message: string) {
      this.logs.push(message);
    },
    updateAutopilot(fn: (value: any) => void) {
      fn(this.autopilot);
    },
    timeline: () => timeline,
    cancel: async (index: number) => void cancelled.push(index),
  };
  const stdout = new PassThrough() as any;
  Object.assign(stdout, { columns: 140, rows: 30, isTTY: true });
  const stdin = new PassThrough() as any;
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = '';
  stdout.on('data', (data: Buffer) => (out += data.toString()));
  const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const settle = (ms = 80) => new Promise((transform) => setTimeout(transform, ms));
  const keys = async (...ks: string[]) => {
    for (const key of ks) {
      stdin.write(key);
      await settle();
    }
  };
  let captured = false;
  const app = render(
    React.createElement(AutopilotScreen, {
      state,
      width: 140,
      height: 28,
      onCapture: (flag: boolean) => (captured = flag),
      onExit: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    await settle();
    await keys('Q');
    assert.match(plain(), /1 queued · 1 planned/);
    assert.match(plain(), /Queued job[\s\S]*Planned job/);
    assert.equal(captured, true, 'global keys are held off while open');
    await keys('j', 'd');
    assert.deepEqual(state.autopilot.rules.excludedJobs, [5]);
    await keys('s');
    assert.equal(state.autopilot.rules.inserts[0]?.kind, 'sleep');
    await keys('k', 'c', 'y');
    assert.deepEqual(cancelled, [0]);
    await keys('\x1b');
    assert.equal(captured, false);
  } finally {
    app.unmount();
  }
});

test('plan rows: back-to-back runs of a job merge, waits for energy are rows, reasons come from the tasks', async () => {
  const { planRows } = await import('../src/tui/autopilot.ts');
  const st = start({ energy: 30 });
  const steps = [
    job({ title: 'Queued', jobId: 9, fixed: { start: st.now, end: st.now + 600 } }),
    job({ title: 'Cotton', jobId: 2 }),
    job({ title: 'Cotton', jobId: 2 }),
    job({ title: 'Wheel', jobId: 3, energy: 40 }),
  ];
  const tl = projectTimeline(st, steps, { wayTime: way });
  const tasks = steps
    .slice(1)
    .map((task, index) => ({ module: 'jobs' as const, key: `t${index}`, step: task, why: `why ${index}` }));
  const rows = planRows(tl, tasks);
  assert.deepEqual(
    rows.map((result) => [result.title, result.count, result.fixed]),
    [
      ['Queued', 1, true],
      ['Cotton', 2, false],
      ['wait 1h14 for energy', 1, false],
      ['Wheel', 1, false],
    ],
  );
  assert.equal(rows[1]!.why, 'why 0', 'a merged row keeps the first reason');
  assert.equal(rows[1]!.xp, 100);
});

test('planner: a job picked for quests says which item, for which quest, and how many are left', async () => {
  const pick = await planWith({
    jobs: [planJob(1, 1, { xp: 100, money: 10, items: [{ itemId: 7000, expected: 1, percent: 100 }] })],
    needs: [{ key: 'item:7', label: 'Cotton', amount: 5, unit: 'items', itemId: 7000, quests: ["Farmer's woes"] }],
  });
  assert.equal(pick.why, `quest: Cotton for "Farmer's woes" (5 left)`);
  assert.match(pick.tasks[1]!.why!, /\(4 left\)/);
});

test('quest rewards: picked by priority; a wearable upgrade always wins', async () => {
  const { chooseReward } = await import('../src/game/autopilot-quests.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const config = parseAutopilotFile(null).config;
  const opts = [
    { id: 1, text: '500 Experience points' },
    { id: 2, text: '300 Dollars' },
    { id: 3, text: 'Bowie knife' },
  ];
  assert.equal(chooseReward(opts, { ...config, priority: ['xp', 'money', 'quests', 'products'] }), 1);
  assert.equal(chooseReward(opts, { ...config, priority: ['money', 'xp', 'quests', 'products'] }), 2);
  assert.equal(
    chooseReward(opts, config, (text) => text === 'Bowie knife'),
    3,
  );
  assert.equal(chooseReward([{ id: 9, text: 'x' }], config), 9);
});

test('duel outlook: needs 2+ results near the level, mostly wins; any loss in 24 h stops NPC duels', async () => {
  const { duelOutlook } = await import('../src/game/autopilot-config.ts');
  const now = 1_000_000;
  const win = (level: number, at = now - 90_000) => ({ at, level, won: true, xp: 40, energy: 10 });
  assert.equal(duelOutlook([win(20)], 20, now), null, 'one result is not enough');
  assert.deepEqual(duelOutlook([win(20), win(22)], 21, now), { xp: 40, energy: 10 });
  assert.equal(duelOutlook([win(20), win(22)], 30, now), null, 'nothing known near level 30');
  assert.equal(
    duelOutlook([win(20), win(22), { ...win(10), won: false, at: now - 3600 }], 21, now),
    null,
    'lost today: no NPC duels',
  );
  assert.deepEqual(
    duelOutlook([win(20), win(22), { ...win(40), won: false, at: now - 100_000 }], 21, now),
    { xp: 40, energy: 10 },
    'an old loss far away does not count',
  );
});

test("planner: a level-up refunds energy, so XP lowers a run's energy cost (refill tops up to max)", async () => {
  // Level 10 → 11 takes 393 XP: 300 XP brings back ~76 energy, so the 12-energy run costs its floor of 3.
  const jobs = [planJob(1, 1, { xp: 300, money: 100 }), planJob(2, 2, { xp: 0, money: 110 })];
  const pick = await planWith({
    jobs,
    config: (candidate) => (candidate.priority = ['money', 'xp', 'quests', 'products']),
  });
  assert.equal((pick.tasks[0]!.step as any).jobId, 1, '$100 for ~3 net energy beats $110 for 12');
});

test('planner: exchange rates are fixed per plan: once a need is nearly met, its crumbs lose to the next goal', async () => {
  const jobs = [
    planJob(3, 3, { xp: 1, money: 0, items: [{ itemId: 700000, expected: 1, percent: 100 }] }),
    planJob(1, 1, { xp: 100, money: 0 }),
  ];
  const needs = [{ key: 'item:700', label: 'Ham', amount: 1.1, unit: 'items', itemId: 700000, quests: ['Q'] }];
  const pick = await planWith({ jobs, needs });
  assert.deepEqual(
    pick.tasks.slice(0, 2).map((task) => (task.step as any).jobId),
    [3, 1],
    'the 0.1 left is worth less than the XP job',
  );
});

test('planner: drops of jobs already queued count toward needs', async () => {
  const jobs = [
    planJob(3, 3, { xp: 1, money: 0, items: [{ itemId: 700000, expected: 1, percent: 100 }] }),
    planJob(1, 1, { xp: 100, money: 0 }),
  ];
  const needs = [{ key: 'item:700', label: 'Ham', amount: 1, unit: 'items' as const, itemId: 700000, quests: ['Q'] }];
  const { planAutopilot } = await import('../src/game/autopilot.ts');
  const { parseAutopilotFile } = await import('../src/game/autopilot-config.ts');
  const autopilotFile = parseAutopilotFile(null);
  const queued: any = {
    kind: 'job',
    title: 'job3',
    jobId: 3,
    at: { x: 50, y: 0 },
    duration: 3600,
    energy: 0,
    xp: 1,
    money: 0,
    fixed: { start: 1_000_000, end: 1_003_600 },
  };
  const pick = planAutopilot({
    start: start(),
    fixed: [queued],
    jobs,
    locations: (value) => (({ 1: [{ x: 100, y: 0 }], 3: [{ x: 50, y: 0 }] }) as any)[value],
    wayTime: way,
    config: autopilotFile.config,
    rules: autopilotFile.rules,
    needs,
    itemValue: () => 0,
    hotels: [],
    towns: [],
    budget: 1000,
    maxJobs: 2,
  });
  assert.equal((pick.tasks[0]!.step as any).jobId, 1, 'the queued run already brings the ham');
});

test('planner: a queue slot costs time (the TUI is not always open), so runs that fill slots fast lose', async () => {
  const slotJob = {
    ...planJob(1, 1, { xp: 0, money: 0 }),
    values: {
      short: { duration: 15, energy: 1, money: 2, experience: 0, luck: 0, items: [] },
      long: { duration: 3600, energy: 12, money: 300, experience: 0, luck: 0, items: [] },
    },
  };
  const money = (slot: number) => (candidate: any) => {
    candidate.priority = ['money', 'xp', 'quests', 'products'];
    candidate.per = 'time';
    candidate.slotCost = slot;
  };
  const fast = { energyRegen: 40, at: { x: 100, y: 0 } };
  assert.equal((await planWith({ jobs: [slotJob], config: money(0), start: fast })).tasks[0]!.key, 'job:1:short');
  assert.equal((await planWith({ jobs: [slotJob], config: money(600), start: fast })).tasks[0]!.key, 'job:1:long');
});

test('timeline: a level-up raises max HP by lpPerPoint', () => {
  const tl = projectTimeline(start({ experience: levelStartXp(11) - 1, healthPerLevel: 15 }), [job({ xp: 10 })], {
    wayTime: way,
  });
  assert.equal(tl.final.level, 11);
  assert.equal(tl.final.health, 515);
});

// ---- quest items bought ------------------------------------------------------------------------

test('quest requirements: a time window is its own kind (it only waits)', async () => {
  const { parseQuest } = await import('../src/game/quests.ts');
  const quest = parseQuest({
    id: 1,
    title: 'Afternoon in the saloon',
    requirements: [
      { solved: false, info: "This quest is only available between 06:00 and 11:00 o'clock.", jsInfo: null },
      { solved: false, info: "Item 'White horse' bought", jsInfo: null },
    ],
  });
  assert.deepEqual(
    quest.requirements.map((requirement) => requirement.kind),
    ['window', 'bought'],
  );
  assert.deepEqual(quest.requirements[0]!.window, { from: '06:00', to: '11:00' });
});

test('quest buys: no walk first, then the nearest shop, within the quest limit; else the market within its own', async () => {
  const { chooseBuys } = await import('../src/game/quest-buy.ts');
  const shop = (townId: number, xCoord: number, price: number): any => ({
    kind: 'shop',
    shop: 'general',
    townId,
    townName: `T${townId}`,
    at: { x: xCoord, y: 0 },
    price,
  });
  const market = (id: number, price: number, count = 1): any => ({
    kind: 'market',
    offer: { id, count },
    townId: 5,
    townName: 'M',
    at: { x: 50, y: 0 },
    price,
  });
  const mobile: any = { kind: 'mobile', item: { itemId: 1000 }, price: 40 };
  const travel = (at: { x: number }) => at.x;
  const limits = { buyLimit: 3000, marketLimit: 5000, market: true, walkValue: 0.25, maxWalk: Infinity };
  const need = (count = 2) => [{ itemId: 1000, name: 'Jug of water', count }];

  let result = chooseBuys(need(), () => [shop(1, 900, 30), shop(2, 100, 35), mobile], limits, travel);
  assert.equal(result.problem, null);
  assert.equal(result.picks[0]!.source.kind, 'mobile', 'no walk beats a cheaper shop');
  result = chooseBuys(need(), () => [shop(1, 900, 30), shop(2, 100, 35)], limits, travel);
  assert.deepEqual(
    [(result.picks[0]!.source as any).townId, result.picks[0]!.cost],
    [2, 70],
    'the nearest shop, price × count',
  );

  // The horse: $2,800 in a shop fits the $3,000 limit; two of them do not, and the market takes over.
  result = chooseBuys(need(2), () => [shop(1, 100, 2800), market(7, 2500), market(8, 2400)], limits, travel);
  assert.equal(result.problem, null);
  assert.deepEqual(
    result.picks.map((pick) => pick.source.kind),
    ['market', 'market'],
  );
  assert.equal(
    result.picks.reduce((accumulator, current) => accumulator + current.cost, 0),
    4900,
  );
  result = chooseBuys(need(1), () => [market(7, 5200)], limits, travel);
  assert.match(result.problem!, /over the \$5,000 market limit/);
  result = chooseBuys(need(1), () => [market(7, 100)], { ...limits, market: false }, travel);
  assert.match(result.problem!, /no shop in reach or the mobile trader sells it/);
  result = chooseBuys(need(1), () => [shop(1, 100, 3500)], { ...limits, market: false }, travel);
  assert.match(result.problem!, /\$3,500 \(general store in T1\), over the \$3,000 quest buy limit/);
});

test('buy catalog: shop price × charge, mobile trader in dollars, market offers mapped to their town', async () => {
  const { BuyCatalog } = await import('../src/game/quest-buy.ts');
  const candidate = new BuyCatalog();
  candidate.setShops(3, [
    { key: 'tailor', townId: 3, townName: 'Slobozia', level: 1, charge: 1.5, items: [300000] } as any,
  ]);
  candidate.setMobile({
    items: [
      {
        itemId: 300000,
        tab: 'trader',
        prices: [{ currency: 'nuggets', amount: 5, base: 5 }],
        discount: 0,
        limitedAt: null,
        limitedCount: null,
        teaser: '',
      },
    ],
    changesAt: null,
  });
  candidate.setMarket(300000, [
    { id: 9, itemId: 300000, count: 1, buyNow: 25, direction: 'SELL', town: { name: 'Far', x: 7, y: 7 } } as any,
    { id: 10, itemId: 300000, count: 1, buyNow: null, direction: 'SELL', town: { name: 'Far', x: 7, y: 7 } } as any,
  ]);
  const src = candidate.sources(
    300000,
    () => 10,
    (id) => (id === 3 ? { name: 'Slobozia', at: { x: 1, y: 1 } } : undefined),
    (at) => (at.x === 7 ? 4 : undefined),
  );
  assert.deepEqual(
    src.map((xCoord) => [xCoord.kind, xCoord.price]),
    [
      ['shop', 15],
      ['market', 25],
    ],
    'nugget-only offers and bid-only offers are left out',
  );
  assert.equal((src[1] as any).townId, 4);
  candidate.dropOffer(9);
  assert.equal(
    candidate.sources(
      300000,
      () => 10,
      () => undefined,
      () => 4,
    ).length,
    0,
  );
});

test('planner: a quest shopping trip in reach is walked first (cost from the budget); one too far waits', async () => {
  const trip = {
    townId: 3,
    name: 'Slobozia',
    at: { x: 300, y: 0 },
    cost: 60,
    what: ['2× Jug of water (general store) for "Party preparation"'],
  };
  const on = (candidate: any) => (candidate.modules.quests = true);
  const pick = await planWith({ config: on, buyTrips: [trip] });
  assert.deepEqual(
    pick.tasks.slice(0, 2).map((task) => task.step.kind),
    ['walk', 'action'],
  );
  assert.deepEqual(pick.tasks[1]!.action, { type: 'buy', townId: 3 });
  assert.match(pick.tasks[1]!.why!, /quest items: 2× Jug of water/);
  assert.equal(pick.timeline.steps[1]!.cash, -60);
  assert.equal(pick.tasks.filter((task) => task.action?.type === 'buy').length, 1, 'once per plan');
  const far = await planWith({
    config: (candidate) => {
      on(candidate);
      candidate.quests.buyTrip = 200;
    },
    buyTrips: [trip],
  });
  assert.equal(far.tasks[0]!.step.kind, 'job');
  const off = await planWith({ buyTrips: [trip] });
  assert.ok(!off.tasks.some((task) => task.action?.type === 'buy'), 'Quests module off: no trips');
});
