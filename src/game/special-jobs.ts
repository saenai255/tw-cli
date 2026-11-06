// Silver/gold jobs discovered by the map tile loader, kept for a day so a restart does not need the map
// again. The raw job/job replies are stored too: they are the only source of the real boosted values.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';
import { arr, isObj, type JsonObject, obj } from '../util/json.ts';
import type { Position } from './character.ts';
import { type JobDetail, parseJobDetail, type SpecialKind } from './jobs.ts';
import type { SpecialJob } from './tiles.ts';

/** The game redistributes specials daily; a day is the longest a saved position can stay useful. */
export const SPECIAL_CACHE_TTL_MS = 24 * 3_600_000;

/** A discovered special job and the real job/job values for its exact location. */
export interface SpecialJobDetail {
  jobId: number;
  at: Position;
  kind: SpecialKind;
  detail: JobDetail;
  seenAt: number;
  /** The job/job reply as received, so the cache can be parsed back after a restart. */
  raw: JsonObject;
}

interface SavedEntry {
  x: number;
  y: number;
  jobId: number;
  groupId: number;
  gold: boolean;
  silver: boolean;
  seenAt: number;
  raw?: JsonObject;
}

const fileFor = (worldUrl: string): string =>
  join(CONFIG_DIR, 'cache', `special-jobs-${new URL(worldUrl).host.replace(/[^\w.-]/g, '_')}.json`);

/** Reads the saved specials of this world; entries older than a day are dropped. */
export function loadSpecialJobs(worldUrl: string): { jobs: SpecialJob[]; details: SpecialJobDetail[] } {
  const empty = { jobs: [], details: [] };
  try {
    const saved = obj(JSON.parse(readFileSync(fileFor(worldUrl), 'utf8')));
    const savedAt = Number(saved.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > SPECIAL_CACHE_TTL_MS) {
      return empty;
    }
    const jobs: SpecialJob[] = [];
    const details: SpecialJobDetail[] = [];
    for (const value of arr(saved.entries)) {
      const entry = obj(value);
      const x = Number(entry.x);
      const y = Number(entry.y);
      const jobId = Number(entry.jobId);
      const groupId = Number(entry.groupId);
      const seenAt = Number(entry.seenAt);
      const gold = !!entry.gold;
      const silver = !!entry.silver;
      if (
        ![x, y, jobId, groupId, seenAt].every(Number.isFinite) ||
        Date.now() - seenAt > SPECIAL_CACHE_TTL_MS ||
        (!gold && !silver)
      ) {
        continue;
      }
      jobs.push({ x, y, jobId, groupId, gold, silver, seenAt });
      if (!isObj(entry.raw)) {
        continue;
      }
      const detail = parseJobDetail(entry.raw);
      if (detail.special) {
        details.push({ jobId, at: { x, y }, kind: detail.special, detail, seenAt, raw: entry.raw });
      }
    }
    return { jobs, details };
  } catch {
    return empty;
  }
}

/** Replaces the saved specials of this world; an empty list removes the file. */
export function saveSpecialJobs(
  worldUrl: string,
  jobs: Iterable<SpecialJob>,
  details: Iterable<SpecialJobDetail>,
): void {
  const entries = new Map<string, SavedEntry>();
  for (const job of jobs) {
    entries.set(`${job.jobId}:${job.x},${job.y}`, { ...job });
  }
  for (const special of details) {
    const key = `${special.jobId}:${special.at.x},${special.at.y}`;
    const current = entries.get(key);
    if (!current) {
      continue;
    }
    entries.set(key, {
      x: special.at.x,
      y: special.at.y,
      jobId: special.jobId,
      groupId: current.groupId,
      gold: current.gold,
      silver: current.silver,
      seenAt: Math.max(current.seenAt, special.seenAt),
      raw: special.raw,
    });
  }
  const file = fileFor(worldUrl);
  try {
    if (!entries.size) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(join(CONFIG_DIR, 'cache'), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), entries: [...entries.values()] }), { mode: 0o600 });
  } catch {
    /* cache only */
  }
}
