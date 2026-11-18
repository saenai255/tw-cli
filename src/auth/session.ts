// Gets a working game session: reuse saved cookies if game.php still accepts them, otherwise log in
// (credentials from TW_LOGIN_NAME / TW_LOGIN_PASSWORD or the caller), then save the new cookies. The world
// picked in setup (world.json) is used next time; TW_WORLD_URL overrides it.
import { type FingerprintProfile, loadProfile } from '../fingerprint/profile.ts';
import { type HostPolicy, INTERACTIVE_POLICY } from '../http/throttle.ts';
import { AuthError, type Credentials, loginToWorld, type OpenGame, openGame, type WorldConfig } from './login.ts';
import { loadSession, loadWorld, PROFILE_FILE, saveSession, saveWorld, WORLD_FILE } from './session-store.ts';
import { DEFAULT_WORLD } from './worlds.ts';

export { DEFAULT_WORLD } from './worlds.ts';

export interface EnsureOptions {
  world?: WorldConfig | undefined;
  profile?: FingerprintProfile | undefined;
  credentials?: (() => Promise<Credentials>) | undefined;
  forceLogin?: boolean | undefined;
  policy?: HostPolicy | undefined;
  sessionFile?: string | undefined;
  worldFile?: string | undefined;
  log?: ((msg: string) => void) | undefined;
}

/** The world to use: TW_WORLD_URL, else the one picked in setup, else Quebec. */
export function selectedWorld(file = WORLD_FILE): WorldConfig {
  return process.env.TW_WORLD_URL ? DEFAULT_WORLD : (loadWorld(file) ?? DEFAULT_WORLD);
}

export function envCredentials(): Credentials | null {
  const name = process.env.TW_LOGIN_NAME ?? '';
  const password = process.env.TW_LOGIN_PASSWORD ?? '';
  return name && password ? { name, password } : null;
}

/** Records the world (and its name from the page) so the next start opens the same one. */
function rememberWorld(world: WorldConfig, bootstrap: OpenGame['bootstrap'], file?: string): void {
  const name = bootstrap.game?.currentWorldName;
  saveWorld(typeof name === 'string' && name ? { ...world, name } : world, file);
}

export async function ensureGame(opts: EnsureOptions = {}): Promise<OpenGame> {
  const world = opts.world ?? selectedWorld(opts.worldFile);
  const profile = opts.profile ?? loadProfile(PROFILE_FILE);
  const policy = opts.policy ?? INTERACTIVE_POLICY;
  const log = opts.log ?? (() => {});

  if (!opts.forceLogin) {
    const jar = loadSession(world.url, opts.sessionFile);
    if (jar) {
      try {
        const game = await openGame(world, jar, profile, policy);
        saveSession(world.url, jar, opts.sessionFile);
        rememberWorld(world, game.bootstrap, opts.worldFile);
        log(`Reused saved session on ${world.name ?? new URL(world.url).host}.`);
        return game;
      } catch (err) {
        if (!(err instanceof AuthError)) {
          throw err;
        }
        log('Saved session expired; logging in again.');
      }
    }
  }

  const creds = envCredentials() ?? (opts.credentials ? await opts.credentials() : null);
  if (!creds) {
    throw new AuthError('No session and no credentials: set TW_LOGIN_NAME / TW_LOGIN_PASSWORD or run `tw login`');
  }
  const jar = await loginToWorld(world, creds, profile, policy);
  const game = await openGame(world, jar, profile, policy);
  saveSession(world.url, jar, opts.sessionFile);
  rememberWorld(world, game.bootstrap, opts.worldFile);
  log(`Logged in${world.name ? ` to ${world.name}` : ''}.`);
  return game;
}
