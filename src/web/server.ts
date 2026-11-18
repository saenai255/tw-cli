// `tw web`: a local page for the two steps that need a real browser or a form:
//  1. fingerprint: runs the game's own Fingerprint2 1.8.0 (vendored copy, no CDN) with the game's
//     options in the user's browser and posts the profile here; we re-verify the hash and save it.
//  2. login: name + password posted to this process, which runs the normal portal → world login
//     (sending record_fp like the page does) and saves the session cookies.
// Safety: random token required on every request, Host header must match, JSON bodies only,
// credentials are used once and never written to disk.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { WorldConfig } from '../auth/login.ts';
import { ensureGame, selectedWorld } from '../auth/session.ts';
import { PROFILE_FILE } from '../auth/session-store.ts';
import { NET_WORLDS, worldById, worldConfig } from '../auth/worlds.ts';
import {
  type FingerprintProfile,
  FingerprintProfileError,
  readProfileRaw,
  validateProfile,
} from '../fingerprint/profile.ts';
import { errorMessage } from '../util/errors.ts';
import { obj } from '../util/json.ts';
import { page } from './page.ts';

const FP_LIB = readFileSync(new URL('./assets/fingerprint2.js', import.meta.url), 'utf8');
const MAX_BODY = 256 * 1024;

export interface WebOptions {
  host: string;
  port: number;
  profileFile?: string;
  /** Stop after a successful login. */
  exitAfterLogin?: boolean;
  log?: (msg: string) => void;
  /** Called after a fingerprint was verified and saved. */
  onFingerprint?: (fp: string) => void;
  /** Replaces the default login (the TUI passes one that keeps the opened game). */
  login?: (
    name: string,
    password: string,
    profile: FingerprintProfile,
    world: WorldConfig,
  ) => Promise<{ name: string; level: number; world: string }>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (candidate: Buffer) => {
      size += candidate.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(candidate);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Everything is served from here; nothing may be loaded from elsewhere.
    'content-security-policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

/** 18 bytes of entropy, base64url: enough that the URL cannot be guessed. */
const TOKEN_BYTES = 18;
/** Let the last HTTP response reach the browser before the process exits. */
const EXIT_DELAY_MS = 300;

async function defaultLogin(name: string, password: string, profile: FingerprintProfile, world: WorldConfig) {
  const game = await ensureGame({ world, forceLogin: true, profile, credentials: async () => ({ name, password }) });
  const character = game.bootstrap.character ?? {};
  return {
    name: String(character.name ?? '?'),
    level: Number(character.level ?? 0),
    world: String(game.bootstrap.game?.currentWorldName ?? world.name ?? world.url),
  };
}

/** Open worlds for the page's select; an env-configured world outside the list gets id 0. */
function webWorlds(current: WorldConfig): { id: number; name: string; url: string }[] {
  const worlds = NET_WORLDS.filter((world) => world.open).map((world) => ({
    id: world.id,
    name: world.name,
    url: world.url,
  }));
  if (!worlds.some((world) => world.url === current.url)) {
    worlds.unshift({ id: 0, name: current.name ?? new URL(current.url).host, url: current.url });
  }
  return worlds;
}

export function startWebServer(
  opts: WebOptions,
): Promise<{ url: string; token: string; close: () => Promise<void>; done: Promise<void> }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const profileFile = opts.profileFile ?? PROFILE_FILE;
  const log = opts.log ?? ((message: string) => console.error(message));
  const login = opts.login ?? defaultLogin;
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
  let loginRunning = false;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      // Reject requests whose Host is not this server (DNS-rebinding guard).
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      const allowed = new Set(['localhost', '127.0.0.1', '[::1]', opts.host]);
      if (!allowed.has(host) && opts.host !== '0.0.0.0') {
        return send(res, 421, 'text/plain', 'wrong host');
      }
      const auth = url.searchParams.get('t') ?? req.headers['x-tw-token'];
      if (auth !== token) {
        return send(
          res,
          403,
          'text/plain',
          'Open the exact URL printed in the terminal (it contains a one-time token).',
        );
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const existing = readProfileRaw(profileFile);
        const current = selectedWorld();
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          page({
            token,
            worlds: webWorlds(current),
            currentUrl: current.url,
            existingFp: existing?.fp ?? null,
          }),
        );
      }
      if (req.method === 'GET' && url.pathname === '/fingerprint2.js') {
        return send(res, 200, 'text/javascript; charset=utf-8', FP_LIB);
      }

      if (req.method === 'POST' && (url.pathname === '/api/fingerprint' || url.pathname === '/api/login')) {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return json(res, 415, { error: 'JSON only' });
        }
        const body = obj(JSON.parse(await readBody(req)));

        if (url.pathname === '/api/fingerprint') {
          let profile: FingerprintProfile;
          try {
            profile = validateProfile({ ...body, version: 1 });
          } catch (entry) {
            return json(res, 400, {
              error: entry instanceof FingerprintProfileError ? entry.message : 'invalid profile',
            });
          }
          const previous = readProfileRaw(profileFile)?.fp ?? null;
          mkdirSync(dirname(profileFile), { recursive: true, mode: 0o700 });
          writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
          chmodSync(profileFile, 0o600);
          log(
            `Fingerprint saved: ${profile.fp} (${profile.components.length} components)${previous && previous !== profile.fp ? `, replaced ${previous}` : ''}`,
          );
          opts.onFingerprint?.(profile.fp);
          return json(res, 200, { ok: true, fp: profile.fp, previous });
        }

        if (loginRunning) {
          return json(res, 409, { error: 'A login is already running' });
        }
        const name = String(body.name ?? '').trim();
        const password = String(body.password ?? '');
        if (!name || !password) {
          return json(res, 400, { error: 'Name and password are required' });
        }
        let profile: FingerprintProfile;
        try {
          profile = validateProfile(readProfileRaw(profileFile));
        } catch (entryValue) {
          return json(res, 400, {
            error: `Save the fingerprint first (${entryValue instanceof Error ? entryValue.message : entryValue})`,
          });
        }
        const posted = Number(body.world);
        const chosen = Number.isInteger(posted) && posted > 0 ? worldById(posted) : undefined;
        if (Number.isInteger(posted) && posted > 0 && !chosen) {
          return json(res, 400, { error: `Unknown world ${posted}` });
        }
        if (chosen && !chosen.open) {
          return json(res, 400, { error: `${chosen.name} is closed` });
        }
        const world = chosen ? worldConfig(chosen) : selectedWorld();
        loginRunning = true;
        try {
          const who = await login(name, password, profile, world);
          log(`Logged in as ${who.name} (level ${who.level}) on ${who.world}. Session saved.`);
          json(res, 200, { ok: true, ...who });
          if (opts.exitAfterLogin) {
            setTimeout(resolveDone, EXIT_DELAY_MS);
          }
        } catch (loginError) {
          json(res, 401, { error: errorMessage(loginError) });
        } finally {
          loginRunning = false;
        }
        return;
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch (requestError) {
      return json(res, 500, { error: errorMessage(requestError) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      const shownHost = opts.host === '0.0.0.0' ? 'localhost' : opts.host;
      resolve({
        url: `http://${shownHost}:${port}/?t=${token}`,
        token,
        done,
        close: () => new Promise<void>((transform) => server.close(() => transform())),
      });
    });
  });
}

/** Defaults: 127.0.0.1:7373; inside a container 0.0.0.0 so a published port reaches it (token still required). */
export function defaultWebAddress(): { host: string; port: number } {
  const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  return {
    host: process.env.TW_WEB_HOST ?? (inContainer ? '0.0.0.0' : '127.0.0.1'),
    port: Number(process.env.TW_WEB_PORT ?? 7373),
  };
}
