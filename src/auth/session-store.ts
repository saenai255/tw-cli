// Persists session cookies between runs in ~/.config/tw-cli/session.json (mode 0600), one entry per world
// host, and the world picked in setup in world.json (mode 0600). The password is never stored; only the
// cookies the game set.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Cookie, CookieJar } from '../http/cookie-jar.ts';
import { arr, entries, obj } from '../util/json.ts';
import type { WorldConfig } from './login.ts';
import { NET_LOCALE } from './worlds.ts';

export const CONFIG_DIR = process.env.TW_CLI_HOME ?? join(homedir(), '.config', 'tw-cli');
export const SESSION_FILE = join(CONFIG_DIR, 'session.json');
export const PROFILE_FILE = process.env.TW_FP_PROFILE ?? join(CONFIG_DIR, 'fingerprint-profile.json');
export const WORLD_FILE = join(CONFIG_DIR, 'world.json');

interface StoredSession {
  savedAt: string;
  cookies: Cookie[];
}

/** All worlds' sessions, keyed by game origin. */
function readSessions(file: string): Record<string, StoredSession> {
  if (!existsSync(file)) {
    return {};
  }
  try {
    const data = obj(JSON.parse(readFileSync(file, 'utf8')));
    // The old shape held one world: { worldUrl, savedAt, cookies }.
    if (typeof data.worldUrl === 'string') {
      return { [data.worldUrl]: { savedAt: String(data.savedAt ?? ''), cookies: arr(data.cookies) as Cookie[] } };
    }
    return Object.fromEntries(
      entries(obj(data.sessions)).map(([worldUrl, value]) => {
        const entry = obj(value);
        return [worldUrl, { savedAt: String(entry.savedAt ?? ''), cookies: arr(entry.cookies) as Cookie[] }];
      }),
    );
  } catch {
    return {};
  }
}

/** Saves this world's cookies, keeping the sessions of the other worlds. */
export function saveSession(worldUrl: string, jar: CookieJar, file = SESSION_FILE): void {
  const sessions = readSessions(file);
  sessions[worldUrl] = { savedAt: new Date().toISOString(), cookies: jar.toJSON() };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ sessions }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadSession(worldUrl: string, file = SESSION_FILE): CookieJar | null {
  const stored = readSessions(file)[worldUrl];
  if (!stored?.cookies.length) {
    return null;
  }
  try {
    return CookieJar.fromJSON(stored.cookies);
  } catch {
    return null;
  }
}

/** Whether cookies for this world are saved (they may still be expired). */
export const hasSession = (worldUrl: string, file = SESSION_FILE): boolean =>
  (readSessions(file)[worldUrl]?.cookies.length ?? 0) > 0;

/** Game origin from saved JSON: https only, no path. */
function origin(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The world picked last, for the next start; null when none was saved or the file is invalid. */
export function loadWorld(file = WORLD_FILE): WorldConfig | null {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const data = obj(JSON.parse(readFileSync(file, 'utf8')));
    const url = origin(data.url);
    if (!url) {
      return null;
    }
    const id = Number(data.id);
    return {
      url,
      locale: typeof data.locale === 'string' && data.locale ? data.locale : NET_LOCALE,
      id: Number.isInteger(id) && id > 0 ? id : undefined,
      name: typeof data.name === 'string' && data.name ? data.name : undefined,
    };
  } catch {
    return null;
  }
}

/** Preference only: a read-only config dir must not stop a login. */
export function saveWorld(world: WorldConfig, file = WORLD_FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const data = {
      url: world.url,
      locale: world.locale,
      ...(world.id !== undefined ? { id: world.id } : {}),
      ...(world.name ? { name: world.name } : {}),
    };
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    /* preference only */
  }
}
