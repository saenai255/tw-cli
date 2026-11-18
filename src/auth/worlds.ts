// The .net worlds, hardcoded: the portal world id (check_login's playerWorlds key, posted as world_id) and the
// game host. Portal ids are not host numbers (Arizona is 18 → en13, Quebec 38 → en32).
//
// Snapshot 2026-11-18. To refresh, read the world list in https://www.the-west.net/ (the second argument of
// WestMaster.init: world_id, name, player_count, register, login) and the host of each world from its relog
// redirect: curl -sI https://enNN.the-west.net/game.php → …?action=relog&world_id=…
// Closed worlds stay in the list (shown, not selectable) until they are removed from the portal.

import type { WorldConfig } from './login.ts';

export interface NetWorld {
  /** Portal world id, e.g. 38 for Quebec. */
  id: number;
  name: string;
  /** Game origin, e.g. https://en32.the-west.net. */
  url: string;
  /** Whether the portal currently lets players enter it. */
  open: boolean;
}

/** All .net worlds share the portal https://www.the-west.net and this locale. */
export const NET_LOCALE = 'en_DK';

export const NET_WORLDS: NetWorld[] = [
  { id: 18, name: 'Arizona', url: 'https://en13.the-west.net', open: true },
  { id: 19, name: 'Briscoe', url: 'https://en14.the-west.net', open: true },
  { id: 20, name: 'Colorado', url: 'https://en15.the-west.net', open: true },
  { id: 21, name: 'Dakota', url: 'https://en16.the-west.net', open: true },
  { id: 22, name: 'El Dorado', url: 'https://en17.the-west.net', open: true },
  { id: 23, name: 'Halloween Speed', url: 'https://en18.the-west.net', open: false },
  { id: 24, name: 'Fairbank', url: 'https://en19.the-west.net', open: true },
  { id: 28, name: 'Idaho', url: 'https://en22.the-west.net', open: true },
  { id: 29, name: 'Juárez', url: 'https://en23.the-west.net', open: true },
  { id: 31, name: 'Shorts #3', url: 'https://en24.the-west.net', open: false },
  { id: 32, name: 'Kansas', url: 'https://en26.the-west.net', open: true },
  { id: 33, name: 'Las Vegas', url: 'https://en27.the-west.net', open: true },
  { id: 34, name: 'Montana', url: 'https://en28.the-west.net', open: true },
  { id: 35, name: 'Navajo', url: 'https://en29.the-west.net', open: true },
  { id: 36, name: 'Ozarks', url: 'https://en30.the-west.net', open: true },
  { id: 37, name: 'Phoenix', url: 'https://en31.the-west.net', open: true },
  { id: 38, name: 'Quebec', url: 'https://en32.the-west.net', open: true },
];

export const OPEN_WORLDS: NetWorld[] = NET_WORLDS.filter((world) => world.open);

const QUEBEC = NET_WORLDS.find((world) => world.id === 38);

/** Where to log in when nothing is saved: Quebec, or the TW_WORLD_URL / TW_LOCALE override. */
export const DEFAULT_WORLD: WorldConfig = process.env.TW_WORLD_URL
  ? { url: process.env.TW_WORLD_URL, locale: process.env.TW_LOCALE ?? NET_LOCALE }
  : {
      url: QUEBEC?.url ?? 'https://en32.the-west.net',
      locale: process.env.TW_LOCALE ?? NET_LOCALE,
      id: QUEBEC?.id ?? 38,
      name: QUEBEC?.name ?? 'Quebec',
    };

/** The config for a world in this list. */
export const worldConfig = (world: NetWorld): WorldConfig => ({
  url: world.url,
  locale: process.env.TW_LOCALE ?? NET_LOCALE,
  id: world.id,
  name: world.name,
});

export const worldById = (id: number): NetWorld | undefined => NET_WORLDS.find((world) => world.id === id);

/** Lowercase without accents, so "Juarez" finds "Juárez". */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

/** A world by id, exact name or a unique name prefix (case and accents do not matter). */
export function worldByName(input: string): NetWorld | undefined {
  const wanted = fold(input);
  if (!wanted) {
    return undefined;
  }
  const exact = NET_WORLDS.find((world) => fold(world.name) === wanted || String(world.id) === wanted);
  if (exact) {
    return exact;
  }
  const prefixed = NET_WORLDS.filter((world) => fold(world.name).startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
