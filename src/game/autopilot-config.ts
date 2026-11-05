// Autopilot settings, rules and the last plan, saved in the config dir (autopilot.json) so they survive
// restarts. The plan itself is always recomputed from live inputs; the saved copy is only shown (stale) until
// the first replan, and its fingerprint tells whether the inputs changed since.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../auth/session-store.ts';
import type { FormValue } from '../http/form.ts';
import { arr, isObj, mergeDefaults, obj, objs } from '../util/json.ts';
import type { Quest } from './quests.ts';
import type { TimelineStep } from './timeline.ts';

export type Goal = 'quests' | 'xp' | 'money' | 'products';
export const GOALS: Goal[] = ['quests', 'xp', 'money', 'products'];
/** Weights by rank: the top goal decides, the rest break ties. */
export const RANK_WEIGHTS = [1, 0.25, 0.06, 0.015];

export type ModuleKey =
  | 'jobs'
  | 'energySleep'
  | 'hpSleep'
  | 'consumables'
  | 'bank'
  | 'quests'
  | 'npcDuels'
  | 'eventGifts'
  | 'dryRun';

export interface AutopilotConfig {
  running: boolean;
  priority: Goal[];
  per: 'energy' | 'time';
  /** Replaces RANK_WEIGHTS when set (advanced). */
  customWeights: Partial<Record<Goal, number>> | null;
  modules: Record<ModuleKey, boolean>;
  wake: { levelUp: boolean; stretch: boolean; hpSafe: boolean; full: boolean };
  hp: { sleepBelow: number; wakeAbove: number };
  /** Hotel and bank: own town when it is this close (s of walking). */
  ownTownWithin: number;
  bank: { above: number; maxDetour: number };
  consumables: { energy: boolean; health: boolean; motivation: boolean; reserve: number };
  /**
   * unfinishable: also work on quests with a requirement the autopilot cannot get (off: skip those quests).
   * buy: buy quest items no job drops (town shops, mobile trader; `market`: instant-buy offers too). Limits per
   * quest: `buyLimit` for shop + mobile trader, `marketLimit` for the market. `buyTrip`: furthest walk (s) to a
   * shop or market town; towns that far are the ones whose shops are scanned. `walkValue`: $ a minute of walking
   * is worth when comparing sources (a shop 10 min further must be 10 × that cheaper).
   */
  quests: {
    repeatable: boolean;
    unfinishable: boolean;
    excludedChains: string[];
    buy: boolean;
    market: boolean;
    buyLimit: number;
    marketLimit: number;
    buyTrip: number;
    walkValue: number;
  };
  duels: { forXp: boolean; levelMargin: number };
  /** walkSaved / sameWithin: also cancel for a plan that walks walkSaved s less and is worth at most sameWithin less. */
  cancel: { horizon: number; margin: number; cooldown: number; walkSaved: number; sameWithin: number };
  /**
   * Seconds each queued run costs for its queue slot: the TUI is not always open, and while it is closed only
   * the queued tasks keep you busy, so short runs that fill slots leave you idle.
   */
  slotCost: number;
  spend: { daily: number };
}

export const DEFAULT_CONFIG: AutopilotConfig = {
  running: false,
  priority: ['quests', 'xp', 'money', 'products'],
  per: 'energy',
  customWeights: null,
  modules: {
    jobs: true,
    energySleep: true,
    hpSleep: true,
    consumables: false,
    bank: true,
    quests: false,
    npcDuels: false,
    eventGifts: true,
    dryRun: false,
  },
  wake: { levelUp: true, stretch: false, hpSafe: true, full: false },
  hp: { sleepBelow: 0.5, wakeAbove: 0.7 },
  ownTownWithin: 3600,
  bank: { above: 4500, maxDetour: 1800 },
  consumables: { energy: true, health: true, motivation: false, reserve: 2 },
  quests: {
    repeatable: false,
    unfinishable: false,
    excludedChains: [],
    buy: true,
    market: true,
    buyLimit: 3000,
    marketLimit: 5000,
    buyTrip: 3600,
    walkValue: 15,
  },
  duels: { forXp: true, levelMargin: 0 },
  cancel: { horizon: 6 * 3600, margin: 0.1, cooldown: 900, walkSaved: 600, sameWithin: 0.02 },
  slotCost: 600,
  spend: { daily: 1000 },
};

/** Whether the rules let the autopilot work on this quest (scope, exclusions, repeatable option). */
export function questInScope(quest: Quest, rules: AutopilotRules, config: AutopilotConfig): boolean {
  return (
    (!rules.onlyQuests.length || rules.onlyQuests.includes(quest.id)) &&
    !rules.excludedQuests.includes(quest.id) &&
    !config.quests.excludedChains.includes(quest.group) &&
    (config.quests.repeatable || !/repeatable/i.test(quest.group))
  );
}

/** One task the autopilot intends to do; `post` is the task/add body when it is a server task. */
export interface PlannedTask {
  module: ModuleKey;
  step: TimelineStep;
  post?: Record<string, FormValue>;
  why?: string;
  /** Identifies the step across replans (retry/backoff, skip after failures). */
  key: string;
  /** Sleep: cancel it once energy and health reach these. */
  wake?: { energy: number; health: number };
  /** Done on the spot when the queue before it has finished (no task). */
  action?: { type: 'deposit'; townId: number } | { type: 'use'; itemId: number } | { type: 'buy'; townId: number };
  /** Weighted value by the priority (plans are compared by the sum). */
  value?: number;
}

/**
 * Your edits to the plan, kept as rules so a replan cannot wipe them. Inserts are anchored to a server time
 * (placed before the first planned step starting at or after it), which stays meaningful as tasks finish.
 */
export interface AutopilotRules {
  excludedJobs: number[];
  excludedQuests: number[];
  /** Only these quests count for the Quests goal (empty: all open quests); set by the quest screen's route. */
  onlyQuests: number[];
  inserts: { at: number; kind: 'sleep' | 'bank' }[];
}

export const EMPTY_RULES: AutopilotRules = { excludedJobs: [], excludedQuests: [], onlyQuests: [], inserts: [] };

export interface AutopilotFile {
  config: AutopilotConfig;
  rules: AutopilotRules;
  plan: { fingerprint: string; savedAt: number; tasks: PlannedTask[] } | null;
  /** Money the autopilot spent on `day` (server date, YYYY-MM-DD), for the daily cap. */
  spent: { day: string; amount: number };
  /** NPC duel results (yours and the autopilot's), newest last: what levels you beat and what they pay. */
  duels: DuelRecord[];
  /** The bank walk the autopilot queued and has not deposited after yet: the deposit stays due on arrival. */
  bankWalk: { queueId: number; townId: number } | null;
  /** Market offers the autopilot bought for quests and has not picked up yet (in the offer's town). */
  pickups: MarketPickup[];
}

export interface MarketPickup {
  offerId: number;
  itemId: number;
  count: number;
  townId: number;
  townName: string;
  at: { x: number; y: number };
  quest: string;
}

export interface DuelRecord {
  at: number;
  level: number;
  won: boolean;
  xp: number;
  energy: number;
}

export const AUTOPILOT_FILE = () => join(CONFIG_DIR, 'autopilot.json');

export function parseAutopilotFile(json: unknown): AutopilotFile {
  const raw = obj(json);
  const config = mergeDefaults(DEFAULT_CONFIG, raw.config);
  // The ranking must hold every goal once; drop unknowns, append missing ones.
  const ranked = arr(obj(raw.config).priority).filter((group): group is Goal => GOALS.some((goal) => goal === group));
  config.priority = [...new Set([...ranked, ...GOALS])];
  const rules = mergeDefaults(EMPTY_RULES, raw.rules);
  const plan =
    isObj(raw.plan) && typeof raw.plan.fingerprint === 'string' && Array.isArray(raw.plan.tasks)
      ? {
          fingerprint: raw.plan.fingerprint,
          savedAt: Number(raw.plan.savedAt) || 0,
          tasks: raw.plan.tasks as PlannedTask[],
        }
      : null;
  const spent =
    isObj(raw.spent) && typeof raw.spent.day === 'string'
      ? { day: raw.spent.day, amount: Number(raw.spent.amount) || 0 }
      : { day: '', amount: 0 };
  const duels: DuelRecord[] = objs(raw.duels)
    .filter((jsonValue) => Number.isFinite(jsonValue.level))
    .slice(-200)
    .map((jsonValue) => ({
      at: Number(jsonValue.at) || 0,
      level: Number(jsonValue.level),
      won: !!jsonValue.won,
      xp: Number(jsonValue.xp) || 0,
      energy: Number(jsonValue.energy) || 0,
    }));
  const bankWalk =
    isObj(raw.bankWalk) && Number.isFinite(raw.bankWalk.queueId) && Number.isFinite(raw.bankWalk.townId)
      ? { queueId: Number(raw.bankWalk.queueId), townId: Number(raw.bankWalk.townId) }
      : null;
  const pickups: MarketPickup[] = objs(raw.pickups)
    .filter(
      (jsonValue) => Number.isFinite(jsonValue.offerId) && Number.isFinite(jsonValue.townId) && isObj(jsonValue.at),
    )
    .map((jsonValue) => ({
      offerId: Number(jsonValue.offerId),
      itemId: Number(jsonValue.itemId) || 0,
      count: Number(jsonValue.count) || 0,
      townId: Number(jsonValue.townId),
      townName: String(jsonValue.townName ?? ''),
      at: { x: Number(obj(jsonValue.at).x) || 0, y: Number(obj(jsonValue.at).y) || 0 },
      quest: String(jsonValue.quest ?? ''),
    }));
  return { config, rules, plan, spent, duels, bankWalk, pickups };
}

export function loadAutopilot(file = AUTOPILOT_FILE()): AutopilotFile {
  try {
    return parseAutopilotFile(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return parseAutopilotFile(null);
  }
}

export function saveAutopilot(data: AutopilotFile, file = AUTOPILOT_FILE()): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    /* preference only */
  }
}

/** Goal weights: custom when set, else by rank. */
/**
 * Expected XP and energy of an NPC duel at `level`, from wins within ±3 levels (needs 2+ results), or null.
 * A loss in the last 24 h at this level or below stops NPC duels (one loss stops them for the day).
 */
export function duelOutlook(record: DuelRecord[], level: number, now: number): { xp: number; energy: number } | null {
  if (record.some((dataValue) => !dataValue.won && dataValue.at > now - 86400)) {
    return null;
  }
  const near = record.filter((dataValue) => Math.abs(dataValue.level - level) <= 3);
  const wins = near.filter((dataValue) => dataValue.won);
  if (near.length < 2 || wins.length < near.length * 0.9) {
    return null;
  }
  const avg = (transform: (dataValue: DuelRecord) => number) =>
    wins.reduce((accumulator, current) => accumulator + transform(current), 0) / wins.length;
  return {
    xp: avg((dataValue) => dataValue.xp),
    energy: Math.max(
      1,
      avg((dataValue) => dataValue.energy),
    ),
  };
}

export function goalWeights(config: AutopilotConfig): Record<Goal, number> {
  if (config.customWeights) {
    return Object.fromEntries(GOALS.map((group) => [group, Math.max(0, config.customWeights?.[group] ?? 0)])) as Record<
      Goal,
      number
    >;
  }
  return Object.fromEntries(config.priority.map((group, index) => [group, RANK_WEIGHTS[index] ?? 0])) as Record<
    Goal,
    number
  >;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (isObj(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

/** Hash of the planner's inputs (key order does not matter); equal hashes mean no replan is needed. */
export function fingerprint(inputs: unknown): string {
  return createHash('sha1')
    .update(JSON.stringify(stable(inputs)))
    .digest('hex')
    .slice(0, 16);
}
