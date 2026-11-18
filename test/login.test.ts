import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { AuthError, portalUrl } from '../src/auth/login.ts';
import { ensureGame } from '../src/auth/session.ts';
import { loadWorld } from '../src/auth/session-store.ts';
import { type FingerprintProfile, hashComponents } from '../src/fingerprint/profile.ts';
import { type HostPolicy, resetThrottle } from '../src/http/throttle.ts';

const PORTAL = 'https://www.the-west.net';
const GAME = 'https://en32.the-west.net';
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

const components = [
  { key: 'language', value: 'en-US' },
  { key: 'color_depth', value: 24 },
  { key: 'device_memory', value: 8 },
  { key: 'hardware_concurrency', value: 8 },
  { key: 'resolution', value: [1920, 1080] },
  { key: 'timezone_offset', value: -60 },
  { key: 'cpu_class', value: 'unknown' },
  { key: 'navigator_platform', value: 'Win32' },
  { key: 'adblock', value: false },
  { key: 'has_lied_languages', value: false },
  { key: 'has_lied_resolution', value: false },
  { key: 'has_lied_browser', value: false },
  { key: 'touch_support', value: [0, false, false] },
  { key: 'js_fonts', value: ['Arial'] },
  { key: 'audio_fp', value: '124.04' },
];
const profile: FingerprintProfile = {
  version: 1,
  capturedAt: 'x',
  userAgent: 'Mozilla/5.0 TestBrowser',
  languages: ['en-US', 'en'],
  webdriver: false,
  fp: hashComponents(components),
  components,
};

const GAME_HTML = `<html><script>Game.init({"currentWorldName":"Quebec"});
Player.init({"h":"0b89b1","prop":{"a":"}{"}});
Character.init({"playerId":42,"name":"shallax","level":30,"health":100});</script></html>`;

interface Call {
  method: string;
  url: string;
  body: string | null;
  headers: Headers;
}
let calls: Call[];
let realFetch: typeof fetch;
let dir: string;

function fakeServers(
  opts: {
    gameAcceptsSid?: Set<string>;
    failWorlds?: Set<string>;
    startPageWorlds?: Set<string>;
    loginBody?: string;
  } = {},
) {
  const sessions = opts.gameAcceptsSid ?? new Set<string>();
  let sidN = 0;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : null;
    const form = body ? new URLSearchParams(body) : null;
    const cookie = headers.get('cookie') ?? '';
    calls.push({ method: init.method ?? 'GET', url, body, headers });
    const res = (status: number, items: [string, string][] = [], text: string | null = null) => {
      const out = new Headers();
      for (const [key, value] of items) {
        out.append(key, value);
      }
      return new Response(text, { status, headers: out });
    };
    if (url === `${PORTAL}/`) {
      return res(200, [['set-cookie', 'PHPSESSID=portal; path=/']], '<html>');
    }
    if (url.startsWith(`${PORTAL}/index.php?ajax=check_login`)) {
      if (!cookie.includes('PHPSESSID=portal')) {
        return Response.json({ error: 'cookies disabled' });
      }
      if (form?.get('name') !== 'Tester' || form.get('password') !== 'secret') {
        return Response.json({ error: 'Wrong name or password' });
      }
      return Response.json({ player_id: 42, password: 'tokenhash', playerWorlds: { 12: [12, 1], 38: [38, 1] } });
    }
    if (url === `${PORTAL}/index.php?action=login`) {
      const worldId = form?.get('world_id') ?? '';
      if (opts.startPageWorlds?.has(worldId)) {
        return res(200, [], '<html><form id="loginForm"></form><form id="selectWorld"></form></html>');
      }
      if (opts.failWorlds?.has(worldId)) {
        return res(200, [], '<html><title>Portal</title>World not available</html>');
      }
      if (opts.loginBody) {
        return res(200, [], opts.loginBody);
      }
      const sid = `sid${++sidN}`;
      const host = worldId === '38' ? GAME : 'https://en12.the-west.net';
      return res(302, [['location', `${host}/game.php?sid=${sid}`]]);
    }
    if (url.startsWith(`${GAME}/game.php?sid=`)) {
      const sid = new URL(url).searchParams.get('sid')!;
      sessions.add(sid);
      return res(302, [
        ['location', '/game.php'],
        ['set-cookie', `sid=${sid}; path=/`],
      ]);
    }
    if (url.startsWith('https://en12.')) {
      return res(302, [['location', `${PORTAL}/`]]);
    }
    const sid = /(?:^|; )sid=([^;]+)/.exec(cookie)?.[1];
    if (url === `${GAME}/game.php`) {
      if (!sid || !sessions.has(sid)) {
        return res(302, [['location', `${PORTAL}/?logout`]]);
      }
      return res(200, [], GAME_HTML);
    }
    if (url === `${GAME}/game.php?window=anti_cheat&action=record_fp&h=0b89b1`) {
      return Response.json({ error: false });
    }
    return res(404, [], `unexpected ${url}`);
  }) as typeof fetch;
  return sessions;
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  resetThrottle();
  dir = mkdtempSync(join(tmpdir(), 'twcli-'));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

test('portalUrl maps world host to the www portal', () => {
  assert.equal(portalUrl('https://en32.the-west.net'), 'https://www.the-west.net');
});

test('full login: portal → world → game.php bootstrap → record_fp, then session reuse', async () => {
  const sessions = fakeServers();
  const sessionFile = join(dir, 'session.json');
  const opts = {
    profile,
    policy: FAST,
    sessionFile,
    worldFile: join(dir, 'world.json'),
    world: { url: GAME, locale: 'en_DK' },
    credentials: async () => ({ name: 'Tester', password: 'secret' }),
  };

  const game = await ensureGame(opts);
  assert.equal(game.bootstrap.h, '0b89b1');
  assert.equal(game.bootstrap.character?.name, 'shallax');
  assert.ok(calls.some((candidate) => candidate.url.includes('check_login') && candidate.url.includes('locale=en_DK')));
  // Wrong world (12) is skipped, correct one (38) entered.
  assert.deepEqual(
    calls
      .filter((candidate) => candidate.url.endsWith('action=login'))
      .map((candidate) => new URLSearchParams(candidate.body!).get('world_id')),
    ['12', '38'],
  );
  // Fingerprint sent once, with the browser's exact body and identity headers.
  const fp = calls.filter((candidate) => candidate.url.includes('record_fp'));
  assert.equal(fp.length, 1);
  assert.equal(fp[0]!.body, `fp=${profile.fp}&gv=&wd=false`);
  assert.equal(fp[0]!.headers.get('x-requested-with'), 'XMLHttpRequest');
  assert.equal(fp[0]!.headers.get('user-agent'), profile.userAgent);
  assert.equal(fp[0]!.headers.get('accept-language'), 'en-US,en;q=0.9');
  // Every request carries the captured User-Agent.
  assert.ok(calls.every((candidate) => candidate.headers.get('user-agent') === profile.userAgent));
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600);

  // Second run reuses cookies: no portal traffic, but record_fp again (it fires on each page load).
  calls = [];
  const again = await ensureGame({ ...opts, credentials: async () => assert.fail('should not ask for credentials') });
  assert.equal(again.bootstrap.h, '0b89b1');
  assert.ok(calls.every((candidate) => candidate.url.startsWith(GAME)));
  assert.equal(calls.filter((candidate) => candidate.url.includes('record_fp')).length, 1);

  // Expired session → logs in again.
  sessions.clear();
  calls = [];
  await ensureGame(opts);
  assert.ok(calls.some((candidate) => candidate.url.includes('check_login')));
});

test('a selected world is the only one entered and is saved for the next start', async () => {
  fakeServers();
  const worldFile = join(dir, 'world.json');
  const world = { url: GAME, locale: 'en_DK', id: 38, name: 'Quebec' };
  const game = await ensureGame({
    profile,
    policy: FAST,
    sessionFile: join(dir, 's.json'),
    worldFile,
    world,
    credentials: async () => ({ name: 'Tester', password: 'secret' }),
  });
  assert.equal(game.bootstrap.h, '0b89b1');
  assert.deepEqual(
    calls
      .filter((candidate) => candidate.url.endsWith('action=login'))
      .map((candidate) => new URLSearchParams(candidate.body!).get('world_id')),
    ['38'],
    'only the picked world is tried',
  );
  assert.deepEqual(loadWorld(worldFile), { url: GAME, locale: 'en_DK', id: 38, name: 'Quebec' });
});

test('a picked world the account has no character on is reported before any login attempt', async () => {
  fakeServers();
  await assert.rejects(
    ensureGame({
      profile,
      policy: FAST,
      sessionFile: join(dir, 's.json'),
      worldFile: join(dir, 'w.json'),
      world: { url: 'https://en31.the-west.net', locale: 'en_DK', id: 37, name: 'Phoenix' },
      credentials: async () => ({ name: 'Tester', password: 'secret' }),
    }),
    (entry: unknown) =>
      entry instanceof AuthError &&
      /This account has no character on Phoenix \(en31\.the-west\.net\), world 37/.test(entry.message),
  );
  assert.equal(calls.filter((candidate) => candidate.url.endsWith('action=login')).length, 0);
});

test('wrong password is reported', async () => {
  fakeServers();
  await assert.rejects(
    ensureGame({
      profile,
      policy: FAST,
      sessionFile: join(dir, 's.json'),
      worldFile: join(dir, 's-world.json'),
      world: { url: GAME, locale: 'en_DK' },
      credentials: async () => ({ name: 'Tester', password: 'nope' }),
    }),
    (entry: unknown) => entry instanceof AuthError && /Wrong name or password/.test(entry.message),
  );
});

test('a world that answers with the portal page does not stop the next world', async () => {
  fakeServers({ failWorlds: new Set(['12']) });
  const game = await ensureGame({
    profile,
    policy: FAST,
    sessionFile: join(dir, 's.json'),
    worldFile: join(dir, 's-world.json'),
    world: { url: GAME, locale: 'en_DK' },
    credentials: async () => ({ name: 'Tester', password: 'secret' }),
  });
  assert.equal(game.bootstrap.h, '0b89b1');
  assert.deepEqual(
    calls
      .filter((candidate) => candidate.url.endsWith('action=login'))
      .map((candidate) => new URLSearchParams(candidate.body!).get('world_id')),
    ['12', '38'],
    'the failed world is tried, then en32',
  );
});

test('no world leads to the game: the error says what the portal returned', async () => {
  fakeServers({ failWorlds: new Set(['12', '38']) });
  await assert.rejects(
    ensureGame({
      profile,
      policy: FAST,
      sessionFile: join(dir, 's.json'),
      worldFile: join(dir, 's-world.json'),
      world: { url: GAME, locale: 'en_DK' },
      credentials: async () => ({ name: 'Tester', password: 'secret' }),
    }),
    (entry: unknown) =>
      entry instanceof AuthError &&
      /Login did not lead to the game \(world 12: HTTP 200 — Portal World not available; world 38: HTTP 200 — Portal World not available\)/.test(
        entry.message,
      ),
  );
});

test('a portal start page means the login token was not accepted', async () => {
  fakeServers({ startPageWorlds: new Set(['12', '38']) });
  await assert.rejects(
    ensureGame({
      profile,
      policy: FAST,
      sessionFile: join(dir, 's.json'),
      worldFile: join(dir, 's-world.json'),
      world: { url: GAME, locale: 'en_DK' },
      credentials: async () => ({ name: 'Tester', password: 'secret' }),
    }),
    (entry: unknown) =>
      entry instanceof AuthError &&
      /world 12: HTTP 200 — the portal start page \(login token not accepted\); world 38: HTTP 200 — the portal start page \(login token not accepted\)/.test(
        entry.message,
      ),
  );
});

test('a relative, JSON-escaped game URL in the login page is followed', async () => {
  fakeServers({ loginBody: '<script>window.location="\\/game.php?sid=relative";</script>' });
  const game = await ensureGame({
    profile,
    policy: FAST,
    sessionFile: join(dir, 's.json'),
    worldFile: join(dir, 's-world.json'),
    world: { url: GAME, locale: 'en_DK' },
    credentials: async () => ({ name: 'Tester', password: 'secret' }),
  });
  assert.equal(game.bootstrap.h, '0b89b1');
  assert.ok(calls.some((candidate) => candidate.url === `${GAME}/game.php?sid=relative`));
});
