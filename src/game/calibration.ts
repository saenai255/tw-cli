// Calibration: what the autopilot learns from your own game instead of guessing (calibration.json in the
// config dir). Job reports give item drops per job and duration; the health the server reports after a
// dangerous job gives the real HP loss; a cancelled sleep gives the hotel room's real energy rate; level-ups
// show whether they refill energy. The planner blends each with its prior (the game's numbers or the old
// heuristic) by how many samples there are.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';
import { entries, isObj, mergeDefaults, obj } from '../util/json.ts';
import { baseId } from './items.ts';

export const CALIBRATION_FILE = () => join(CONFIG_DIR, 'calibration.json');

/** Prior strength: how many observed runs / samples it takes to count as much as the game's own number. */
export const PRIOR_RUNS = 5;

export interface CalibrationData {
  /** `${jobId}:${duration key}` → runs seen in reports and items found per base item id. */
  drops: Record<string, { runs: number; found: Record<string, number> }>;
  /** Dangerous runs: summed predicted (heuristic) and observed HP loss. */
  hp: { runs: number; predicted: number; observed: number };
  /** Sleeps cancelled by the autopilot: observed energy rate ÷ the rate read from the hotel (energy / 100). */
  rooms: { n: number; ratio: number };
  levelUps: { seen: number; refilled: number };
}

const EMPTY: CalibrationData = {
  drops: {},
  hp: { runs: 0, predicted: 0, observed: 0 },
  rooms: { n: 0, ratio: 0 },
  levelUps: { seen: 0, refilled: 0 },
};

export class Calibration {
  data: CalibrationData;
  private file: string | null;

  constructor(file: string | null = CALIBRATION_FILE(), data?: CalibrationData) {
    this.file = file;
    this.data = data ?? (file ? Calibration.load(file) : structuredClone(EMPTY));
  }

  static load(file: string): CalibrationData {
    try {
      const raw = obj(JSON.parse(readFileSync(file, 'utf8')));
      const drops = entries(raw.drops)
        .filter(([, dataValue]) => isObj(dataValue))
        .map(([key, dataValue]) => {
          const found = entries(obj(dataValue).found).map(([id, count]): [string, number] => [id, Number(count) || 0]);
          return [key, { runs: Number(obj(dataValue).runs) || 0, found: Object.fromEntries(found) }] as const;
        });
      return { ...mergeDefaults(EMPTY, raw), drops: Object.fromEntries(drops) };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private save(): void {
    if (!this.file) {
      return;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch {
      /* learning only */
    }
  }

  // ---- recording -------------------------------------------------------------------------------

  /** One job report: the job, its duration key and the items found ([itemId, count]). */
  addJobRun(jobId: number, duration: string, items: [number, number][]): void {
    const entryKey = `${jobId}:${duration}`;
    const existing = this.data.drops[entryKey];
    const dataValue = existing ?? { runs: 0, found: {} };
    if (!existing) {
      this.data.drops[entryKey] = dataValue;
    }
    dataValue.runs++;
    for (const [id, count] of items) {
      const base = String(baseId(id));
      dataValue.found[base] = (dataValue.found[base] ?? 0) + count;
    }
    this.save();
  }

  addHp(predicted: number, observed: number): void {
    this.data.hp.runs++;
    this.data.hp.predicted += predicted;
    this.data.hp.observed += Math.max(0, observed);
    this.save();
  }

  addRoom(ratio: number): void {
    const result = this.data.rooms;
    result.ratio = (result.ratio * result.n + ratio) / (result.n + 1);
    result.n++;
    this.save();
  }

  addLevelUp(refilled: boolean): void {
    this.data.levelUps.seen++;
    if (refilled) {
      this.data.levelUps.refilled++;
    }
    this.save();
  }

  // ---- estimates -------------------------------------------------------------------------------

  /** Expected items per run, the game's number blended with what reports showed. */
  dropRate(jobId: number, duration: string, itemId: number, prior: number): number {
    const dataValue = this.data.drops[`${jobId}:${duration}`];
    if (!dataValue?.runs) {
      return prior;
    }
    const found = dataValue.found[String(baseId(itemId))] ?? 0;
    return (found + prior * PRIOR_RUNS) / (dataValue.runs + PRIOR_RUNS);
  }

  /** Multiplier for the danger → HP heuristic (1 until dangerous runs were seen). */
  get hpScale(): number {
    const item = this.data.hp;
    if (!item.runs || item.predicted <= 0) {
      return 1;
    }
    const prior = (item.predicted / item.runs) * PRIOR_RUNS; // PRIOR_RUNS runs exactly as predicted
    return (item.observed + prior) / (item.predicted + prior);
  }

  /** Hotel energy rate multiplier: measured sleeps blended with 1 (the hotel's number read as % per hour). */
  get roomScale(): number {
    const result = this.data.rooms;
    return (result.ratio * result.n + 1) / (result.n + 1);
  }

  /** Summary for the debug log and screen. */
  summary(): Record<string, unknown> {
    const runs = Object.values(this.data.drops).reduce((accumulator, current) => accumulator + current.runs, 0);
    return {
      jobReports: runs,
      jobKinds: Object.keys(this.data.drops).length,
      hpScale: this.hpScale,
      hpRuns: this.data.hp.runs,
      roomScale: this.roomScale,
      roomSamples: this.data.rooms.n,
      levelUps: this.data.levelUps,
    };
  }
}
