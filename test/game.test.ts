import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { type Bootstrap, parseBootstrap } from '../src/auth/bootstrap.ts';
import { CharacterState, levelProgress, levelStartXp } from '../src/game/character.ts';
import { ServerClock } from '../src/game/clock.ts';
import {
  motivationFactor,
  nearestLocation,
  parseDanger,
  parseJobDetail,
  scaleJobValues,
  wayTime,
} from '../src/game/jobs.ts';
import { GameState } from '../src/game/state.ts';
import { jobPost, parseQueue, TaskLimitError } from '../src/game/tasks.ts';
import { CookieJar } from '../src/http/cookie-jar.ts';
import { jqueryParam } from '../src/http/form.ts';
import { GameClient } from '../src/http/game-client.ts';
import { type HostPolicy, resetThrottle } from '../src/http/throttle.ts';
import { App } from '../src/tui/app.ts';
import { formatDuration, scrollWindow } from '../src/tui/format.ts';

const GAME_PHP = fileURLToPath(new URL('../../en32.the_west.net/en32.the-west.net/game.php', import.meta.url));
const HAVE_GAME = existsSync(GAME_PHP);
const WORLD = 'https://en32.the-west.net';
const FAST: HostPolicy = {
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

/** Real bootstrap from the saved page, with the clock moved so the saved queue is still running. */
function realBootstrap(): Bootstrap {
  const second: any = parseBootstrap(readFileSync(GAME_PHP, 'utf8'));
  const shift = Math.floor(Date.now() / 1000) - second.game!.sincepoch;
  second.game!.sincepoch += shift;
  for (const target of second.character!.taskQueue) {
    target.date_start += shift;
    target.date_done += shift;
  }
  return second;
}

interface Call {
  url: string;
  body: string;
}
let calls: Call[];
let realFetch: typeof fetch;
let addReply: (body: URLSearchParams) => unknown;

// Fake server: work/index, get_minimap and get_complete_data replay trimmed LIVE responses
// (test/fixtures/*.live.json, captured 2026-11-03); task replies follow the client JS.
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(`${FIXTURES}${name}.live.json`, 'utf8');
function fakeGame() {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body });
    if (url === `${WORLD}/ntp.php`) {
      return new Response(String(Date.now()));
    }
    if (url === `${WORLD}/game.php?window=work&mode=index`) {
      return new Response(fixture('work_index'));
    }
    if (url === `${WORLD}/game.php?window=map&ajax=get_minimap`) {
      return new Response(fixture('minimap'));
    }
    if (url === `${WORLD}/game.php?window=map&ajax=get_complete_data`) {
      return new Response(fixture('complete_data'));
    }
    if (url.startsWith(`${WORLD}/game.php?window=task&action=add&h=`)) {
      return Response.json(addReply(new URLSearchParams(body)));
    }
    if (url.startsWith(`${WORLD}/game.php?window=task&action=cancel&h=`)) {
      return Response.json({ tasks: { 1: { extra: { energy: 50 } } }, queue: [] });
    }
    if (url === `${WORLD}/game.php?window=task&mode=get_tasks`) {
      return Response.json({ queue: [] });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  }) as typeof fetch;
}

function makeState(second: Bootstrap): GameState {
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
  realFetch = globalThis.fetch;
  resetThrottle();
  addReply = () => ({ tasks: {} });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('formatting helpers', () => {
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(65), '1:05');
  assert.deepEqual(scrollWindow(0, 100, 10), [0, 10]);
  assert.deepEqual(scrollWindow(99, 100, 10), [90, 100]);
  assert.deepEqual(scrollWindow(50, 100, 10), [45, 55]);
});

test('way time and nearest location follow GameMap.calcWayTime', () => {
  assert.equal(wayTime({ x: 0, y: 0 }, { x: 300, y: 400 }, 0.9, 0.5), 225);
  assert.deepEqual(
    nearestLocation(
      [
        { x: 10, y: 0 },
        { x: 2, y: 2 },
      ],
      { x: 0, y: 0 },
    ),
    { x: 2, y: 2 },
  );
  assert.equal(nearestLocation([], { x: 0, y: 0 }), null);
});

test('job detail parses danger, motivation, special kind and location values', () => {
  assert.deepEqual(parseJobDetail({ danger: '37', motivation: 0.55 }), {
    danger: 37,
    motivation: 0.55,
    special: null,
    luckValue: null,
    values: {},
  });
  assert.deepEqual(parseJobDetail({}), {
    danger: null,
    motivation: null,
    special: null,
    luckValue: null,
    values: {},
  });
  const detail = parseJobDetail({
    danger: 0,
    motivation: 0.58,
    is_gold: true,
    minMaxItemVal: [100, 400],
    durations: [
      null,
      null,
      { duration: 3600, cost: 12, money: 355, xp: 888, luck: 3, items: [{ itemid: 2434000, prop: 31 }] },
    ],
  });
  assert.equal(detail.special, 'gold');
  assert.deepEqual(detail.luckValue, [100, 400]);
  assert.deepEqual(detail.values.long, {
    duration: 3600,
    energy: 12,
    money: 355,
    experience: 888,
    luck: 3,
    items: [{ itemId: 2434000, expected: 0.31, percent: 31 }],
  });
  assert.equal(parseDanger(0), 0);
  assert.equal(parseDanger('0'), 0);
  assert.equal(parseDanger(undefined), null);
});

test('motivation breakpoints and rescaling: 100/75/50/25/0, money rounds up, drops stay', () => {
  assert.deepEqual(
    [0, 0.01, 0.25, 0.26, 0.5, 0.51, 0.74, 0.75, 0.76, 0.99, 1].map(motivationFactor),
    [0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 0.75, 1, 1, 1],
  );
  const scaled = scaleJobValues(
    {
      duration: 3600,
      energy: 12,
      money: 473,
      experience: 1183,
      luck: 2,
      items: [{ itemId: 1, expected: 0.31, percent: 31 }],
    },
    1,
    0.58,
  );
  assert.equal(scaled.money, 355);
  assert.equal(scaled.experience, 888);
  assert.equal(scaled.luck, 1.5);
  assert.deepEqual(scaled.items, [{ itemId: 1, expected: 0.31, percent: 31 }]);
});

test('task/add body matches jQuery serialisation of TaskQueue.sendAdd', () => {
  // Two tasks already queued → the browser keys the new one as tasks[2].
  const body = jqueryParam({ tasks: { 2: jobPost(54, { x: 29888, y: 15564 }, 3600) } });
  assert.equal(
    decodeURIComponent(body),
    'tasks[2][jobId]=54&tasks[2][x]=29888&tasks[2][y]=15564&tasks[2][duration]=3600&tasks[2][taskType]=job',
  );
});

test('character from the real Character.init: max HP formula and regen', {
  skip: !HAVE_GAME && 'game.php missing',
}, () => {
  const second = realBootstrap();
  const clock = new ServerClock(Number(second.game!.sincepoch));
  const character = CharacterState.fromInit(second.character!, clock);
  assert.equal(character.maxHealth, 600); // 100 + 29*10 + (7+14)*10
  assert.equal(character.name, 'shallax');
  const energyBefore = character.energy;
  clock.driftMs -= 3600_000; // one hour later
  assert.equal(character.energy, Math.min(character.maxEnergy, Math.floor(7.519 + 100 * 0.03))); // energyRegen 0.03 * maxEnergy per hour
  assert.ok(character.energy > energyBefore);
});

test('level progress follows Character.calcLowerExp / getExperience4Level', {
  skip: !HAVE_GAME && 'game.php missing',
}, () => {
  // Values the browser computes: calcLowerExp(1) = 0, (2) = 42, (30) = 29232, (31) = 32145; > 120 adds 1000·(l−120)^2.9.
  assert.deepEqual(
    [1, 2, 30, 31].map((value) => levelStartXp(value)),
    [0, 42, 29232, 32145],
  );
  assert.equal(levelStartXp(121), Math.floor(((121 * 122 * 243) / 6 + 1220 - 21) * 3 + 1000));
  const second = realBootstrap();
  assert.equal(second.game!.maxLevel, 250);
  const character = CharacterState.fromInit(second.character!, new ServerClock(Number(second.game!.sincepoch)));
  assert.deepEqual([character.level, character.experience], [30, 32067]);
  const pick = character.progress;
  assert.deepEqual([pick.have, pick.need, pick.maxed], [32067 - 29232, 32145 - 29232, false]);
  assert.equal(Math.floor(pick.ratio * 100), 97);
  // Max level: the web shows the infinity image; the CLI says "max level".
  assert.deepEqual(levelProgress(250, 9e9, 250).maxed, true);
  assert.equal(levelProgress(249, levelStartXp(249), 250).have, 0);
});

test('real task queue entries parse', { skip: !HAVE_GAME && 'game.php missing' }, () => {
  const task = parseQueue(realBootstrap().character!.taskQueue);
  assert.ok(task.length >= 1);
  assert.equal(task[0]!.type, 'job');
  assert.equal(task[0]!.jobId, 54);
  assert.equal(task[0]!.title, 'Bartering with Indians');
  assert.deepEqual(task[0]!.coords, { x: 29888, y: 15564 });
});

test('jobs load and startJob sends task/add with the next queue position and h', {
  skip: !HAVE_GAME && 'game.php missing',
}, async () => {
  fakeGame();
  const second = realBootstrap();
  second.premium = { premiumBoni: { automation: { expiration: Math.floor(Date.now() / 1000) + 3600 } } };
  const state = makeState(second);
  const queued = state.queue.length;
  await state.loadJobs();
  assert.equal(state.jobs.length, 2);

  const opt = state.jobOptions('pigs')[0]!;
  assert.equal(opt.job.name, 'Tending pigs');
  assert.equal(opt.job.laborPoints, 352); // live: jobSkillPoints 353 − malus 1
  assert.equal(opt.job.workPoints, 2); // client rule: malus + 1
  assert.deepEqual(opt.at, nearestLocation(state.world.jobGroups.get(12), state.queueEndPosition));

  addReply = (form) => {
    assert.equal(form.get(`tasks[${queued}][jobId]`), '1');
    assert.equal(form.get(`tasks[${queued}][duration]`), '600');
    assert.equal(form.get(`tasks[${queued}][taskType]`), 'job');
    return {
      tasks: {
        [queued]: {
          task: {
            queue_id: 99,
            type: 'job',
            date_start: 1,
            date_done: 2,
            data: { job_id: 1, title: 'Tending pigs', coords: { x: 29900, y: 15600 } },
          },
        },
      },
      energy: 42,
    };
  };
  await state.startJob(opt, 'middle');
  const add = calls.find((candidate) => candidate.url.includes('action=add'))!;
  assert.ok(add.url.endsWith(`&h=${second.h}`));
  assert.equal(state.queue.length, queued + 1);
  assert.equal(state.queue.at(-1)!.queueId, 99);
  assert.equal(state.character.energy, 42);
  assert.deepEqual(
    state.log.filter((line) => line.level === 'error'),
    [],
  );
});

test('queue limit without automation premium is enforced before sending', {
  skip: !HAVE_GAME && 'game.php missing',
}, async () => {
  fakeGame();
  const second = realBootstrap();
  second.premium = { premiumBoni: { automation: { expiration: 0 } } };
  const state = makeState(second);
  await state.loadJobs();
  while (state.queue.length < state.taskLimit) {
    state.queue.push({ ...state.queue[0]! });
  }
  assert.equal(state.taskLimit, 4);
  await state.startJob(state.jobOptions()[0]!, 'short');
  assert.ok(!calls.some((candidate) => candidate.url.includes('action=add')));
  assert.match(state.log.at(-1)!.msg, /queue is full/i);
  assert.ok(TaskLimitError);
});

test('TUI renders status, jobs and queue, and keys drive actions', {
  skip: !HAVE_GAME && 'game.php missing',
}, async () => {
  fakeGame();
  const second = realBootstrap();
  second.premium = { premiumBoni: { automation: { expiration: Math.floor(Date.now() / 1000) + 3600 } } };
  const state = makeState(second);
  await state.loadJobs();

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
  const settle = () => new Promise((transform) => setTimeout(transform, 120));

  const app = render(React.createElement(App, { state }), {
    stdout: stdout as any,
    stdin: stdin as any,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await settle();
    assert.match(plain(), /shallax/);
    assert.match(plain(), /HP .*\/600/);
    // The app starts on home; g j opens the jobs screen.
    stdin.write('g');
    await settle();
    stdin.write('j');
    await settle();
    assert.match(plain(), /Tending pigs/);
    assert.match(plain(), /Bartering with Indians/);

    // Filter to "pigs", then start the middle duration with "2".
    const queued = state.queue.length;
    addReply = () => ({
      tasks: {
        [queued]: {
          task: {
            queue_id: 7,
            type: 'job',
            date_start: 1,
            date_done: 2,
            data: { job_id: 1, title: 'Tending pigs', coords: { x: 29900, y: 15600 } },
          },
        },
      },
    });
    for (const key of ['/', 'p', 'i', 'g', '\r', '2']) {
      stdin.write(key);
      await settle();
    }
    assert.ok(
      calls.some(
        (candidate) => candidate.url.includes('action=add') && decodeURIComponent(candidate.body).includes('[jobId]=1'),
      ),
    );
    assert.equal(state.queue.length, queued + 1);

    // Tab to the queue, move to task 2, cancel with confirmation.
    for (const entryKey of ['\t', 'j', 'c']) {
      stdin.write(entryKey);
      await settle();
    }
    assert.match(plain(), /Cancel this task\? y \/ n/);
    stdin.write('y');
    await settle();
    const cancel = calls.find((candidate) => candidate.url.includes('action=cancel'))!;
    assert.ok(cancel);
    assert.match(decodeURIComponent(cancel.body), /^tasks\[1\]\[queueId\]=\d+&tasks\[1\]\[type\]=job$/);
  } finally {
    app.unmount();
  }
});

test('loading frame: the connect step shows as running with a timer, then as done with its duration', async () => {
  const { LoadingFrame } = await import('../src/tui/app.ts');
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { columns: 80, rows: 20, isTTY: true });
  let out = '';
  stdout.on('data', (data) => (out += data.toString()));
  const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const startedAt = Date.now() - 3_000;
  const app = render(
    React.createElement(LoadingFrame, {
      width: 80,
      height: 20,
      steps: [{ label: 'Connecting to The West', status: 'running', startedAt }],
      keys: 'q quit',
    }),
    { stdout: stdout as any, patchConsole: false },
  );
  try {
    await new Promise((transform) => setTimeout(transform, 50));
    assert.match(plain(), /Connecting to The West\s+3 s/);
    assert.match(plain(), /q quit/);
    app.rerender(
      React.createElement(LoadingFrame, {
        width: 80,
        height: 20,
        steps: [
          { label: 'Connecting to The West', status: 'done', startedAt, endedAt: startedAt + 1500 },
          { label: 'Server clock', status: 'running', startedAt: Date.now() },
        ],
        keys: 'Esc skip · q quit',
      }),
    );
    await new Promise((transform) => setTimeout(transform, 50));
    assert.match(plain(), /✔ Connecting to The West\s+1\.5 s/);
    assert.match(plain(), /Server clock/);
  } finally {
    app.unmount();
  }
});
