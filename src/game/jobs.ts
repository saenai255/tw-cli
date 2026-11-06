// Jobs, as the browser handles them:
//  - static definitions: Game.init.jobs / jobDurations (JobList.init @607935)
//  - per-character values: work/index (mode)  → json.jobs[id] (JobsModel.initJobs / mergeJobObject @2209657)
//    live shape: {workpoints, jobSkillPoints, motivation, durations:[{cost,money,xp,luck,items,duration}×3],
//                 minMaxItemVal, limit_reached, stage:{stage,progress,malus}, is_gold?, is_silver?}
//  - locations: map/get_minimap (ajax)        → json.job_groups[groupid] = [[x,y], ...] (createPoints4Job)
//  - one location's details: job/job (mode) {jobId,x,y} (JobWindow.initData @1520049); same `durations[]` and
//    the real silver/gold values at that spot (tile data only names the position)
//  - rewards: the next 25 % motivation breakpoint; 1/5/12 % lost per short/middle/long run
//  - travel time: GameMap.calcWayTime = distance * Game.travelSpeed * Character.speed (seconds)
import type { GameClient } from '../http/game-client.ts';
import { arr, entries, type JsonObject, obj, objs } from '../util/json.ts';
import type { Position } from './character.ts';
import { baseId } from './items.ts';

export type DurationKey = 'short' | 'middle' | 'long';
export const DURATION_KEYS: DurationKey[] = ['short', 'middle', 'long'];
export type SpecialKind = 'silver' | 'gold';

/** Motivation lost by one completed run (support.innogames.com/kb/TheWest/en_DK/4707). */
export const MOTIVATION_LOSS: Record<DurationKey, number> = { short: 0.01, middle: 0.05, long: 0.12 };

/**
 * The reward multiplier the game uses for a motivation: the next 25 % breakpoint (100/75/50/25/0).
 * At 75 % exactly rewards are already 75 %; 76–100 % pay 100 %.
 */
export function motivationFactor(motivation: number): number {
  if (!(motivation > 0)) {
    return 0;
  }
  return Math.min(1, Math.ceil(motivation * 4) / 4);
}

export interface JobDef {
  id: number;
  groupid: number;
  name: string;
  shortname: string;
  level: number;
  malus: number;
  skills: Record<string, number>;
  durations: Record<DurationKey, number>;
  /** Product drops: item id → chance (Game.init.jobs[].yields[id].prop). */
  yields: Record<number, number>;
}

export interface JobDurationValues {
  duration: number;
  energy: number;
  money: number;
  experience: number;
  luck: number;
  /** Product drops for this duration: expected items per run = (prop + probBonus) / 100 (job window shows the %). */
  items?: { itemId: number; expected: number; percent: number }[];
}

/**
 * Rescales the values read at `fromMotivation` to `toMotivation`, rounding money/XP up as the game does.
 * Motivation affects XP, money and luck chance only; product drops and the luck value range do not change.
 */
export function scaleJobValues(
  values: JobDurationValues,
  fromMotivation: number,
  toMotivation: number,
): JobDurationValues {
  const fromFactor = motivationFactor(fromMotivation);
  const toFactor = motivationFactor(toMotivation);
  const ratio = fromFactor > 0 ? toFactor / fromFactor : 0;
  if (ratio === 1) {
    return values;
  }
  return {
    ...values,
    experience: Math.ceil(values.experience * ratio),
    money: Math.ceil(values.money * ratio),
    luck: Math.round(values.luck * ratio * 100) / 100,
  };
}

export interface JobInfo extends JobDef {
  /** jobSkillPoints: weighted skill points for this job. */
  jobPoints: number;
  /** Requirement, as the client computes it: malus + 1 (west.job.Model). Doable when jobPoints >= workPoints. */
  workPoints: number;
  /** Labor points as shown in game: jobSkillPoints − malus (live work/index sends it as `workpoints`). */
  laborPoints: number;
  motivation: number;
  /** Motivation at which `values` were read (work/index or job/job); scale to `motivation` before display. */
  valuesMotivation: number;
  /** Danger 0–100; null until the selected job's job/job detail is loaded (work/index omits it). */
  danger: number | null;
  /** minMaxItemVal: $ value range of a lucky item find (job window "$min-$max"; list sorts by max = maxLuck). */
  luckValue: [number, number];
  values: Partial<Record<DurationKey, JobDurationValues>>;
}

/** Whether this character has the labor points the job requires. */
export const isDoable = (job: JobInfo): boolean => job.jobPoints >= job.workPoints;

export class JobCatalog {
  readonly byId = new Map<number, JobDef>();

  constructor(gameInit: JsonObject | null) {
    for (const jsonValue of objs(gameInit?.jobs)) {
      const durationsJson = obj(jsonValue.durations);
      const id = Number(jsonValue.id);
      this.byId.set(id, {
        id,
        groupid: Number(jsonValue.groupid),
        name: String(jsonValue.name ?? ''),
        shortname: String(jsonValue.shortname ?? ''),
        level: Number(jsonValue.level) || 0,
        malus: Number(jsonValue.malus) || 0,
        skills: Object.fromEntries(
          entries(jsonValue.skills).map(([entryKey, currentValue]) => [entryKey, Number(currentValue) || 0]),
        ),
        durations: {
          short: Number(durationsJson.short ?? 15),
          middle: Number(durationsJson.middle ?? 600),
          long: Number(durationsJson.long ?? 3600),
        },
        yields: Object.fromEntries(
          entries(jsonValue.yields).map(([yieldId, yieldValue]) => [
            Number(yieldId),
            Number(obj(yieldValue).prop) || 0,
          ]),
        ),
      });
    }
  }

  get(id: number): JobDef | undefined {
    return this.byId.get(id);
  }

  /** Jobs whose product drops include this item (any upgrade level), best chance first. */
  yielding(itemId: number): { job: JobDef; chance: number }[] {
    const base = baseId(itemId);
    const out: { job: JobDef; chance: number }[] = [];
    for (const job of this.byId.values()) {
      for (const [id, chance] of Object.entries(job.yields ?? {})) {
        if (baseId(Number(id)) === base) {
          out.push({ job, chance });
        }
      }
    }
    return out.sort((firstValue, second) => second.chance - firstValue.chance);
  }
}

/** Danger is only part of the job/job detail reply; work/index may leave it out. */
export function parseDanger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One duration from a work/index or job/job reply (`durations[]` entry). */
export function parseDurationValues(raw: unknown): JobDurationValues {
  const jsonValue = obj(raw);
  return {
    duration: Number(jsonValue.duration),
    energy: Number(jsonValue.cost),
    money: Number(jsonValue.money) + (Number(jsonValue.featured_money) || 0),
    experience: Number(jsonValue.xp) + (Number(jsonValue.featured_xp) || 0),
    luck: Number(jsonValue.luck) || 0,
    items: objs(jsonValue.items)
      .filter((itemJson) => !itemJson.random && itemJson.itemid)
      .map((itemJson) => {
        const percent = (Number(itemJson.prop) || 0) + (Number(itemJson.probBonus) || 0);
        return { itemId: Number(itemJson.itemid), expected: percent / 100, percent };
      }),
  };
}

/** `is_gold` / `is_silver` in job replies; `gold` / `silver` in map tiles. */
export function parseSpecialKind(raw: JsonObject): SpecialKind | null {
  if (raw.is_gold || raw.gold) {
    return 'gold';
  }
  if (raw.is_silver || raw.silver) {
    return 'silver';
  }
  return null;
}

export interface JobDetail {
  danger: number | null;
  motivation: number | null;
  special: SpecialKind | null;
  luckValue: [number, number] | null;
  /** Real rewards for this location, already at `motivation`. */
  values: Partial<Record<DurationKey, JobDurationValues>>;
}

/** job/job → the live values the browser's job window shows for one job at one location. */
export function parseJobDetail(raw: JsonObject): JobDetail {
  const motivation = raw.motivation === null || raw.motivation === undefined ? NaN : Number(raw.motivation);
  const values: JobDetail['values'] = {};
  DURATION_KEYS.forEach((entryKey, index) => {
    const duration = arr(raw.durations)[index];
    if (duration) {
      values[entryKey] = parseDurationValues(duration);
    }
  });
  const luck = arr(raw.minMaxItemVal);
  return {
    danger: parseDanger(raw.danger),
    motivation: Number.isFinite(motivation) ? motivation : null,
    special: parseSpecialKind(raw),
    luckValue: luck.length >= 2 ? [Number(luck[0]) || 0, Number(luck[1]) || 0] : null,
    values,
  };
}

/** work/index → per-character job values merged onto the static definitions. */
export async function fetchJobInfos(client: GameClient, catalog: JobCatalog): Promise<JobInfo[]> {
  const json = await client.remoteCallMode('work', 'index');
  if (json.error) {
    throw new Error(String(json.msg ?? 'work/index failed'));
  }
  const out: JobInfo[] = [];
  for (const [key, currentValue] of entries(json.jobs)) {
    const be = obj(currentValue);
    const def = catalog.get(Number(key));
    if (!def) {
      continue;
    }
    const values: JobInfo['values'] = {};
    DURATION_KEYS.forEach((entryKey, index) => {
      const raw = arr(be.durations)[index];
      if (raw) {
        values[entryKey] = parseDurationValues(raw);
      }
    });
    const motivation = Number(be.motivation);
    out.push({
      ...def,
      jobPoints: Number(be.jobSkillPoints),
      workPoints: def.malus + 1,
      laborPoints: typeof be.workpoints === 'number' ? be.workpoints : Number(be.jobSkillPoints) - def.malus,
      motivation,
      valuesMotivation: motivation,
      danger: parseDanger(be.danger),
      luckValue: [Number(arr(be.minMaxItemVal)[0]) || 0, Number(arr(be.minMaxItemVal)[1]) || 0],
      values,
    });
  }
  return out;
}

export type JobLocations = Map<number, Position[]>;

/** map/get_minimap → job group id → list of map coordinates. */
export async function fetchJobLocations(client: GameClient): Promise<JobLocations> {
  const json = await client.get('map', 'get_minimap');
  if (json.error) {
    throw new Error(String(json.msg ?? 'map/get_minimap failed'));
  }
  const map: JobLocations = new Map();
  for (const [group, coords] of entries(json.job_groups)) {
    map.set(Number(group), toPositions(coords));
  }
  return map;
}

/** [[x, y], ...] → positions. */
export const toPositions = (coords: unknown): Position[] =>
  arr(coords).map((candidate) => ({ x: Number(arr(candidate)[0]), y: Number(arr(candidate)[1]) }));

export function distance(position: Position, positionValue: Position): number {
  return Math.sqrt((position.x - positionValue.x) ** 2 + (position.y - positionValue.y) ** 2);
}

/** GameMap.calcWayTime, seconds. */
export function wayTime(from: Position, to: Position, travelSpeed: number, charSpeed: number): number {
  return distance(from, to) * travelSpeed * charSpeed;
}

export function nearestLocation(locations: Position[] | undefined, from: Position): Position | null {
  if (!locations?.length) {
    return null;
  }
  const first = locations[0];
  if (!first) {
    return null;
  }
  let best = first;
  let bestD = distance(best, from);
  for (const position of locations) {
    const currentValue = distance(position, from);
    if (currentValue < bestD) {
      best = position;
      bestD = currentValue;
    }
  }
  return best;
}

/** job/job {jobId,x,y}: details for one job at one place (raw server object). */
export async function fetchJobDetail(client: GameClient, jobId: number, at: Position): Promise<JsonObject> {
  const json = await client.remoteCallMode('job', 'job', { jobId, x: at.x, y: at.y });
  if (json.error) {
    throw new Error(String(json.msg ?? 'job/job failed'));
  }
  return json;
}
