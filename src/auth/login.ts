// Portal → world login, ported from tw-market src/lib/market/login.ts (same 4 steps the browser takes):
//  1. GET  https://www.the-west.net/            sets the cookies the login form expects
//  2. POST /index.php?ajax=check_login&locale=  name+password → player_id, login token, playerWorlds
//  3. POST /index.php?action=login              world_id, player_id, token → redirect to game.php?sid=…
//     A world the account cannot enter answers 200 with the portal page, not a redirect. The world picked in
//     setup is tried alone; an env-configured TW_WORLD_URL (no id) falls back to trying every account world.
//  4. GET  that URL, following redirects        sets the world's session cookies
// then openGame(): GET game.php → Player.init h + state, and record_fp like the page's fp-script.

import type { FingerprintProfile } from '../fingerprint/profile.ts';
import { recordFingerprint } from '../fingerprint/record.ts';
import { CookieJar } from '../http/cookie-jar.ts';
import { GameClient, HTML_ACCEPT, type Identity, isRedirect, send } from '../http/game-client.ts';
import { type HostPolicy, INTERACTIVE_POLICY } from '../http/throttle.ts';
import { type JsonObject, obj } from '../util/json.ts';
import { type Bootstrap, parseBootstrap } from './bootstrap.ts';

export class AuthError extends Error {}

const MAX_REDIRECTS = 4;

export interface WorldConfig {
  /** Game origin, e.g. https://en32.the-west.net */
  url: string;
  /** Portal locale, e.g. en_DK for the English market */
  locale: string;
  /** Portal world id (the key in check_login's playerWorlds), when known. */
  id?: number | undefined;
  /** Name the portal shows, e.g. Quebec. */
  name?: string | undefined;
}

export interface Credentials {
  name: string;
  password: string;
}

export function identityFrom(profile: FingerprintProfile): Identity {
  const languages = profile.languages.length ? profile.languages : ['en-US'];
  const acceptLanguage = languages
    .map((language, index) => (index === 0 ? language : `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`))
    .join(',');
  return { userAgent: profile.userAgent, acceptLanguage };
}

/** www host of the world's portal: https://en32.the-west.net → https://www.the-west.net */
export function portalUrl(worldUrl: string): string {
  const world = new URL(worldUrl);
  return `${world.protocol}//www.${world.hostname.split('.').slice(1).join('.')}`;
}

interface Account {
  playerId: number;
  token: string;
  worlds: number[];
}

async function checkLogin(
  world: WorldConfig,
  credentials: Credentials,
  jar: CookieJar,
  identity: Identity,
  policy: HostPolicy,
): Promise<Account> {
  const portal = portalUrl(world.url);
  const response = await send(
    jar,
    identity,
    `${portal}/index.php?ajax=check_login&locale=${encodeURIComponent(world.locale)}`,
    {
      method: 'POST',
      body: new URLSearchParams({ name: credentials.name, password: credentials.password }).toString(),
      referer: `${portal}/`,
      origin: portal,
      ajax: true,
    },
    policy,
  );
  const text = await response.text();
  let data: JsonObject;
  try {
    data = obj(JSON.parse(text));
  } catch {
    throw new AuthError(`Login check returned non-JSON (${text.slice(0, 80)}…)`);
  }
  const playerId = Number(data.player_id);
  if (!Number.isInteger(playerId) || playerId <= 0 || typeof data.password !== 'string' || !data.password) {
    const reason = [data.error, data.msg, data.message].find(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    throw new AuthError(`Login rejected${reason ? `: ${reason}` : ' (wrong name or password?)'}`);
  }
  const worlds = Object.keys(obj(data.playerWorlds))
    .map(Number)
    .filter((worldId) => Number.isInteger(worldId) && worldId > 0);
  return { playerId, token: data.password, worlds };
}

interface GameUrl {
  url: string | null;
  status: number;
  /** A short, token-free description of the page when it had no game URL. */
  snippet: string;
}

async function gameUrlFrom(response: Response, requestUrl: string, worldUrl: string): Promise<GameUrl> {
  const location = response.headers.get('location');
  if (location) {
    await response.body?.cancel().catch(() => {});
    return { url: new URL(location, requestUrl).href, status: response.status, snippet: '' };
  }
  const text = await response.text();
  // The portal has returned both relative and JSON-escaped game URLs. Prefer the game host as the base for a
  // relative one: an interstitial served by the portal still names a page on the world.
  const match = /game\.php\?[^"'\s<>]*sid=[^"'\s<>]+/i.exec(text.replace(/\\\//g, '/'));
  // The login form is what a rejected token gets; its visible navigation text is not a useful error.
  const startPage = /id=["']?(?:loginForm|selectWorld)\b|Auth\.checkLogin/i.test(text);
  const visible = startPage
    ? 'the portal start page (login token not accepted)'
    : text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, ' $1 ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\b[0-9a-f]{32,}\b/gi, '[token]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
  return {
    url: match ? new URL(match[0].replace(/&amp;/g, '&'), worldUrl).href : null,
    status: response.status,
    snippet: visible,
  };
}

type EnterWorld = { entered: true } | { entered: false; detail?: string };

async function enterWorld(
  world: WorldConfig,
  jar: CookieJar,
  identity: Identity,
  account: Account,
  portalWorldId: number,
  policy: HostPolicy,
): Promise<EnterWorld> {
  const portal = portalUrl(world.url);
  const worldHost = new URL(world.url).host;
  const response = await send(
    jar,
    identity,
    `${portal}/index.php?action=login`,
    {
      method: 'POST',
      body: new URLSearchParams({
        world_id: String(portalWorldId),
        player_id: String(account.playerId),
        password: account.token,
        set_cookie: '1',
      }).toString(),
      referer: `${portal}/`,
      origin: portal,
    },
    policy,
  );
  const game = await gameUrlFrom(response, `${portal}/index.php`, world.url);
  if (!game.url) {
    return {
      entered: false,
      detail: `world ${portalWorldId}: HTTP ${game.status}${game.snippet ? ` — ${game.snippet}` : ''}`,
    };
  }
  if (new URL(game.url).host !== worldHost) {
    return { entered: false };
  }

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const redirect = await send(jar, identity, game.url, { referer: `${portal}/` }, policy);
    const location = redirect.headers.get('location');
    await redirect.body?.cancel().catch(() => {});
    if (!isRedirect(redirect.status) || !location) {
      return { entered: true };
    }
    game.url = new URL(location, game.url).href;
    if (new URL(game.url).host !== worldHost) {
      throw new AuthError(`Game sent the login back to ${new URL(game.url).host}: login failed`);
    }
  }
  throw new AuthError('Too many redirects while entering the game');
}

/** Steps 1–4. Returns a jar holding the world's session cookies. */
export async function loginToWorld(
  world: WorldConfig,
  credentials: Credentials,
  profile: FingerprintProfile,
  policy: HostPolicy = INTERACTIVE_POLICY,
): Promise<CookieJar> {
  const jar = new CookieJar();
  const identity = identityFrom(profile);
  const portalPage = await send(jar, identity, `${portalUrl(world.url)}/`, {}, policy);
  await portalPage.body?.cancel().catch(() => {});

  const account = await checkLogin(world, credentials, jar, identity, policy);
  const label = world.name ? `${world.name} (${new URL(world.url).host})` : new URL(world.url).host;
  // A world chosen from the dropdown is entered only when the account has it; without an id (a plain
  // TW_WORLD_URL) every account world is tried and only the one answering on the configured host counts.
  if (world.id !== undefined && !account.worlds.includes(world.id)) {
    throw new AuthError(`This account has no character on ${label}, world ${world.id}`);
  }
  // One at a time: each attempt rewrites the jar's session cookies. A world that answers with a portal page
  // (closed, inaccessible, or simply not this account's) must not stop the others from being tried.
  const failures: string[] = [];
  for (const worldId of world.id !== undefined ? [world.id] : account.worlds) {
    const attempt = await enterWorld(world, jar, identity, account, worldId, policy);
    if (attempt.entered) {
      return jar;
    }
    if (attempt.detail) {
      failures.push(attempt.detail);
    }
  }
  if (failures.length) {
    throw new AuthError(`Login did not lead to the game (${failures.join('; ')})`);
  }
  throw new AuthError(`This account has no character on ${label}`);
}

export interface OpenGame {
  client: GameClient;
  bootstrap: Bootstrap;
}

/**
 * Loads game.php with the session cookies (what a page load does), parses the bootstrap state, and
 * sends anti_cheat/record_fp exactly as the page's fp-script would.
 */
export async function openGame(
  world: WorldConfig,
  jar: CookieJar,
  profile: FingerprintProfile,
  policy: HostPolicy = INTERACTIVE_POLICY,
): Promise<OpenGame> {
  const identity = identityFrom(profile);
  const response = await send(
    jar,
    identity,
    `${world.url}/game.php`,
    { accept: HTML_ACCEPT, referer: `${portalUrl(world.url)}/` },
    policy,
  );
  if (isRedirect(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw new AuthError(`Game redirected to ${response.headers.get('location') ?? 'the start page'}: session expired`);
  }
  const bootstrap = parseBootstrap(await response.text());
  const client = new GameClient({ worldUrl: world.url, h: bootstrap.h, jar, identity, policy });
  await recordFingerprint(client, profile);
  return { client, bootstrap };
}
