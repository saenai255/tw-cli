// Setup screen inside the TUI: everything `tw web` / `tw fp …` / `tw login` can do.

import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Box, Text, useInput, useWindowSize } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { OpenGame, WorldConfig } from '../auth/login.ts';
import { ensureGame, selectedWorld } from '../auth/session.ts';
import { hasSession, PROFILE_FILE, saveWorld } from '../auth/session-store.ts';
import { NET_WORLDS, type NetWorld, worldConfig } from '../auth/worlds.ts';
import {
  type FingerprintProfile,
  loadProfile,
  readProfileRaw,
  validateProfile,
  writeProfileFields,
} from '../fingerprint/profile.ts';
import type { HostPolicy } from '../http/throttle.ts';
import { errorMessage } from '../util/errors.ts';
import { defaultWebAddress, startWebServer } from '../web/server.ts';
import { scrollWindow, truncate } from './format.ts';

const createElement = React.createElement;

type Field = 'fp' | 'ua' | 'import' | 'name' | 'password';

const PROMPTS: Record<Field, string> = {
  fp: 'Fingerprint hash (32 hex chars)',
  ua: 'Browser User-Agent (navigator.userAgent)',
  import: 'Path to a profile JSON from capture-fingerprint.js',
  name: 'Account name',
  password: 'Password',
};

interface ProfileStatus {
  ok: boolean;
  fp?: string | undefined;
  detail: string;
}

function profileStatus(): ProfileStatus {
  const raw = readProfileRaw(PROFILE_FILE);
  if (!raw) {
    return { ok: false, detail: 'none saved' };
  }
  try {
    const profileValue = validateProfile(raw as FingerprintProfile);
    return {
      ok: true,
      fp: profileValue.fp,
      detail: profileValue.components.length
        ? `${profileValue.components.length} components, verified`
        : 'hash only (not re-verifiable)',
    };
  } catch (entry) {
    return { ok: false, fp: raw.fp, detail: errorMessage(entry) };
  }
}

export interface SetupProps {
  onReady: (game: OpenGame) => void;
  onBack?: (() => void) | undefined;
  onQuit: () => void;
  message?: string | undefined;
  /** Request pacing override (tests). */
  policy?: HostPolicy | undefined;
}

export function SetupScreen({ onReady, onBack, onQuit, message, policy }: SetupProps) {
  const [, setVersion] = useState(0);
  const refresh = () => setVersion((currentValue) => currentValue + 1);
  const [field, setField] = useState<Field | null>(null);
  const [inputBuffer, setInputBuffer] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; bad?: boolean } | null>(
    message ? { text: message, bad: true } : null,
  );
  const [web, setWeb] = useState<{ url: string; host: string; port: number } | null>(null);
  const webRef = useRef<{ close: () => Promise<void> } | null>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const { columns, rows } = useWindowSize();
  const [pickingWorld, setPickingWorld] = useState(false);
  const [worldPick, setWorldPick] = useState(0);
  const [worldFilter, setWorldFilter] = useState('');
  const [worldFiltering, setWorldFiltering] = useState(false);

  useEffect(() => () => void webRef.current?.close(), []);

  const world = selectedWorld();
  const worldHost = new URL(world.url).host;
  // An env-configured TW_WORLD_URL is not in the list: show it first, still selectable.
  const worlds: NetWorld[] = NET_WORLDS.some((entry) => entry.url === world.url)
    ? NET_WORLDS
    : [{ id: world.id ?? 0, name: world.name ?? worldHost, url: world.url, open: true }, ...NET_WORLDS];
  const wanted = worldFilter.trim().toLowerCase();
  const shownWorlds = wanted
    ? worlds.filter(
        (entry) =>
          entry.name.toLowerCase().includes(wanted) || String(entry.id) === wanted || entry.url.includes(wanted),
      )
    : worlds;
  const worldIndex = Math.max(0, Math.min(worldPick, shownWorlds.length - 1));
  const status = profileStatus();
  const haveSession = hasSession(world.url);

  const finish = (game: OpenGame) => {
    void webRef.current?.close();
    webRef.current = null;
    readyRef.current(game);
  };

  const doLogin = async (name: string, password: string) => {
    setBusy(true);
    setStatusMessage({ text: 'Logging in… (requests are paced, a few seconds)' });
    try {
      const profile = loadProfile(PROFILE_FILE);
      const game = await ensureGame({
        world,
        forceLogin: true,
        profile,
        policy,
        credentials: async () => ({ name, password }),
      });
      finish(game);
    } catch (entry) {
      setStatusMessage({ text: errorMessage(entry), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const doContinue = async () => {
    setBusy(true);
    setStatusMessage({ text: 'Connecting with the saved session…' });
    try {
      const game = await ensureGame({
        world,
        policy,
        credentials: async () => {
          throw new Error('Saved session expired. Log in with l.');
        },
      });
      finish(game);
    } catch (entry) {
      setStatusMessage({ text: errorMessage(entry), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const toggleWeb = async () => {
    if (webRef.current) {
      await webRef.current.close();
      webRef.current = null;
      setWeb(null);
      setStatusMessage({ text: 'Browser setup page stopped.' });
      return;
    }
    const addr = defaultWebAddress();
    try {
      const server = await startWebServer({
        ...addr,
        log: () => {},
        onFingerprint: (fp) => {
          setStatusMessage({ text: `Fingerprint ${fp} saved from the browser.` });
          refresh();
        },
        login: async (name, password, profile, worldValue: WorldConfig) => {
          const game = await ensureGame({
            world: worldValue,
            forceLogin: true,
            profile,
            policy,
            credentials: async () => ({ name, password }),
          });
          setTimeout(() => finish(game), 300);
          const json = game.bootstrap.character ?? {};
          return {
            name: String(json.name ?? '?'),
            level: Number(json.level ?? 0),
            world: String(game.bootstrap.game?.currentWorldName ?? worldValue.name ?? worldValue.url),
          };
        },
      });
      webRef.current = server;
      setWeb({ url: server.url, ...addr });
      setStatusMessage({ text: 'Open the URL below in your browser. Fingerprint and login there update this screen.' });
    } catch (entry) {
      setStatusMessage({ text: `Could not start the page: ${errorMessage(entry)}`, bad: true });
    }
  };

  const submit = (currentValue: Field, value: string) => {
    try {
      if (currentValue === 'fp') {
        writeProfileFields(PROFILE_FILE, { fp: value.trim().toLowerCase() });
        setStatusMessage({ text: 'Fingerprint saved (hash only).' });
      } else if (currentValue === 'ua') {
        writeProfileFields(PROFILE_FILE, { userAgent: value.trim() });
        setStatusMessage({ text: 'User-Agent saved.' });
      } else if (currentValue === 'import') {
        const path = value.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
        const profileValue = loadProfile(path);
        mkdirSync(dirname(PROFILE_FILE), { recursive: true, mode: 0o700 });
        copyFileSync(path, PROFILE_FILE);
        chmodSync(PROFILE_FILE, 0o600);
        setStatusMessage({
          text: `Imported fingerprint ${profileValue.fp} (${profileValue.components.length} components).`,
        });
      } else if (currentValue === 'name') {
        setAccount(value.trim());
        setField('password');
        setInputBuffer('');
        return;
      } else if (currentValue === 'password') {
        setField(null);
        setInputBuffer('');
        void doLogin(account, value);
        return;
      }
    } catch (entry) {
      setStatusMessage({ text: errorMessage(entry), bad: true });
    }
    setField(null);
    setInputBuffer('');
    refresh();
  };

  const openWorldPicker = () => {
    setWorldPick(
      Math.max(
        0,
        worlds.findIndex((entry) => entry.url === world.url),
      ),
    );
    setWorldFilter('');
    setWorldFiltering(false);
    setPickingWorld(true);
  };

  const chooseWorld = (entry: NetWorld) => {
    if (!entry.open) {
      setStatusMessage({ text: `${entry.name} is closed; pick an open world.`, bad: true });
      return;
    }
    saveWorld(worldConfig(entry));
    setPickingWorld(false);
    setStatusMessage({
      text: `World ${entry.name} selected (${entry.url}).${process.env.TW_WORLD_URL ? ' TW_WORLD_URL still overrides it; unset it to use this.' : ''}`,
    });
    refresh();
  };

  useInput((input, key) => {
    if (pickingWorld) {
      if (worldFiltering) {
        if (key.return || key.escape) {
          setWorldFiltering(false);
          if (key.escape) {
            setWorldFilter('');
          }
          setWorldPick(0);
        } else if (key.backspace || key.delete) {
          setWorldFilter((value) => value.slice(0, -1));
          setWorldPick(0);
        } else if (input && !key.ctrl && !key.meta && !key.return) {
          setWorldFilter((value) => value + input);
          setWorldPick(0);
        }
        return;
      }
      if (key.escape) {
        return setPickingWorld(false);
      }
      if (input === '/') {
        return setWorldFiltering(true);
      }
      if (key.upArrow || input === 'k') {
        return setWorldPick(Math.max(0, worldIndex - 1));
      }
      if (key.downArrow || input === 'j') {
        return setWorldPick(Math.max(0, Math.min(shownWorlds.length - 1, worldIndex + 1)));
      }
      if (key.pageUp) {
        return setWorldPick(Math.max(0, worldIndex - 10));
      }
      if (key.pageDown) {
        return setWorldPick(Math.max(0, Math.min(shownWorlds.length - 1, worldIndex + 10)));
      }
      const entry = shownWorlds[worldIndex];
      if (entry && (input === ' ' || key.return)) {
        return chooseWorld(entry);
      }
      return;
    }
    if (field) {
      if (key.escape) {
        setField(null);
        setInputBuffer('');
      } else if (key.return) {
        submit(field, inputBuffer);
      } else if (key.backspace || key.delete) {
        setInputBuffer((value) => value.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setInputBuffer((value) => value + input);
      }
      return;
    }
    if (busy) {
      return;
    }
    if (input === 'q') {
      return onQuit();
    }
    if (key.escape && onBack) {
      return onBack();
    }
    if (input === 'o') {
      return openWorldPicker();
    }
    if (input === 'w') {
      return void toggleWeb();
    }
    if (input === 'f') {
      return setField('fp');
    }
    if (input === 'a') {
      return setField('ua');
    }
    if (input === 'i') {
      return setField('import');
    }
    if (input === 'l') {
      if (!status.ok) {
        return setStatusMessage({ text: 'Set up the fingerprint first (w, f/a or i).', bad: true });
      }
      setInputBuffer('');
      return setField('name');
    }
    if (input === 'c' && haveSession && status.ok) {
      return void doContinue();
    }
  });

  if (pickingWorld) {
    const width = Math.min(columns || 80, 100);
    const height = Math.min(rows || 24, 24);
    const [start, end] = scrollWindow(worldIndex, shownWorlds.length, Math.max(3, height - 4));
    const openCount = worlds.filter((entry) => entry.open).length;
    const nameWidth = Math.max(10, Math.min(24, width - 30));
    const heading = worldFiltering
      ? `Worlds  filter: ${worldFilter}▏`
      : worldFilter
        ? `Worlds  (filter: ${worldFilter})`
        : `Worlds · ${openCount} open, ${worlds.length - openCount} closed`;
    return createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', width, height, paddingX: 1 },
      createElement(Text, { bold: true, color: 'yellow', wrap: 'truncate' }, heading),
      createElement(
        Text,
        { dimColor: true, wrap: 'truncate' },
        worldFiltering
          ? 'type to filter · Enter done · Esc clear'
          : 'Enter / Space select · / filter · j k move · Esc back',
      ),
      ...shownWorlds.slice(start, end).map((entry, offset) => {
        const index = start + offset;
        const current = entry.url === world.url;
        return createElement(
          Text,
          { key: entry.url, inverse: index === worldIndex, dimColor: !entry.open, wrap: 'truncate' },
          `${current ? '●' : ' '} ${entry.open ? ' ' : '×'} ${truncate(entry.name, nameWidth)} ${new URL(entry.url).host.padEnd(18)}${entry.open ? '' : ' closed'}`,
        );
      }),
      shownWorlds.length ? null : createElement(Text, { dimColor: true }, 'No world matches that filter.'),
      statusMessage
        ? createElement(Text, { color: statusMessage.bad ? 'red' : 'green', wrap: 'wrap' }, statusMessage.text)
        : null,
    );
  }

  const item = (entryKey: string, label: string, enabled = true) =>
    createElement(
      Text,
      { key: entryKey, dimColor: !enabled },
      createElement(Text, { color: enabled ? 'yellow' : 'gray', bold: true }, ` ${entryKey} `),
      ` ${label}`,
    );

  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 2, paddingY: 0 },
    createElement(Text, { bold: true, color: 'yellow' }, 'Setup · fingerprint & login'),
    createElement(
      Text,
      { dimColor: true },
      `World  ${world.name ?? worldHost} · ${worldHost} · ${world.locale}${process.env.TW_WORLD_URL ? ' · TW_WORLD_URL override' : ''}`,
    ),
    createElement(Text, null, ' '),
    createElement(
      Text,
      null,
      'Fingerprint  ',
      status.ok
        ? createElement(Text, { color: 'green' }, `✔ ${status.fp}`)
        : createElement(Text, { color: 'red' }, `✘ ${status.fp ?? ''}`),
      createElement(Text, { dimColor: true }, `  ${status.detail}`),
    ),
    createElement(
      Text,
      null,
      'Session      ',
      haveSession
        ? createElement(Text, { color: 'green' }, 'saved for this world')
        : createElement(Text, { color: 'red' }, 'none for this world'),
      createElement(Text, { dimColor: true }, haveSession ? '  (c to continue with it)' : ''),
    ),
    createElement(Text, null, ' '),
    createElement(Text, { bold: true }, 'World'),
    item('o', 'choose a .net world (all worlds)'),
    createElement(Text, { bold: true }, 'Fingerprint'),
    item('w', web ? 'stop the browser setup page' : 'open a setup page in your browser (fingerprint + login)'),
    item('f', 'type a fingerprint hash'),
    item('a', 'type the browser User-Agent'),
    item('i', 'import a profile JSON file'),
    createElement(Text, { bold: true }, 'Account'),
    item('l', 'log in here (name + password)', status.ok),
    item('c', 'continue with the saved session', haveSession && status.ok),
    onBack ? item('Esc', 'back to the game') : null,
    item('q', 'quit'),
    web
      ? createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          createElement(Text, null, 'Browser page: ', createElement(Text, { color: 'cyan', bold: true }, web.url)),
          web.host === '0.0.0.0'
            ? createElement(
                Text,
                { dimColor: true },
                `Running in a container: port ${web.port} must be published (compose: ports "127.0.0.1:${web.port}:${web.port}", run with --service-ports).`,
              )
            : null,
        )
      : null,
    field
      ? createElement(
          Box,
          { marginTop: 1 },
          createElement(Text, { color: 'cyan' }, `${PROMPTS[field]}: `),
          createElement(Text, null, field === 'password' ? '•'.repeat(inputBuffer.length) : inputBuffer),
          createElement(Text, { inverse: true }, ' '),
          createElement(Text, { dimColor: true }, '  Enter save · Esc cancel'),
        )
      : null,
    statusMessage
      ? createElement(
          Text,
          { color: statusMessage.bad ? 'red' : busy ? 'yellow' : 'green', wrap: 'wrap' },
          statusMessage.text,
        )
      : null,
  );
}
