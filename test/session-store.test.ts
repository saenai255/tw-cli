import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DEFAULT_WORLD, selectedWorld } from '../src/auth/session.ts';
import { loadSession, loadWorld, saveSession, saveWorld } from '../src/auth/session-store.ts';
import { type Cookie, CookieJar } from '../src/http/cookie-jar.ts';

const ARIZONA = 'https://en13.the-west.net';
const QUEBEC = 'https://en32.the-west.net';

const cookie = (host: string, value: string): Cookie => ({ name: 'sid', value, domain: host, hostOnly: true });
const jar = (host: string, value: string): CookieJar => CookieJar.fromJSON([cookie(host, value)]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twcli-session-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('session.json keeps one session per world', () => {
  const file = join(dir, 'session.json');
  saveSession(ARIZONA, jar('en13.the-west.net', 'arizona'), file);
  saveSession(QUEBEC, jar('en32.the-west.net', 'quebec'), file);

  assert.equal(loadSession(ARIZONA, file)?.header(ARIZONA), 'sid=arizona');
  assert.equal(loadSession(QUEBEC, file)?.header(QUEBEC), 'sid=quebec');
  assert.equal(loadSession('https://en14.the-west.net', file), null);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { sessions: Record<string, unknown> };
  assert.deepEqual(Object.keys(saved.sessions).sort(), [ARIZONA, QUEBEC].sort());
});

test('the old single-world session.json is read, kept and migrated on the next save', () => {
  const file = join(dir, 'session.json');
  writeFileSync(
    file,
    JSON.stringify({ worldUrl: ARIZONA, savedAt: 'old', cookies: [cookie('en13.the-west.net', 'legacy')] }),
  );
  assert.equal(loadSession(ARIZONA, file)?.header(ARIZONA), 'sid=legacy');

  saveSession(QUEBEC, jar('en32.the-west.net', 'new'), file);
  assert.equal(loadSession(ARIZONA, file)?.header(ARIZONA), 'sid=legacy', 'the old world is not lost');
  assert.equal(loadSession(QUEBEC, file)?.header(QUEBEC), 'sid=new');
});

test('selectedWorld uses world.json unless TW_WORLD_URL overrides it', () => {
  const file = join(dir, 'world.json');
  assert.deepEqual(selectedWorld(file), DEFAULT_WORLD);
  saveWorld({ url: ARIZONA, locale: 'en_DK', id: 18, name: 'Arizona' }, file);
  const chosen = selectedWorld(file);
  if (process.env.TW_WORLD_URL) {
    assert.equal(chosen.url, DEFAULT_WORLD.url);
  } else {
    assert.equal(chosen.url, ARIZONA);
    assert.equal(chosen.id, 18);
  }
});

test('world.json round-trips, keeps optional ids/names, is 0600 and ignores invalid files', () => {
  const file = join(dir, 'world.json');
  assert.equal(loadWorld(file), null);
  saveWorld({ url: ARIZONA, locale: 'en_DK', id: 18, name: 'Arizona' }, file);
  assert.deepEqual(loadWorld(file), { url: ARIZONA, locale: 'en_DK', id: 18, name: 'Arizona' });
  assert.equal(statSync(file).mode & 0o777, 0o600);

  saveWorld({ url: QUEBEC, locale: 'en_DK' }, file);
  const bare = loadWorld(file);
  assert.equal(bare?.url, QUEBEC);
  assert.equal(bare?.id, undefined);
  assert.equal(bare?.name, undefined);

  writeFileSync(file, JSON.stringify({ url: 'http://en32.the-west.net' }));
  assert.equal(loadWorld(file), null, 'https only');
  writeFileSync(file, 'not json');
  assert.equal(loadWorld(file), null);
});
