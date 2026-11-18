#!/usr/bin/env node
// Entry point. Commands:
//   tw fp import <file>   validate a captured fingerprint profile and install it
//   tw fp set <hash>      save a hash-only fingerprint (copied from the browser console)
//   tw fp ua "<UA>" [langs] set the browser User-Agent (and languages, e.g. en-US,en)
//   tw fp show            show the installed profile summary
//   tw login [world]      log in to a world by name or portal id (prompts for name/password unless
//                         TW_LOGIN_NAME/PASSWORD set); without an argument the world picked last is used
//   tw worlds             list the .net worlds
//   tw whoami             show character status (reuses the saved session)
//   tw [play]             full-screen TUI (setup, jobs, task queue, map)
//   tw web                local browser page for fingerprint capture and login
//   tw jobs [filter]      list doable jobs with nearest location and travel time
//   tw queue              show the task queue
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Credentials, WorldConfig } from './auth/login.ts';
import { ensureGame, selectedWorld } from './auth/session.ts';
import { PROFILE_FILE } from './auth/session-store.ts';
import { NET_WORLDS, worldByName, worldConfig } from './auth/worlds.ts';
import { loadProfile, readProfileRaw, writeProfileFields } from './fingerprint/profile.ts';
import { GameState } from './game/state.ts';
import { queueSummary } from './game/tasks.ts';
import { formatClock, formatDuration } from './tui/format.ts';
import { obj } from './util/json.ts';

function ask(question: string, echo = true): Promise<string> {
  return new Promise((resolve) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!echo) {
      // Interface._writeToOutput is internal (not in the typings): echo the prompt, not the typed password.
      Object.assign(readline, {
        _writeToOutput: (written: string) => {
          if (written.startsWith(question)) {
            process.stdout.write(question);
          }
        },
      });
    }
    readline.question(question, (answer) => {
      readline.close();
      if (!echo) {
        process.stdout.write('\n');
      }
      resolve(answer);
    });
  });
}

const askSecret = (question: string): Promise<string> => ask(question, false);

async function promptCredentials(): Promise<Credentials> {
  const name = await ask('Account name: ');
  const password = await askSecret('Password: ');
  return { name, password };
}

const log = (message: string) => console.error(message);

const openWorldList = (): string =>
  NET_WORLDS.filter((world) => world.open)
    .map((world) => `${world.name} (${world.id})`)
    .join(', ');

/** A world from `tw login <name|id>`; a closed world is refused with the open ones listed. */
function chosenWorld(input: string): WorldConfig {
  const world = worldByName(input);
  if (!world) {
    throw new Error(`Unknown world "${input}". Open .net worlds: ${openWorldList()}`);
  }
  if (!world.open) {
    throw new Error(`${world.name} is closed. Open .net worlds: ${openWorldList()}`);
  }
  return worldConfig(world);
}

async function openState(): Promise<GameState> {
  const game = await ensureGame({ credentials: promptCredentials, log });
  return new GameState(game, () => ensureGame({ credentials: promptCredentials }));
}

async function main(argv: string[]): Promise<number> {
  const [command, subcommand, argument] = argv;
  switch (command) {
    case undefined:
    case 'play': {
      // Setup (fingerprint, login) happens inside the TUI when needed.
      const { runRoot } = await import('./tui/root.ts');
      await runRoot();
      return 0;
    }
    case 'web': {
      const { defaultWebAddress, startWebServer } = await import('./web/server.ts');
      const address = defaultWebAddress();
      const server = await startWebServer({
        ...address,
        exitAfterLogin: true,
        log: (message) => console.log(message),
      });
      console.log(`Open in your browser:\n  ${server.url}\n`);
      if (address.host === '0.0.0.0') {
        console.log(
          `(In a container: port ${address.port} must be published to the host, e.g. compose ports "127.0.0.1:${address.port}:${address.port}" and run with --service-ports.)`,
        );
      }
      console.log('Waiting for fingerprint and login… Ctrl+C to stop.');
      await server.done;
      await server.close();
      return 0;
    }
    case 'jobs': {
      const state = await openState();
      await state.loadJobs();
      for (const entry of state.log.filter((logEntry) => logEntry.level === 'error')) {
        console.error(entry.msg);
      }
      for (const option of state.jobOptions(subcommand ?? '')) {
        console.log(
          `${String(option.job.id).padStart(4)}  ${option.job.name.padEnd(36)} ${String(option.job.laborPoints).padStart(5)} LP  ${option.at ? `${option.at.x},${option.at.y}`.padEnd(12) : '—'.padEnd(12)} ${option.way === null ? '' : formatDuration(option.way)}`,
        );
      }
      return 0;
    }
    case 'queue': {
      const state = await openState();
      const now = state.clock.now();
      if (!state.queue.length) {
        console.log('Task queue is empty.');
      }
      state.queue.forEach((task, index) => {
        const walk = task.way ? `  walk ${formatDuration(task.way.end - Math.max(now, task.way.start))}` : '';
        console.log(
          `${index + 1}. [${task.type}] ${task.title} at ${task.coords.x},${task.coords.y}${walk}  ends in ${formatDuration(task.end - now)}`,
        );
      });
      const summary = queueSummary(state.queue, now);
      if (summary) {
        console.log(
          `All done ${formatClock(summary.doneAt, now)} (in ${formatDuration(summary.left)})${summary.walk > 0 ? `, ${formatDuration(summary.walk)} of it walking` : ''}`,
        );
      }
      return 0;
    }
    case 'fp': {
      if (subcommand === 'import' && argument) {
        const profile = loadProfile(argument); // validates (recomputes hash)
        mkdirSync(dirname(PROFILE_FILE), { recursive: true, mode: 0o700 });
        copyFileSync(argument, PROFILE_FILE);
        chmodSync(PROFILE_FILE, 0o600);
        console.log(
          `Fingerprint profile OK (fp=${profile.fp}, ${profile.components.length} components). Installed to ${PROFILE_FILE}`,
        );
        return 0;
      }
      if (subcommand === 'set' && argument) {
        const profile = writeProfileFields(PROFILE_FILE, { fp: argument.trim().toLowerCase() });
        console.log(`Saved fingerprint ${profile.fp} (hash-only) to ${PROFILE_FILE}`);
        if (!profile.userAgent) {
          console.log('Next: tw fp ua "<navigator.userAgent from the same browser>"');
        }
        return 0;
      }
      if (subcommand === 'ua' && argument) {
        const languages = argv[3]
          ?.split(',')
          .map((language) => language.trim())
          .filter(Boolean);
        writeProfileFields(PROFILE_FILE, {
          userAgent: argument,
          ...(languages ? { languages } : {}),
        });
        console.log(`Saved User-Agent${languages ? ' and languages' : ''} to ${PROFILE_FILE}`);
        return 0;
      }
      if (subcommand === 'show') {
        const profile = readProfileRaw(PROFILE_FILE);
        if (!profile) {
          throw new Error(`No fingerprint profile at ${PROFILE_FILE}`);
        }
        const componentNames = profile.components?.length
          ? profile.components.map((component) => component.key).join(',')
          : '(none: hash-only, not re-verifiable)';
        console.log(
          `fp=${profile.fp}\nsaved=${profile.capturedAt}\nuserAgent=${profile.userAgent || '(missing)'}\nlanguages=${(profile.languages ?? []).join(',')}\ncomponents=${componentNames}`,
        );
        return 0;
      }
      break;
    }
    case 'login': {
      const world = subcommand ? chosenWorld(subcommand) : undefined;
      const game = await ensureGame({ world, forceLogin: true, credentials: promptCredentials, log });
      const name = String(game.bootstrap.game?.currentWorldName ?? world?.name ?? game.client.worldUrl);
      console.log(`Logged in to ${name} (${game.client.worldUrl}) as ${game.bootstrap.character?.name ?? '?'}`);
      return 0;
    }
    case 'worlds': {
      const current = selectedWorld();
      for (const world of NET_WORLDS) {
        const marker = world.url === current.url ? '*' : ' ';
        console.log(
          `${marker} ${String(world.id).padStart(2)}  ${world.name.padEnd(17)} ${world.url.padEnd(30)} ${world.open ? 'open' : 'closed'}`,
        );
      }
      return 0;
    }
    case 'whoami':
    case 'status': {
      const { bootstrap } = await ensureGame({ credentials: promptCredentials, log });
      const character = bootstrap.character ?? {};
      const world = selectedWorld();
      console.log(
        [
          `${character.name} (level ${character.level}, ${String(obj(character.charClass).type ?? '?')}) on ${String(bootstrap.game?.currentWorldName ?? world.name ?? world.url)}`,
          `HP ${character.health}/${character.maxHealth ?? '?'}  Energy ${character.energy}/${character.maxEnergy}  XP ${character.experience}`,
          `$${character.cash} cash, $${character.deposit} bank  Nuggets ${character.nuggets}`,
          `Position ${String(obj(character.pos).x)},${String(obj(character.pos).y)}  Tasks queued ${Array.isArray(character.taskQueue) ? character.taskQueue.length : '?'}/${character.taskLimit}`,
        ].join('\n'),
      );
      return 0;
    }
  }
  console.error(
    'usage: tw [play] | tw web | tw jobs [filter] | tw queue | tw login [world] | tw worlds | tw whoami | tw fp import <file> | tw fp set <hash> | tw fp ua "<UA>" [langs] | tw fp show',
  );
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  },
);
