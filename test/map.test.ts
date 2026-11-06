import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { type Bootstrap, parseBootstrap } from '../src/auth/bootstrap.ts';
import { collectPois, poisNear } from '../src/game/poi.ts';
import { GameState } from '../src/game/state.ts';
import { TileCache } from '../src/game/tiles.ts';
import { WorldMap } from '../src/game/world.ts';
import { CookieJar } from '../src/http/cookie-jar.ts';
import { GameClient } from '../src/http/game-client.ts';
import { type HostPolicy, resetThrottle } from '../src/http/throttle.ts';
import { App } from '../src/tui/app.ts';
import { buildGrid, cursorRect, entriesAt, findNearest } from '../src/tui/map.ts';
import { obj } from '../src/util/json.ts';

const GAME_PHP = fileURLToPath(new URL('../../en32.the_west.net/en32.the-west.net/game.php', import.meta.url));
const HAVE_GAME = existsSync(GAME_PHP);
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(`${FIXTURES}${name}.live.json`, 'utf8');
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

interface Call {
  url: string;
  body: string;
}
let calls: Call[];
let realFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  resetThrottle();
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body });
    if (url.endsWith('window=work&mode=index')) {
      return new Response(fixture('work_index'));
    }
    if (url.endsWith('ajax=get_minimap')) {
      return new Response(fixture('minimap'));
    }
    if (url.endsWith('ajax=get_complete_data')) {
      return new Response(fixture('complete_data'));
    }
    if (url.includes('window=task&action=add')) {
      const pos = /tasks%5B(\d+)%5D/.exec(body)?.[1] ?? '0';
      return Response.json({
        tasks: {
          [pos]: {
            task: {
              queue_id: 500 + Number(pos),
              type: 'job',
              date_start: 1,
              date_done: 2,
              data: { coords: { x: 1, y: 1 }, title: 'added' },
            },
          },
        },
      });
    }
    if (url.endsWith('mode=get_tasks')) {
      return Response.json({ queue: [] });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function bootstrap(): Bootstrap {
  const second: any = parseBootstrap(readFileSync(GAME_PHP, 'utf8'));
  const shift = Math.floor(Date.now() / 1000) - second.game!.sincepoch;
  second.game!.sincepoch += shift;
  for (const target of second.character!.taskQueue) {
    target.date_start += shift;
    target.date_done += shift;
  }
  second.premium = { premiumBoni: { automation: { expiration: Math.floor(Date.now() / 1000) + 3600 } } };
  return second;
}

async function makeState(): Promise<GameState> {
  const second = bootstrap();
  const client = new GameClient({
    worldUrl: WORLD,
    h: second.h,
    jar: new CookieJar(),
    identity: { userAgent: 'UA', acceptLanguage: 'en' },
    policy: FAST,
  });
  const st = new GameState({ client, bootstrap: second }, async () => ({ client, bootstrap: second }));
  await st.loadJobs();
  return st;
}

test('minimap (live shape) parses towns, forts, job groups, counties', () => {
  const width = WorldMap.fromMinimap(obj(JSON.parse(fixture('minimap'))));
  assert.equal(width.towns.length, 3);
  assert.ok(width.towns.some((town) => town.name === 'Slobozia' && town.id === 1421));
  assert.ok(width.towns.some((town) => town.name === null)); // empty town site
  assert.equal(width.forts.length >= 1, true);
  assert.ok(width.forts.some((value) => value.name && value.name !== 'Fort site'));
  assert.ok(width.jobGroups.get(12)!.length > 10);
  assert.equal(width.counties.length, 15);
  assert.equal(width.countyAt({ x: 29888, y: 15564 })?.id, 12);
  assert.equal(width.fair, null);
});

test('tile data (live shape) yields the silver job and crowds', () => {
  const target = new TileCache();
  target.ingest(obj(JSON.parse(fixture('complete_data'))), [[116, 60]]);
  const silver = [...target.specialJobs.values()];
  assert.equal(silver.length, 1);
  const { seenAt, ...rest } = silver[0]!;
  assert.ok(seenAt > 0);
  assert.deepEqual(rest, { x: 30380, y: 16308, jobId: 5, groupId: 7, gold: false, silver: true });
  assert.ok(
    [...target.crowds.values()].some(
      (candidate) => candidate.x === 29888 && candidate.y === 15564 && candidate.count === 2,
    ),
  );
});

const TILE_SAMPLE = fileURLToPath(
  new URL('../../en32.the_west.net/en32.the-west.net/game-38d090cd2e3a4.php', import.meta.url),
);
test('quest giver names come from tile quests (saved sample)', {
  skip: !existsSync(TILE_SAMPLE) && 'saved tile sample missing',
}, () => {
  const sample = obj(JSON.parse(readFileSync(TILE_SAMPLE, 'utf8')));
  const target = new TileCache();
  target.ingest(sample, [[109, 65]]);
  const entry = target.questGivers.get('28002,16658');
  assert.ok(entry);
  assert.ok(entry.names.includes("Waupee's Indian village"), entry.names.join('|'));
  assert.ok(!entry.names.includes('Chief Mistawasis')); // visible:false employers are hidden, as in the client
});

test('map grid places you, home, queue and county border', { skip: !HAVE_GAME && 'game.php missing' }, async () => {
  const st = await makeState();
  const view = { ...st.character.position, zoom: 128 };
  const grid = buildGrid(st, view, 61, 21).map((row) => row.map((source) => source.text).join(''));
  assert.equal(grid[10]![30], '@'); // cursor cell is the centre and holds you
  assert.ok(
    grid.some((text) => text.includes('H')),
    'home town visible',
  );
  assert.ok(
    grid.some((text) => text.includes('┊') || text.includes('┄')),
    'county border visible',
  );
  assert.ok(
    grid.some((text) => text.includes('j')),
    'job locations visible',
  );
  const rect = cursorRect(view, 61, 21);
  assert.ok(rect.x1 <= 29888 && 29888 < rect.x2 && rect.y1 <= 15564 && 15564 < rect.y2);
});

test('entries under the cursor list jobs there; find jumps to nearest job/town', {
  skip: !HAVE_GAME && 'game.php missing',
}, async () => {
  const st = await makeState();
  const pigs = st.world.jobGroups.get(12)![0]!;
  const entries = entriesAt(st, { ...pigs, zoom: 32 }, 41, 11);
  assert.ok(
    entries.some(
      (entry) => entry.kind === 'job' && entry.option.job.name === 'Tending pigs' && entry.option.at === pigs,
    ),
  );
  const hit = findNearest(st, 'wroc', st.character.position)!;
  assert.equal(hit.label, 'Wrocław');
});

test('points of interest include towns, fort, quest givers, silver job, markets; sorted by distance', {
  skip: !HAVE_GAME && 'game.php missing',
}, async () => {
  const st = await makeState();
  st.tiles.ingest(obj(JSON.parse(fixture('complete_data'))), [[116, 60]]);
  const kinds = new Set(collectPois(st).map((pick) => pick.kind));
  for (const key of ['me', 'queue', 'home', 'town', 'fort', 'quest', 'silver', 'market', 'friend', 'crowd'] as const) {
    assert.ok(kinds.has(key), key);
  }
  const near = poisNear(st, st.character.position);
  assert.ok(near.every((pick, index) => index === 0 || near[index - 1]!.dist <= pick.dist));
  assert.equal(poisNear(st, st.character.position, 'silver')[0]!.label, `Silver job: ${st.catalog.get(5)!.name}`);
});

test('walk to town sends TaskWalk(unitId, "town") like Guidepost.start_walk', {
  skip: !HAVE_GAME && 'game.php missing',
}, async () => {
  const st = await makeState();
  const count = st.queue.length;
  await st.walkToTown(st.world.towns.find((town) => town.name === 'Wrocław')!);
  const add = calls.find((candidate) => candidate.url.includes('action=add'))!;
  assert.equal(
    decodeURIComponent(add.body),
    `tasks[${count}][unitId]=1458&tasks[${count}][type]=town&tasks[${count}][x]=&tasks[${count}][y]=&tasks[${count}][taskType]=walk`,
  );
});

test('TUI: ? help, m map, p points of interest, map select + start job', {
  skip: !HAVE_GAME && 'game.php missing',
}, async () => {
  const st = await makeState();
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
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      out = '';
      stdin.write(key);
      await settle();
    }
  };
  const app = render(React.createElement(App, { state: st }), {
    stdout: stdout as any,
    stdin: stdin as any,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await settle();
    await press('?');
    assert.match(plain(), /Keyboard shortcuts/);
    await press('x'); // any key closes
    assert.doesNotMatch(plain(), /Keyboard shortcuts/);

    await press('m');
    assert.match(plain(), /County 12/);
    await press('?');
    assert.match(plain(), /Map legend/);
    await press('x');

    // Points of interest: filter "wroc", Enter jumps the map there.
    await press('g', 'p');
    assert.match(plain(), /Points of interest/);
    await press('w', 'r', 'o', 'c', '\r');
    const wroclaw = st.world.towns.find((town) => town.name === 'Wrocław')!;
    assert.match(plain(), new RegExp(`cursor ${wroclaw.x - (wroclaw.x % 128)}|Wrocław`));

    // Find Tending pigs with /, select it under the cursor and start the long version.
    await press('/', 'p', 'i', 'g', 's', '\r', '+', '+');
    await press('\r');
    assert.match(plain(), /Tending pigs/);
    const before = calls.filter((candidate) => candidate.url.includes('action=add')).length;
    // Move selection to the Tending pigs entry, then start.
    for (let index = 0; index < 10 && !/\x1b\[7m[^\x1b]*Tending pigs/.test(out); index++) {
      await press('j');
    }
    await press('3');
    const adds = calls.filter((candidate) => candidate.url.includes('action=add'));
    assert.equal(adds.length, before + 1);
    assert.match(decodeURIComponent(adds.at(-1)!.body), /\[jobId\]=1&.*\[duration\]=3600/);
  } finally {
    app.unmount();
  }
});
