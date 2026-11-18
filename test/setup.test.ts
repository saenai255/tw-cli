// Runs in its own process (node --test isolates files), so TW_CLI_HOME can point at a temp dir
// before the modules that read it are imported.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'twcli-setup-'));
process.env.TW_CLI_HOME = home;
delete process.env.TW_FP_PROFILE;
delete process.env.TW_LOGIN_NAME;
delete process.env.TW_LOGIN_PASSWORD;
delete process.env.TW_WORLD_URL;
delete process.env.TW_LOCALE;

const React = (await import('react')).default;
const { render } = await import('ink');
const { startWebServer } = await import('../src/web/server.ts');
const { hashComponents } = await import('../src/fingerprint/profile.ts');
const { SetupScreen } = await import('../src/tui/setup.ts');
const { resetThrottle } = await import('../src/http/throttle.ts');
const { PROFILE_FILE, SESSION_FILE, WORLD_FILE, loadWorld } = await import('../src/auth/session-store.ts');

const components = [
  { key: 'language', value: 'en-GB' },
  { key: 'color_depth', value: 24 },
  { key: 'device_memory', value: 8 },
  { key: 'hardware_concurrency', value: 8 },
  { key: 'resolution', value: [1920, 1080] },
  { key: 'timezone_offset', value: -60 },
  { key: 'cpu_class', value: 'unknown' },
  { key: 'navigator_platform', value: 'MacIntel' },
  { key: 'adblock', value: false },
  { key: 'has_lied_languages', value: false },
  { key: 'has_lied_resolution', value: false },
  { key: 'has_lied_browser', value: false },
  { key: 'touch_support', value: [0, false, false] },
  { key: 'js_fonts', value: ['Arial'] },
  { key: 'audio_fp', value: '35.7' },
];
const profile = {
  capturedAt: 'x',
  userAgent: 'Mozilla/5.0 Test',
  languages: ['en-GB', 'en'],
  webdriver: false,
  fp: hashComponents(components),
  components,
};

function http(
  url: string,
  opts: { method?: string; body?: string; host?: string; type?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const urlValue = new URL(url);
    const req = request(
      {
        host: urlValue.hostname,
        port: urlValue.port,
        path: urlValue.pathname + urlValue.search,
        method: opts.method ?? 'GET',
        headers: {
          host: opts.host ?? urlValue.host,
          ...(opts.body ? { 'content-type': opts.type ?? 'application/json' } : {}),
        },
      },
      (res) => {
        let textValue = '';
        res.on('data', (data) => (textValue += data));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: textValue, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

after(() => rmSync(home, { recursive: true, force: true }));

test('vendored Fingerprint2 is byte-identical to the build in game.php', () => {
  const gamePhp = fileURLToPath(new URL('../../en32.the_west.net/en32.the-west.net/game.php', import.meta.url));
  if (!existsSync(gamePhp)) {
    return;
  }
  const lib = readFileSync(new URL('../src/web/assets/fingerprint2.js', import.meta.url), 'utf8');
  const body = lib.slice(lib.indexOf('!function(e,t,n)'), lib.lastIndexOf(';'));
  assert.ok(readFileSync(gamePhp, 'utf8').includes(body));
});

test('web page: token + host checks, no external assets, fingerprint save, login', async () => {
  const saved: string[] = [];
  const logins: string[] = [];
  const srv = await startWebServer({
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    onFingerprint: (fp) => saved.push(fp),
    login: async (name, password, profileValue, world) => {
      logins.push(`${name}:${password}:${profileValue.fp}:${world.name ?? '?'}`);
      if (password !== 'secret') {
        throw new Error('Login rejected: Wrong name or password');
      }
      return { name: 'shallax', level: 30, world: world.name ?? '?' };
    },
  });
  try {
    const base = srv.url.replace(/\/\?t=.*$/, '');
    assert.equal((await http(`${base}/`)).status, 403);
    assert.equal((await http(srv.url, { host: 'evil.example:80' })).status, 421);

    const page = await http(srv.url);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    // No remote assets: every src/href/url()/fetch target is same-origin.
    assert.doesNotMatch(page.body, /(?:src|href|action)\s*=\s*["']?(?:https?:)?\/\//i, 'no remote src/href');
    assert.doesNotMatch(
      page.body,
      /url\(\s*["']?(?:https?:)?\/\/|@import|fetch\(\s*["']https?:/i,
      'no remote css/fetch',
    );
    const lib = await http(`${base}/fingerprint2.js?t=${srv.token}`);
    assert.equal(lib.status, 200);
    assert.match(lib.body, /t\.VERSION="1\.8\.0"/);
    // The world dropdown lists the .net worlds with the saved/default one selected.
    assert.match(page.body, /<select id="world" name="world" required>/);
    assert.match(page.body, /<option value="38" selected>Quebec · en32\.the-west\.net<\/option>/);
    assert.match(page.body, /<option value="18">Arizona · en13\.the-west\.net<\/option>/);

    // Login before a fingerprint exists is refused.
    let result = await http(`${base}/api/login?t=${srv.token}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Tester', password: 'secret' }),
    });
    assert.equal(result.status, 400);
    assert.match(result.body, /fingerprint first/);

    // A tampered profile is rejected; a real one is saved 0600.
    result = await http(`${base}/api/fingerprint?t=${srv.token}`, {
      method: 'POST',
      body: JSON.stringify({ ...profile, fp: '0'.repeat(32) }),
    });
    assert.equal(result.status, 400);
    result = await http(`${base}/api/fingerprint?t=${srv.token}`, { method: 'POST', body: JSON.stringify(profile) });
    assert.equal(result.status, 200);
    assert.deepEqual(saved, [profile.fp]);
    assert.equal(statSync(PROFILE_FILE).mode & 0o777, 0o600);
    assert.equal((JSON.parse(readFileSync(PROFILE_FILE, 'utf8')) as { fp: string }).fp, profile.fp);

    result = await http(`${base}/api/login?t=${srv.token}`, {
      method: 'POST',
      body: 'name=x',
      type: 'application/x-www-form-urlencoded',
    });
    assert.equal(result.status, 415);
    result = await http(`${base}/api/login?t=${srv.token}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Tester', password: 'nope' }),
    });
    assert.equal(result.status, 401);
    result = await http(`${base}/api/login?t=${srv.token}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Tester', password: 'secret' }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { ok: true, name: 'shallax', level: 30, world: 'Quebec' });
    assert.deepEqual(logins.at(-1), `Tester:secret:${profile.fp}:Quebec`);

    // The page's world select picks any open .net world; closed and unknown ids are refused.
    result = await http(`${base}/api/login?t=${srv.token}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Tester', password: 'secret', world: 18 }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { ok: true, name: 'shallax', level: 30, world: 'Arizona' });
    assert.deepEqual(logins.at(-1), `Tester:secret:${profile.fp}:Arizona`);
    result = await http(`${base}/api/login?t=${srv.token}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Tester', password: 'secret', world: 23 }),
    });
    assert.equal(result.status, 400);
    assert.match(result.body, /Halloween Speed is closed/);
    result = await http(`${base}/api/login?t=${srv.token}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Tester', password: 'secret', world: 9999 }),
    });
    assert.equal(result.status, 400);
    assert.match(result.body, /Unknown world 9999/);
  } finally {
    await srv.close();
  }
});

// Fake portal + game for the in-TUI login.
const PORTAL = 'https://www.the-west.net';
const GAME = 'https://en32.the-west.net';
const ARIZONA = 'https://en13.the-west.net';
let realFetch: typeof fetch;
before(() => {
  realFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test('TUI setup: type fingerprint + User-Agent, log in with name/password', async () => {
  rmSync(PROFILE_FILE, { force: true });
  resetThrottle();
  const seen: { url: string; body: string; ua: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';
    seen.push({ url, body, ua: headers.get('user-agent') });
    const cookie = headers.get('cookie') ?? '';
    const res = (status: number, items: [string, string][] = [], text: string | null = null) =>
      new Response(text, { status, headers: items });
    if (url === `${PORTAL}/`) {
      return res(200, [['set-cookie', 'PHPSESSID=p; path=/']], '<html>');
    }
    if (url.includes('check_login')) {
      const urlValue = new URLSearchParams(body);
      if (urlValue.get('password') !== 'secret') {
        return Response.json({ error: 'Wrong name or password' });
      }
      return Response.json({
        player_id: 42,
        password: 'tok',
        playerWorlds: { 18: [18, 1], 38: [38, 1] },
      });
    }
    if (url.endsWith('action=login')) {
      const worldId = new URLSearchParams(body).get('world_id');
      const host = worldId === '18' ? ARIZONA : GAME;
      return res(302, [['location', `${host}/game.php?sid=s1`]]);
    }
    if (url.includes('game.php?sid=')) {
      return res(302, [
        ['location', '/game.php'],
        ['set-cookie', 'sid=s1; path=/'],
      ]);
    }
    if (url.endsWith('/game.php')) {
      if (!cookie.includes('sid=s1')) {
        return res(302, [['location', `${PORTAL}/`]]);
      }
      const worldName = new URL(url).host === new URL(ARIZONA).host ? 'Arizona' : 'Quebec';
      return res(
        200,
        [],
        `<script>Game.init({"currentWorldName":"${worldName}","jobs":[]});Player.init({"h":"0b89b1"});Character.init({"playerId":42,"name":"shallax","level":30,"pos":{"x":1,"y":1},"taskQueue":[]});</script>`,
      );
    }
    if (url.includes('record_fp')) {
      return Response.json({ error: false });
    }
    return res(404, [], 'unexpected');
  }) as typeof fetch;

  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { columns: 110, rows: 34, isTTY: true });
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
  const settle = (ms = 60) => new Promise((transform) => setTimeout(transform, ms));
  const type = async (textValue: string) => {
    for (const ch of textValue) {
      stdin.write(ch);
      await settle(15);
    }
  };

  let ready: any = null;
  const app = render(
    React.createElement(SetupScreen, {
      onReady: (group: any) => (ready = group),
      onQuit: () => {},
      policy: {
        concurrency: 1,
        minIntervalMs: 0,
        jitterMs: 0,
        maxRetries: 0,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        breakerThreshold: 100,
        breakerCooldownMs: 0,
        timeoutMs: 5000,
      },
    }),
    { stdout: stdout as any, stdin: stdin as any, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    await settle();
    assert.match(plain(), /Fingerprint\s+✘/);
    await type('l');
    assert.match(plain(), /fingerprint first/);

    await type('f');
    await type(profile.fp);
    await type('\r');
    await type('a');
    await type('Mozilla/5.0 Test');
    await type('\r');
    await settle();
    assert.match(plain(), new RegExp(`✔ ${profile.fp}`));
    assert.match(plain(), /hash only/);

    // World picker: filter to Arizona and select it; the row and world.json follow.
    assert.match(plain(), /World\s+Quebec · en32\.the-west\.net/);
    await type('o');
    assert.match(plain(), /Worlds · 15 open, 2 closed/);
    assert.match(plain(), /Arizona/);
    await type('/');
    await type('ariz');
    await type('\r');
    await type('\r');
    await settle();
    assert.match(plain(), /World\s+Arizona · en13\.the-west\.net/);
    assert.equal(loadWorld(WORLD_FILE)?.id, 18);
    assert.equal(loadWorld(WORLD_FILE)?.name, 'Arizona');

    await type('l');
    await type('Tester\r');
    await type('secret');
    await settle(150);
    assert.match(plain(), /Password: ••••••/);
    assert.doesNotMatch(plain(), /secret/);
    await type('\r');
    for (let index = 0; index < 50 && !ready; index++) {
      await settle(50);
    }
    assert.ok(ready, 'login finished');
    assert.equal(ready.bootstrap.character.name, 'shallax');
    assert.equal(ready.client.worldUrl, ARIZONA);
    assert.equal(ready.bootstrap.game.currentWorldName, 'Arizona');
    assert.ok(seen.every((source) => source.ua === 'Mozilla/5.0 Test'));
    assert.equal(seen.find((source) => source.url.includes('record_fp'))!.body, `fp=${profile.fp}&gv=&wd=false`);
    assert.ok(seen.some((source) => source.url.startsWith(ARIZONA)));
    assert.ok(existsSync(SESSION_FILE));
    assert.equal(loadWorld(WORLD_FILE)?.id, 18);
  } finally {
    app.unmount();
  }
});
