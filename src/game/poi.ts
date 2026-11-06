// Points of interest for the map: the game's interactive map objects (GameMap.Data.interactiveImages:
// town, job, quest, fort, fair, adventures) plus markets, friends and your own places.
import type { Position } from './character.ts';
import { distance } from './jobs.ts';
import type { GameState } from './state.ts';

export type PoiKind =
  | 'home'
  | 'me'
  | 'queue'
  | 'town'
  | 'fort'
  | 'quest'
  | 'gold'
  | 'silver'
  | 'market'
  | 'fair'
  | 'friend'
  | 'crowd';

export interface Poi extends Position {
  kind: PoiKind;
  label: string;
  townId?: number;
}

export const POI_STYLE: Record<PoiKind, { ch: string; color: string; name: string }> = {
  me: { ch: '@', color: 'green', name: 'you' },
  queue: { ch: '#', color: 'cyan', name: 'queued task' },
  home: { ch: 'H', color: 'cyan', name: 'home town' },
  town: { ch: 'T', color: 'white', name: 'town' },
  fort: { ch: 'F', color: 'red', name: 'fort' },
  quest: { ch: '?', color: 'magenta', name: 'quest giver' },
  gold: { ch: '*', color: 'yellowBright', name: 'gold job' },
  silver: { ch: '*', color: 'whiteBright', name: 'silver job' },
  market: { ch: '$', color: 'green', name: 'market' },
  fair: { ch: '&', color: 'magentaBright', name: 'travelling fair' },
  friend: { ch: 'f', color: 'blue', name: 'friend' },
  crowd: { ch: 'p', color: 'blueBright', name: 'players' },
};

export function collectPois(state: GameState): Poi[] {
  const out: Poi[] = [];
  const width = state.world;
  const homeId = state.character.homeTown?.id;
  if (state.character.positionKnown) {
    out.push({ kind: 'me', label: state.character.name, ...state.character.position });
  }
  state.queue.forEach((task, index) => {
    if (task.coordsKnown) {
      out.push({ kind: 'queue', label: `${index + 1}. ${task.title}`, ...task.coords });
    }
  });
  for (const town of width.towns) {
    if (town.id === homeId) {
      out.push({ kind: 'home', label: town.name ?? 'Home town', x: town.x, y: town.y, townId: town.id });
    } else if (town.name) {
      out.push({
        kind: 'town',
        label: `${town.name} (${town.members} members)`,
        x: town.x,
        y: town.y,
        townId: town.id,
      });
    }
  }
  for (const value of width.forts) {
    out.push({ kind: 'fort', label: value.name, x: value.x, y: value.y });
  }
  // Named quest givers from loaded tiles; the rest from the minimap without names.
  const named = new Set<string>();
  for (const query of state.tiles.questGivers.values()) {
    named.add(`${query.x},${query.y}`);
    out.push({ kind: 'quest', label: query.names.join(', ') || 'Quest giver', x: query.x, y: query.y });
  }
  for (const position of width.quests) {
    if (!named.has(`${position.x},${position.y}`)) {
      out.push({ kind: 'quest', label: 'Quest giver', x: position.x, y: position.y });
    }
  }
  for (const source of state.tiles.specialJobs.values()) {
    const name = state.catalog.get(source.jobId)?.name ?? `job ${source.jobId}`;
    out.push({
      kind: source.gold ? 'gold' : 'silver',
      label: `${source.gold ? 'Gold' : 'Silver'} job: ${name}`,
      x: source.x,
      y: source.y,
    });
  }
  for (const match of width.markets) {
    out.push({ kind: 'market', label: 'Market', x: match.x, y: match.y });
  }
  if (width.fair) {
    out.push({ kind: 'fair', label: 'Travelling fair', ...width.fair });
  }
  for (const currentValue of width.friends) {
    out.push({ kind: 'friend', label: `Friends (${currentValue.amount})`, x: currentValue.x, y: currentValue.y });
  }
  for (const candidate of state.tiles.crowds.values()) {
    out.push({ kind: 'crowd', label: `${candidate.count} players`, x: candidate.x, y: candidate.y });
  }
  return out;
}

/** POIs sorted by distance from `from`, optionally filtered by text or kind. */
export function poisNear(state: GameState, from: Position, filter = ''): (Poi & { dist: number })[] {
  const text = filter.trim().toLowerCase();
  return collectPois(state)
    .filter((pick) => !text || pick.label.toLowerCase().includes(text) || POI_STYLE[pick.kind].name.includes(text))
    .map((pick) => ({ ...pick, dist: distance(pick, from) }))
    .sort((first, second) => first.dist - second.dist);
}
