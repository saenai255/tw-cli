// Terminal world map. The cursor is the centre cell; the view pans around it.
// One column covers `zoom` px of world x; one row covers 2×zoom px of y (terminal cells are ~2:1).

import { Box, Text } from 'ink';
import React from 'react';
import type { Position } from '../game/character.ts';
import { distance, isDoable } from '../game/jobs.ts';
import type { GameState, JobOption } from '../game/state.ts';
import { type Fort, type Town, WORLD_H, WORLD_W } from '../game/world.ts';
import { defined } from '../util/defined.ts';
import { formatTravel, money, truncate } from './format.ts';

const createElement = React.createElement;

export const ZOOMS = [32, 64, 128, 256, 512, 1024];

export interface MapView {
  x: number;
  y: number;
  zoom: number;
}

export interface Seg {
  text: string;
  color?: string | undefined;
  dim?: boolean | undefined;
  bold?: boolean | undefined;
  inverse?: boolean | undefined;
}

interface Cell {
  ch: string;
  prio: number;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

export type MapLayer =
  | 'jobs'
  | 'lockedJobs'
  | 'special'
  | 'questJobs'
  | 'questGivers'
  | 'towns'
  | 'emptyTowns'
  | 'forts'
  | 'markets'
  | 'players'
  | 'queue'
  | 'counties';
/** Toggleable map layers (v isLayerOn the map), in display order. */
export const MAP_LAYERS: { key: MapLayer; symbol: string; color: string; label: string }[] = [
  { key: 'jobs', symbol: 'j', color: 'yellow', label: 'jobs you can do' },
  { key: 'lockedJobs', symbol: 'j', color: 'gray', label: 'jobs without enough labor points' },
  { key: 'special', symbol: '*', color: 'yellowBright', label: 'gold / silver jobs' },
  { key: 'questJobs', symbol: '!', color: 'magentaBright', label: 'quest / route jobs' },
  { key: 'questGivers', symbol: '?', color: 'magenta', label: 'quest givers & fair' },
  { key: 'towns', symbol: 'T', color: 'white', label: 'towns' },
  { key: 'emptyTowns', symbol: 't', color: 'gray', label: 'empty town sites' },
  { key: 'forts', symbol: 'F', color: 'red', label: 'forts' },
  { key: 'markets', symbol: '$', color: 'green', label: 'markets' },
  { key: 'players', symbol: 'p', color: 'blueBright', label: 'players & friends' },
  { key: 'queue', symbol: '1', color: 'cyan', label: 'queued tasks' },
  { key: 'counties', symbol: '┊', color: 'gray', label: 'county borders' },
];
export const DEFAULT_LAYERS: Record<MapLayer, boolean> = Object.fromEntries(
  MAP_LAYERS.map((line) => [line.key, true]),
) as Record<MapLayer, boolean>;

export function clampView(value: MapView): MapView {
  return { ...value, x: Math.min(WORLD_W - 1, Math.max(0, value.x)), y: Math.min(WORLD_H - 1, Math.max(0, value.y)) };
}

function origin(view: MapView, cols: number, rows: number) {
  const cellWidth = view.zoom;
  const cellHeight = view.zoom * 2;
  const centerColumn = Math.floor(cols / 2);
  const centerRow = Math.floor(rows / 2);
  // Cursor cell (centerColumn, centerRow) contains view.x/view.y.
  const originX = Math.floor(view.x / cellWidth) * cellWidth - centerColumn * cellWidth;
  const originY = Math.floor(view.y / cellHeight) * cellHeight - centerRow * cellHeight;
  return { cellWidth, cellHeight, centerColumn, centerRow, originX, originY };
}

/** World rectangle covered by the cursor cell. */
export function cursorRect(view: MapView, cols: number, rows: number) {
  const { cellWidth, cellHeight, centerColumn, centerRow, originX, originY } = origin(view, cols, rows);
  const centerX = originX + centerColumn * cellWidth;
  const centerY = originY + centerRow * cellHeight;
  return { x1: centerX, y1: centerY, x2: centerX + cellWidth, y2: centerY + cellHeight };
}

export function buildGrid(state: GameState, view: MapView, cols: number, rows: number): Seg[][] {
  const { cellWidth, cellHeight, centerColumn, centerRow, originX, originY } = origin(view, cols, rows);
  const grid: Cell[][] = [];
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const row: Cell[] = [];
    const worldY = originY + rowIndex * cellHeight;
    for (let columnIndex = 0; columnIndex < cols; columnIndex++) {
      const worldX = originX + columnIndex * cellWidth;
      const outside = worldX + cellWidth <= 0 || worldY + cellHeight <= 0 || worldX >= WORLD_W || worldY >= WORLD_H;
      row.push(outside ? { ch: '░', prio: 0, dim: true } : { ch: ' ', prio: 0 });
    }
    grid.push(row);
  }
  const isLayerOn = (layer: MapLayer) => state.mapLayers[layer] !== false;
  // County borders.
  for (const county of isLayerOn('counties') ? state.world.counties : []) {
    if (county.x1 > 0) {
      const column = Math.floor((county.x1 - originX) / cellWidth);
      if (column >= 0 && column < cols) {
        for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
          const row = grid[rowIndex];
          if (!row) {
            continue;
          }
          const worldY = originY + rowIndex * cellHeight;
          const cell = row[column];
          if (worldY + cellHeight > county.y1 && worldY <= county.y2 && cell?.prio === 0 && cell.ch === ' ') {
            row[column] = { ch: '┊', prio: 0, dim: true };
          }
        }
      }
    }
    if (county.y1 > 0) {
      const countyRow = Math.floor((county.y1 - originY) / cellHeight);
      if (countyRow >= 0 && countyRow < rows) {
        const row = grid[countyRow];
        if (!row) {
          continue;
        }
        for (let columnIndex = 0; columnIndex < cols; columnIndex++) {
          const worldX = originX + columnIndex * cellWidth;
          if (worldX + cellWidth > county.x1 && worldX <= county.x2 && row[columnIndex]?.ch === ' ') {
            row[columnIndex] = { ch: '┄', prio: 0, dim: true };
          }
        }
      }
    }
  }
  const put = (position: Position, cell: Cell) => {
    const column = Math.floor((position.x - originX) / cellWidth);
    const rowIndex = Math.floor((position.y - originY) / cellHeight);
    if (rowIndex < 0 || rowIndex >= rows || column < 0 || column >= cols) {
      return;
    }
    const row = grid[rowIndex];
    const existing = row?.[column];
    if (row && existing && existing.prio < cell.prio) {
      row[column] = cell;
    }
  };
  const doableGroups = new Set(state.jobs.filter((job) => isDoable(job)).map((job) => job.groupid));
  if (isLayerOn('players')) {
    for (const friend of state.world.friends) {
      put(friend, { ch: 'f', prio: 1, color: 'blue' });
    }
    for (const crowd of state.tiles.crowds.values()) {
      put(crowd, { ch: 'p', prio: 1, color: 'blueBright' });
    }
  }
  for (const [groupId, locations] of state.world.jobGroups) {
    const doable = doableGroups.has(groupId);
    if (!isLayerOn(doable ? 'jobs' : 'lockedJobs')) {
      continue;
    }
    for (const location of locations) {
      put(location, { ch: 'j', prio: doable ? 3 : 2, color: doable ? 'yellow' : 'gray', dim: !doable });
    }
  }
  if (isLayerOn('markets')) {
    for (const market of state.world.markets) {
      put(market, { ch: '$', prio: 4, color: 'green' });
    }
  }
  if (isLayerOn('questGivers')) {
    for (const questGiver of state.world.quests) {
      put(questGiver, { ch: '?', prio: 5, color: 'magenta', bold: true });
    }
    if (state.world.fair) {
      put(state.world.fair, { ch: '&', prio: 5, color: 'magentaBright', bold: true });
    }
  }
  if (isLayerOn('forts')) {
    for (const fort of state.world.forts) {
      put(fort, { ch: 'F', prio: 6, color: 'red' });
    }
  }
  if (isLayerOn('special')) {
    for (const source of state.tiles.specialJobs.values()) {
      put(source, { ch: '*', prio: 7, color: source.gold ? 'yellowBright' : 'whiteBright', bold: true });
    }
  }
  const home = state.character.homeTown?.id;
  for (const town of state.world.towns) {
    if (town.id === home) {
      put(town, { ch: 'H', prio: 9, color: 'cyan', bold: true }); // home always shows
    } else if (town.name) {
      isLayerOn('towns') && put(town, { ch: 'T', prio: 8, color: 'white', bold: true });
    } else {
      isLayerOn('emptyTowns') && put(town, { ch: 't', prio: 6, dim: true });
    }
  }
  if (isLayerOn('queue')) {
    state.queue.forEach((task, index) => {
      put(task.coords, { ch: String((index + 1) % 10), prio: 10, color: 'cyan', bold: true });
    });
  }
  // Quest targets (jobs that drop a required item) stand out over ordinary jobs and towns.
  for (const id of isLayerOn('questJobs') ? (state.mapHighlight?.jobIds ?? []) : []) {
    const job = state.catalog.get(id);
    for (const at of job ? (state.world.jobGroups.get(job.groupid) ?? []) : []) {
      put(at, { ch: '!', prio: 9.5, color: 'magentaBright', bold: true });
    }
  }
  if (state.character.positionKnown) {
    put(state.character.position, { ch: '@', prio: 11, color: 'green', bold: true });
  }

  // Collapse runs of equal style into segments; cursor cell is inverse.
  return grid.map((row, rowIndex) => {
    const segs: Seg[] = [];
    row.forEach((cell, columnIndex) => {
      const inverse = rowIndex === centerRow && columnIndex === centerColumn;
      const ch = inverse && cell.ch === ' ' ? '+' : cell.ch;
      const last = segs[segs.length - 1];
      if (
        last &&
        !inverse &&
        !last.inverse &&
        last.color === cell.color &&
        last.dim === cell.dim &&
        last.bold === cell.bold
      ) {
        last.text += ch;
      } else {
        segs.push({ text: ch, color: cell.color, dim: cell.dim, bold: cell.bold, inverse });
      }
    });
    return segs;
  });
}

export type MapEntry =
  | { kind: 'job'; option: JobOption; doable: boolean }
  | { kind: 'town'; town: Town }
  | { kind: 'fort'; fort: Fort }
  | { kind: 'quest'; key: string; name: string; at: Position }
  | { kind: 'text'; text: string; color?: string };

/** What is under the cursor cell, as selectable entries. */
export function entriesAt(state: GameState, view: MapView, cols: number, rows: number): MapEntry[] {
  const result = cursorRect(view, cols, rows);
  const here = state.world.within(result.x1, result.y1, result.x2, result.y2);
  const out: MapEntry[] = [];
  for (const town of here.towns) {
    out.push({ kind: 'town', town: town });
  }
  for (const value of here.forts) {
    out.push({ kind: 'fort', fort: value });
  }
  const inRect = (position: Position) =>
    position.x >= result.x1 && position.x < result.x2 && position.y >= result.y1 && position.y < result.y2;
  const givers = [...state.tiles.questGivers.values()].filter(inRect);
  for (const group of givers) {
    if (!group.employers?.length) {
      out.push({ kind: 'text', text: '? quest giver', color: 'magenta' });
    }
    for (const entry of group.employers ?? []) {
      out.push({ kind: 'quest', key: entry.key, name: entry.name, at: { x: group.x, y: group.y } });
    }
  }
  const unnamed = here.quests.filter(
    (position) => !givers.some((group) => group.x === position.x && group.y === position.y),
  );
  if (unnamed.length) {
    out.push({
      kind: 'text',
      text: `? quest giver${unnamed.length > 1 ? ` ×${unnamed.length}` : ''} (name loads when close)`,
      color: 'magenta',
    });
  }
  if (state.world.fair && inRect(state.world.fair)) {
    out.push({ kind: 'text', text: '& travelling fair', color: 'magentaBright' });
  }
  for (const sj of [...state.tiles.specialJobs.values()].filter(inRect)) {
    out.push({
      kind: 'text',
      text: `* ${sj.gold ? 'GOLD' : 'silver'} job: ${state.catalog.get(sj.jobId)?.name ?? sj.jobId}`,
      color: sj.gold ? 'yellowBright' : 'whiteBright',
    });
  }
  for (const candidate of [...state.tiles.crowds.values()].filter(inRect)) {
    out.push({ kind: 'text', text: `p ${candidate.count} players here`, color: 'blueBright' });
  }
  if (here.markets.length) {
    out.push({ kind: 'text', text: '$ market', color: 'green' });
  }
  if (here.friends.length) {
    out.push({
      kind: 'text',
      text: `f friends: ${here.friends.reduce((accumulator, current) => accumulator + current.amount, 0)}`,
      color: 'blue',
    });
  }
  const seen = new Set<string>();
  for (const { groupId, at } of here.jobs) {
    for (const option of state.jobsAtLocation(groupId, at)) {
      const key = `${option.job.id}@${at.x},${at.y}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ kind: 'job', option, doable: option.job.jobPoints >= option.job.workPoints });
    }
  }
  out.sort((first, second) => rank(first) - rank(second));
  return out;
}

function rank(entry: MapEntry): number {
  if (entry.kind === 'town' || entry.kind === 'fort' || entry.kind === 'quest') {
    return 0;
  }
  if (entry.kind === 'text') {
    return 1;
  }
  return entry.doable ? 2 : 3;
}

/** '/' search: nearest location (from the cursor) of a job or named town matching the query. */
export function findNearest(state: GameState, query: string, from: Position): { at: Position; label: string } | null {
  const text = query.trim().toLowerCase();
  if (!text) {
    return null;
  }
  let best: { at: Position; label: string; d: number } | null = null;
  const consider = (at: Position, label: string) => {
    const value = distance(at, from);
    if (!best || value < best.d) {
      best = { at, label, d: value };
    }
  };
  for (const job of state.jobs) {
    if (!job.name.toLowerCase().includes(text)) {
      continue;
    }
    for (const at of state.world.jobGroups.get(job.groupid) ?? []) {
      consider(at, job.name);
    }
  }
  for (const town of state.world.towns) {
    if (town.name?.toLowerCase().includes(text)) {
      consider(town, town.name);
    }
  }
  const second = best as { at: Position; label: string; d: number } | null;
  return second ? { at: second.at, label: second.label } : null;
}

export interface MapScreenProps {
  state: GameState;
  view: MapView;
  width: number;
  height: number;
  entries: MapEntry[];
  selected: number;
  panelFocused: boolean;
  search: string;
  searching: boolean;
}

export const PANEL_W = 40;

export function mapGridSize(width: number, height: number) {
  return { cols: Math.max(10, width - PANEL_W - 2), rows: Math.max(4, height - 2) };
}

export function MapScreen(pick: MapScreenProps) {
  const { state, view, width, height, entries, selected, panelFocused } = pick;
  const { cols, rows } = mapGridSize(width, height);
  const grid = buildGrid(state, view, cols, rows);
  const rect = cursorRect(view, cols, rows);
  const centre = { x: Math.round((rect.x1 + rect.x2) / 2), y: Math.round((rect.y1 + rect.y2) / 2) };
  const county = state.world.countyAt(centre);
  const panelW = Math.max(20, width - cols - 2);
  const listRows = Math.max(1, height - 2 - 5);
  const start = Math.max(0, Math.min(selected - Math.floor(listRows / 2), entries.length - listRows));
  const shown = entries.slice(start, start + listRows);

  return createElement(
    Box,
    { height, width },
    createElement(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: panelFocused ? 'gray' : 'cyan',
        width: cols + 2,
        flexShrink: 0,
      },
      ...grid.map((segs, value) =>
        createElement(
          Text,
          { key: value, wrap: 'truncate' },
          ...segs.map((source, index) =>
            createElement(
              Text,
              defined({
                key: index,
                color: source.color,
                dimColor: source.dim,
                bold: source.bold,
                inverse: source.inverse,
              }),
              source.text,
            ),
          ),
        ),
      ),
    ),
    createElement(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: panelFocused ? 'cyan' : 'gray',
        width: panelW,
        paddingX: 1,
        flexShrink: 0,
      },
      createElement(
        Text,
        { bold: true, wrap: 'truncate' },
        pick.searching ? `Find: ${pick.search}▏` : `${county?.name ?? 'Map'} · zoom ${view.zoom}px`,
      ),
      createElement(
        Text,
        { dimColor: true, wrap: 'truncate' },
        `cursor ${centre.x},${centre.y}${hiddenLayers(state) ? ` · ${hiddenLayers(state)} layer(s) off (v)` : ''}`,
      ),
      createElement(
        Text,
        { dimColor: true, wrap: 'truncate' },
        `travel ${formatTravel(state.travelTo(centre))} from queue end`,
      ),
      entries.length === 0 ? createElement(Text, { dimColor: true }, 'Nothing here') : null,
      ...shown.map((entry, index) => {
        const idx = start + index;
        const sel = panelFocused && idx === selected;
        const fieldWidth = panelW - 4;
        if (entry.kind === 'town') {
          const town = entry.town;
          const label = town.name
            ? `${town.id === state.character.homeTown?.id ? 'H' : 'T'} ${town.name} · ${town.members}m ${town.points}pts`
            : `t empty town site`;
          return createElement(
            Text,
            { key: idx, inverse: sel, wrap: 'truncate', color: 'white' },
            truncate(label, fieldWidth),
          );
        }
        if (entry.kind === 'fort') {
          return createElement(
            Text,
            { key: idx, inverse: sel, wrap: 'truncate', color: 'red' },
            truncate(`F ${entry.fort.name}`, fieldWidth),
          );
        }
        if (entry.kind === 'quest') {
          return createElement(
            Text,
            { key: idx, inverse: sel, wrap: 'truncate', color: 'magenta' },
            truncate(`? ${entry.name}`, fieldWidth),
          );
        }
        if (entry.kind === 'text') {
          return createElement(
            Text,
            defined({ key: idx, inverse: sel, wrap: 'truncate', color: entry.color }),
            truncate(entry.text, fieldWidth),
          );
        }
        const jobInfo = entry.option.job;
        const longestValues = jobInfo.values.long ?? jobInfo.values.middle ?? jobInfo.values.short;
        const quest = state.mapHighlight?.jobIds.has(jobInfo.id);
        const label = `${quest ? '!' : 'j'} ${jobInfo.name} ${jobInfo.laborPoints}LP${longestValues ? ` ${money(longestValues.money)}/h` : ''}`;
        return createElement(
          Text,
          {
            key: idx,
            inverse: sel,
            wrap: 'truncate',
            color: quest ? 'magentaBright' : entry.doable ? 'yellow' : 'gray',
          },
          truncate(label, fieldWidth),
        );
      }),
    ),
  );
}

const hiddenLayers = (state: GameState) => MAP_LAYERS.filter((line) => state.mapLayers[line.key] === false).length;

/** v isLayerOn the map: which layers are drawn. */
export function LayersOverlay({
  state,
  selected,
  width,
  height,
}: {
  state: GameState;
  selected: number;
  width: number;
  height: number;
}) {
  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
      width: Math.min(52, width),
      height,
    },
    createElement(Text, { bold: true }, 'Map layers'),
    ...MAP_LAYERS.map((line, index) => {
      const shown = state.mapLayers[line.key] !== false;
      return createElement(
        Text,
        { key: line.key, inverse: index === selected, wrap: 'truncate' },
        createElement(Text, { color: shown ? 'green' : 'gray' }, shown ? '[✔] ' : '[ ] '),
        createElement(Text, { color: line.color, bold: true, dimColor: !shown }, line.symbol),
        createElement(Text, { dimColor: !shown }, ` ${line.label}`),
      );
    }),
    createElement(Box, { flexGrow: 1 }),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      'Space/Enter toggle · a all isLayerOn · n all off · Esc close',
    ),
  );
}
