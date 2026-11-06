// Autopilot planner: from a snapshot (character, server queue, jobs, quests, hotels, settings) it plans the
// next tasks greedily along the timeline, safety first: HP sleep → bank → jobs by priority, with energy
// sleeps when sleeping gets the energy sooner than waiting. Pure: no requests; the runner in state.ts sends.
// Job value: each goal's gain per cost, normalised by the best candidate for that goal, weighted by the
// ranking (autopilot-config.ts). Cost: energy (+ walking at the energy it would regenerate meanwhile) or time.

import {
  type AutopilotConfig,
  type AutopilotRules,
  type Goal,
  goalWeights,
  type PlannedTask,
} from './autopilot-config.ts';
import { levelStartXp, type Position } from './character.ts';
import {
  DURATION_KEYS,
  type DurationKey,
  isDoable,
  type JobDurationValues,
  type JobInfo,
  MOTIVATION_LOSS,
  motivationFactor,
  type SpecialKind,
} from './jobs.ts';
import { DEFAULT_WALK_ENERGY_PER_SECOND, type RouteNeed, runGains } from './route.ts';
import { jobPost, sleepPost, walkPost } from './tasks.ts';
import { projectTimeline, regenSeconds, type Timeline, type TimelineStart, type TimelineStep } from './timeline.ts';

export interface HotelOption {
  townId: number;
  name: string;
  at: Position;
  rooms: { key: string; name: string; cost: number; energyRate: number; healthRate: number }[];
}

/** A single-use item's effect, from its usebonus text ("Energy increase: 15%", "Health point bonus: 20%"). */
export interface ConsumableEffect {
  energy: number;
  health: number;
  motivation: number;
}

export function parseConsumable(usebonus: string[], usetype: string): ConsumableEffect | null {
  if (usetype !== 'single') {
    return null;
  }
  const pct = (re: RegExp) =>
    usebonus.reduce((accumulator, current) => accumulator + Number(current.match(re)?.[1] ?? 0), 0) / 100;
  const entry = {
    energy: pct(/^Energy increase: (\d+)%/i),
    health: pct(/^Health point bonus: (\d+)%/i),
    motivation: pct(/^Work motivation increase: (\d+)%/i),
  };
  return entry.energy || entry.health || entry.motivation ? entry : null;
}

/** A town to walk to for quest items: shop purchases (`cost`) and market pickups; `what` says what and for which quest. */
export interface BuyTrip {
  townId: number;
  name: string;
  at: Position;
  cost: number;
  what: string[];
}

/** An item in the bag the autopilot may use: `count` is what is left above the reserve; `value` its shop price. */
export interface Consumable {
  itemId: number;
  name: string;
  count: number;
  value: number;
  effect: ConsumableEffect;
}

export interface PlanInput {
  start: TimelineStart;
  /** The server queue as fixed timeline steps. */
  fixed: TimelineStep[];
  jobs: JobInfo[];
  locations: (groupId: number) => Position[] | undefined;
  wayTime: (from: Position, to: Position) => number;
  config: AutopilotConfig;
  rules: AutopilotRules;
  /** What open quests still need (the Quests goal). */
  needs: RouteNeed[];
  /** Sell value of an item (the Products goal). */
  itemValue: (itemId: number) => number;
  hotels: HotelOption[];
  /** Usable consumables (already filtered by the reserve). */
  consumables?: Consumable[] | undefined;
  homeTownId?: number | undefined;
  /** Named towns, for banking. */
  towns: { id: number; name: string; at: Position }[];
  /**
   * Town of a bank walk already queued: when the queue ends there, deposit first whatever the cash projection
   * says, so no job is queued behind the walk and the trip is not made twice.
   */
  bankTownId?: number | undefined;
  /** Quest shopping / market pickups (Quests module): planned when the town is within `quests.buyTrip`. */
  buyTrips?: BuyTrip[] | undefined;
  /** Discovered silver/gold jobs with the real job/job values for their location. */
  specialJobs?: SpecialJobInput[] | undefined;
  /** Money the autopilot may still spend today. */
  budget: number;
  /** Step keys that keep failing: not planned. */
  skip?: Set<string> | undefined;
  /** Cap on planned jobs (default MAX_JOBS; tests use fewer). The plan otherwise runs to the horizon. */
  maxJobs?: number | undefined;
  /** Exchange rates per goal (best gain per cost); a cancel check passes the current plan's so values compare. */
  rates?: Record<Goal, number> | undefined;
  /** Calibrated multiplier for the danger → HP heuristic. */
  hpScale?: number | undefined;
}

/** Safety cap on jobs in one plan; normally the horizon ends it first. */
export const MAX_JOBS = 200;

export interface Plan {
  tasks: PlannedTask[];
  timeline: Timeline;
  /** Why the first task (or nothing). */
  why: string;
  /** Weighted value of the planned tasks inside the horizon (in units of the exchange rates). */
  value: number;
  /** The server-queued jobs' value, scored like planned ones (state before each run, its quest needs still open). */
  queuedValue: number;
  /** Seconds of walking inside the horizon, server queue included. */
  walk: number;
  /** The exchange rates the values are in: best gain per cost per goal at the plan's start. */
  rates: Record<Goal, number>;
}

/** A cancel-check alternative: keep the first `from` queued tasks, replan the rest. */
export interface CancelOption {
  from: number;
  value: number;
  walk: number;
}

/**
 * Which cut to cancel at, if any: one better than the queue by `margin`, else one worth at most `sameWithin`
 * less that walks `walkSaved` s less. Highest value wins; on a tie the later cut (cancel less).
 */
export function chooseCancel<Value extends CancelOption>(
  cur: CancelOption,
  cuts: Value[],
  candidate: AutopilotConfig['cancel'],
): (Value & { why: 'better' | 'walk' }) | null {
  const top = (list: Value[]) =>
    list.reduce<Value | undefined>(
      (accumulator, current) => (!accumulator || current.value >= accumulator.value - 1e-9 ? current : accumulator),
      undefined,
    );
  const best = top(cuts);
  // A queue worth nothing: anything worth something is better.
  if (cur.value <= 0) {
    return best && best.value > 0 ? { ...best, why: 'better' } : null;
  }
  if (best && best.value > cur.value * (1 + candidate.margin)) {
    return { ...best, why: 'better' };
  }
  const lessWalk = top(
    cuts.filter(
      (options) =>
        options.value >= cur.value * (1 - candidate.sameWithin) && cur.walk - options.walk >= candidate.walkSaved,
    ),
  );
  return lessWalk ? { ...lessWalk, why: 'walk' } : null;
}

/** Expected HP lost on a run: a heuristic until danger damage is known (danger % of 10 % max HP per hour). */
export function expectedHpLoss(danger: number | null, seconds: number, maxHealth: number): number {
  if (!danger) {
    return 0;
  }
  return (danger / 100) * 0.1 * maxHealth * Math.min(1, seconds / 3600);
}

/** A discovered silver/gold job at its exact map location, with the values the game shows there. */
export interface SpecialJobInput {
  job: JobInfo;
  at: Position;
  special: SpecialKind;
  values: Partial<Record<DurationKey, JobDurationValues>>;
  valuesMotivation: number;
}

interface Candidate {
  job: JobInfo;
  duration: DurationKey;
  /** Plan/failure key; special runs carry their kind and coordinates. */
  key: string;
  at: Position;
  travel: number;
  energy: number;
  hpLoss: number;
  /** The values this run pays at this location, before the projected motivation change. */
  values: JobDurationValues;
  special: SpecialKind | null;
  /** The job's own XP for this run (motivation applied), without quest rewards. */
  xp: number;
  gains: Record<string, number>;
  raw: Record<Goal, number>;
  cost: number;
  score: number;
  /** Each goal's share of the score. */
  by: Record<Goal, number>;
}

const GOAL_KEYS: Goal[] = ['quests', 'xp', 'money', 'products'];

/** Best gain per cost of each goal in a candidate list. */
function bestRates(list: { raw: Record<Goal, number>; cost: number }[]): Record<Goal, number> {
  const best: Record<Goal, number> = { quests: 0, xp: 0, money: 0, products: 0 };
  for (const candidate of list) {
    for (const group of GOAL_KEYS) {
      best[group] = Math.max(best[group], candidate.raw[group] / candidate.cost);
    }
  }
  return best;
}

/** The duration key whose run time is closest to `seconds` (queued jobs carry no key). */
function closestDuration(job: JobInfo, seconds: number): DurationKey | undefined {
  let found: DurationKey | undefined;
  let gap = Infinity;
  for (const entryKey of DURATION_KEYS) {
    const jobInfo = job.values[entryKey];
    if (jobInfo && Math.abs(jobInfo.duration - seconds) < gap) {
      [found, gap] = [entryKey, Math.abs(jobInfo.duration - seconds)];
    }
  }
  return found;
}

const GOAL_WORD: Record<Goal, string> = {
  quests: 'quest progress',
  xp: 'XP',
  money: 'money',
  products: 'products to sell',
};

export function planAutopilot(input: PlanInput): Plan {
  const { config: cfg, start, wayTime } = input;
  const mods = cfg.modules;
  const weights = goalWeights(cfg);
  // Plans to the horizon (so plans of short and long runs cover the same time and compare); MAX_JOBS caps it.
  const planJobs = Math.max(1, input.maxJobs ?? MAX_JOBS);
  const maxTasks = planJobs * 3 + 4;
  const horizonEnd = start.now + Math.max(3600, cfg.cancel.horizon);
  const hpScale = input.hpScale ?? 1;
  const slotCost = Math.max(0, cfg.slotCost ?? 0); // a queue slot's worth: short runs leave you idle when the TUI is closed
  let jobsPlanned = 0;
  const opts = { wayTime };
  const walkWeight = (start.maxEnergy * start.energyRegen) / 3600 || DEFAULT_WALK_ENERGY_PER_SECOND;
  // Per hour: a run takes its duration, but its energy must be regenerated too. Base regen runs while you
  // work (max), a hotel room only while you sleep (added); whichever gets the energy back sooner counts.
  const perEnergyBase = start.energyRegen > 0 ? 3600 / (start.maxEnergy * start.energyRegen) : Infinity;
  const bestRoom = Math.max(
    0,
    ...input.hotels.flatMap((hotel) =>
      hotel.rooms.filter((result) => result.cost <= input.budget).map((result) => result.energyRate),
    ),
  );
  const perEnergyRoom = bestRoom > 0 ? 3600 / (start.maxEnergy * bestRoom) : Infinity;
  const runSeconds = (duration: number, energy: number) => {
    const time = Math.min(Math.max(duration, energy * perEnergyBase), duration + energy * perEnergyRoom);
    return Number.isFinite(time) ? time : duration;
  };
  const skip = input.skip ?? new Set<string>();
  const excluded = new Set(input.rules.excludedJobs);
  const remaining: Record<string, number> = Object.fromEntries(
    input.needs.map((routeNeed) => [routeNeed.key, routeNeed.amount]),
  );
  const totals: Record<string, number> = Object.fromEntries(
    input.needs.map((routeNeed) => [routeNeed.key, routeNeed.amount]),
  );
  const drop = new Map<number, number>();
  // Snapshot before the queued runs' gains are subtracted, so each queued run is scored against what was still needed then.
  const beforeQueue = { remaining: { ...remaining }, drop: new Map<number, number>() };
  // Jobs already queued drop items too: what they will bring is not needed again.
  for (const st of input.fixed) {
    if (st.kind !== 'job') {
      continue;
    }
    const job = input.jobs.find((jobInfo) => jobInfo.id === st.jobId);
    const dur = job && closestDuration(job, st.duration);
    if (!job || !dur) {
      continue;
    }
    drop.set(job.id, (drop.get(job.id) ?? 0) + MOTIVATION_LOSS[dur]);
    const special = input.specialJobs?.find(
      (entry) => entry.job.id === job.id && entry.at.x === st.at?.x && entry.at.y === st.at?.y,
    );
    const values = special?.values[dur] ?? job.values[dur];
    for (const [entryKey, currentValue] of Object.entries(runGains(job, dur, input.needs, values))) {
      if ((remaining[entryKey] ?? 0) > 0) {
        remaining[entryKey] = Math.max(0, (remaining[entryKey] ?? 0) - currentValue);
      }
    }
  }
  const needInfo = new Map(input.needs.map((routeNeed) => [routeNeed.key, routeNeed]));
  let rates: Record<Goal, number> | null = input.rates ?? null;
  let budget = input.budget;
  let banked = false;
  const stock = new Map((input.consumables ?? []).map((consumable) => [consumable.itemId, consumable.count]));
  const useMod = mods.consumables;

  /** The cheapest usable item per point of `kind`, with at least `min` of it (fraction of max). */
  const pickItem = (kind: keyof ConsumableEffect, min: number) => {
    let best: Consumable | null = null;
    for (const consumable of input.consumables ?? []) {
      if (
        (stock.get(consumable.itemId) ?? 0) <= 0 ||
        consumable.effect[kind] < min ||
        skip.has(`use:${consumable.itemId}`)
      ) {
        continue;
      }
      if (!best || consumable.value / consumable.effect[kind] < best.value / best.effect[kind]) {
        best = consumable;
      }
    }
    return best;
  };
  const useTask = (consumable: Consumable, reason: string): PlannedTask => {
    stock.set(consumable.itemId, (stock.get(consumable.itemId) ?? 0) - 1);
    return {
      module: 'consumables',
      key: `use:${consumable.itemId}`,
      why: reason,
      step: {
        kind: 'action',
        title: `Use ${consumable.name}`,
        energy: consumable.effect.energy * start.maxEnergy,
        health: consumable.effect.health * start.maxHealth,
      },
      action: { type: 'use', itemId: consumable.itemId },
    };
  };

  const tasks: PlannedTask[] = [];
  let tl = projectTimeline(start, input.fixed, opts);
  const push = (...plannedTasks: PlannedTask[]) => {
    tasks.push(...plannedTasks);
    tl = projectTimeline(start, [...input.fixed, ...tasks.map((plannedTask) => plannedTask.step)], opts);
  };

  /**
   * All job candidates from a state, scored by the priority against the exchange rates. `level` sets the
   * level-up refund (a level-up refills energy: each XP point brings maxEnergy ÷ XP-per-level of it back).
   * `done.drop` carries the motivation already spent by the queue and earlier planned runs.
   */
  const candidates = (from: Position, health: number, level = start.level, done = { remaining, drop }): Candidate[] => {
    const list: Candidate[] = [];
    const xpPerLevel = levelStartXp(level + 1, start.maxLevel) - levelStartXp(level, start.maxLevel);
    const refundPerXp = xpPerLevel > 0 ? start.maxEnergy / xpPerLevel : 0;

    /** Scores one run at one location. `values` are the rewards the game shows there now. */
    const addCandidate = (
      job: JobInfo,
      duration: DurationKey,
      key: string,
      at: Position,
      travel: number,
      values: JobDurationValues,
      special: SpecialKind | null,
    ): void => {
      if (skip.has(key)) {
        return;
      }
      const hpLoss = expectedHpLoss(job.danger, values.duration, start.maxHealth) * hpScale;
      // Never plan a run that could take HP under the sleep threshold, HP sleeps on or off. A run that costs
      // no HP is always fine: under the threshold with no hotel, safe jobs go on while HP regenerates.
      if (hpLoss > 0 && health - hpLoss < cfg.hp.sleepBelow * start.maxHealth) {
        return;
      }
      const gains = runGains(job, duration, input.needs, values);
      // Quest progress (weighted by deadline), plus the share of the quests' rewards this progress earns.
      let quests = 0;
      let rewardXp = 0;
      let rewardMoney = 0;
      for (const [entryKey, currentValue] of Object.entries(gains)) {
        const rem = done.remaining[entryKey] ?? 0;
        if (rem <= 1e-9) {
          continue;
        }
        const got = Math.min(rem, currentValue);
        const entry = needInfo.get(entryKey);
        quests += (got / (totals[entryKey] || 1)) * (entry?.weight ?? 1);
        rewardXp += got * (entry?.xpPerUnit ?? 0);
        rewardMoney += got * (entry?.moneyPerUnit ?? 0);
      }
      // Motivation only changes at 25 % breakpoints; products do not depend on it.
      const baseFactor = motivationFactor(job.motivation);
      const entryFactor = motivationFactor(Math.max(0, job.motivation - (done.drop.get(job.id) ?? 0)));
      const fade = baseFactor > 0 ? entryFactor / baseFactor : 0;
      const xp = values.experience * fade;
      const products = (values.items ?? []).reduce(
        (accumulator, current) => accumulator + current.expected * input.itemValue(current.itemId),
        0,
      );
      const hpSeconds = hpLoss > 0 ? regenSeconds(0, hpLoss, start.maxHealth, start.healthRegen) : 0;
      // Energy net of the level-up refund; at least a quarter (the refill only tops up to the max).
      const energy = Math.max(0.25 * values.energy, values.energy - (xp + rewardXp) * refundPerXp);
      const extra = (Number.isFinite(hpSeconds) ? hpSeconds : 0) + slotCost;
      const cost =
        cfg.per === 'energy'
          ? energy + (travel + extra) * walkWeight
          : runSeconds(values.duration, energy) + travel + extra;
      list.push({
        job,
        duration,
        key,
        at,
        travel,
        energy: values.energy,
        hpLoss,
        values,
        special,
        xp,
        gains,
        cost: Math.max(cost, 1e-6),
        score: 0,
        by: { quests: 0, xp: 0, money: 0, products: 0 },
        raw: { quests, xp: xp + rewardXp, money: values.money * fade + rewardMoney, products },
      });
    };

    for (const job of input.jobs) {
      if (!isDoable(job) || excluded.has(job.id)) {
        continue;
      }
      const locs = input.locations(job.groupid);
      if (!locs?.length) {
        continue;
      }
      const firstLoc = locs[0];
      if (!firstLoc) {
        continue;
      }
      let at = firstLoc;
      let travel = wayTime(from, at);
      for (const position of locs) {
        const time = wayTime(from, position);
        if (time < travel) {
          [at, travel] = [position, time];
        }
      }
      for (const duration of DURATION_KEYS) {
        const values = job.values[duration];
        if (!values) {
          continue;
        }
        addCandidate(job, duration, `job:${job.id}:${duration}`, at, travel, values, null);
      }
    }

    for (const special of input.specialJobs ?? []) {
      if (!isDoable(special.job) || excluded.has(special.job.id)) {
        continue;
      }
      const travel = wayTime(from, special.at);
      for (const duration of DURATION_KEYS) {
        const values = special.values[duration];
        if (!values) {
          continue;
        }
        addCandidate(
          special.job,
          duration,
          `job:${special.job.id}:${duration}:${special.special}:${special.at.x},${special.at.y}`,
          special.at,
          travel,
          values,
          special.special,
        );
      }
    }

    // Each goal in units of its exchange rate (the best rate at the plan's start), so a crumb of quest
    // progress stays a crumb and values of different plans compare. A goal with no rate yet: this list's best.
    const best = bestRates(list);
    for (const group of GOAL_KEYS) {
      if (rates && rates[group] > 0) {
        best[group] = rates[group];
      }
    }
    for (const candidate of list) {
      candidate.score = 0;
      for (const groupInfo of Object.keys(best) as Goal[]) {
        candidate.by[groupInfo] =
          best[groupInfo] > 0
            ? (weights[groupInfo] * (candidate.raw[groupInfo] / candidate.cost)) / best[groupInfo]
            : 0;
        candidate.score += candidate.by[groupInfo];
      }
    }
    return list
      .filter((candidate) => candidate.score > 0)
      .sort((firstValue, second) => second.score - firstValue.score);
  };

  /** What a run does for open quests, before it is counted: `Cotton for "Farmer's woes" (5 left)`. */
  const questParts = (gains: Record<string, number>): string[] =>
    input.needs
      .filter((routeNeed) => (gains[routeNeed.key] ?? 0) > 0 && (remaining[routeNeed.key] ?? 0) > 1e-9)
      .map((routeNeed) => {
        const left = remaining[routeNeed.key] ?? 0;
        const amount = routeNeed.unit === 'seconds' ? `${Math.ceil(left / 60)} min` : String(Math.ceil(left));
        const quest = routeNeed.quests.length
          ? ` for "${routeNeed.quests[0]}"${routeNeed.quests.length > 1 ? ` +${routeNeed.quests.length - 1}` : ''}`
          : '';
        return `${routeNeed.label}${quest} (${amount} left)`;
      });

  /** Energy to reach the next level with the best XP-per-energy job; null when out of reach of one refill. */
  const levelUpEnergy = (from: Position, health: number, experience: number, level: number): number | null => {
    const gap = levelStartXp(level + 1, start.maxLevel) - experience;
    if (gap <= 0) {
      return 0;
    }
    let best: { xp: number; energy: number } | null = null;
    for (const candidate of candidates(from, health, level)) {
      if (candidate.energy <= 0 || candidate.xp <= 0) {
        continue;
      }
      if (!best || candidate.xp / candidate.energy > best.xp / best.energy) {
        best = { xp: candidate.xp, energy: candidate.energy };
      }
    }
    if (!best) {
      return null;
    }
    const need = Math.ceil(gap / best.xp) * best.energy;
    return need <= start.maxEnergy ? need : null;
  };

  /** A sleep that reaches the wake targets soonest (own town first when close), with when it is done and the walk there. */
  const sleepPlan = (
    reason: 'hp' | 'energy',
    minEnergy: number,
    next?: { title: string; xp: number },
  ): { task: PlannedTask; ready: number; travel: number; energy: number } | null => {
    const source = tl.final;
    const wake = cfg.wake;
    let energy = source.energy;
    const reasons: string[] = [];
    // The run after the sleep levels up by itself: its energy is enough, the level-up refills the rest.
    const nextLevels =
      wake.levelUp &&
      !!next &&
      source.level < (start.maxLevel ?? Infinity) &&
      source.experience + next.xp >= levelStartXp(source.level + 1, start.maxLevel);
    const lvl =
      wake.levelUp && !nextLevels ? levelUpEnergy(source.at, source.health, source.experience, source.level) : null;
    if (nextLevels) {
      energy = Math.max(energy, minEnergy);
      reasons.push(`enough for ${next?.title ?? 'the next job'}, which levels up`);
    } else if (lvl !== null && lvl > energy) {
      energy = lvl;
      reasons.push('enough to level up');
    }
    if (wake.stretch && minEnergy * 4 > energy) {
      energy = minEnergy * 4;
      reasons.push('the next stretch');
    }
    if (wake.full || !reasons.length) {
      energy = start.maxEnergy;
      if (wake.full || reason === 'energy') {
        reasons.push('full');
      }
    }
    energy = Math.min(start.maxEnergy, Math.max(energy, minEnergy));
    const health =
      wake.hpSafe || reason === 'hp' ? Math.max(source.health, cfg.hp.wakeAbove * start.maxHealth) : source.health;
    if (reason === 'hp') {
      reasons.push(`HP ${Math.round(cfg.hp.wakeAbove * 100)}%`);
    }
    let best: { task: PlannedTask; ready: number; travel: number; own: boolean } | null = null;
    for (const hotel of input.hotels) {
      const travel = wayTime(source.at, hotel.at);
      const own = hotel.townId === input.homeTownId && travel <= cfg.ownTownWithin;
      // What base regen brings on the walk there: the sleep only makes up the rest.
      const arriveEnergy = Math.min(
        start.maxEnergy,
        source.energy + (start.maxEnergy * start.energyRegen * travel) / 3600,
      );
      const arriveHealth = Math.min(
        start.maxHealth,
        source.health + (start.maxHealth * start.healthRegen * travel) / 3600,
      );
      for (const result of hotel.rooms) {
        if (result.cost > budget || result.energyRate <= 0) {
          continue;
        }
        if (skip.has(`sleep:${hotel.townId}:${result.key}`)) {
          continue;
        }
        const secs = Math.max(
          regenSeconds(arriveEnergy, energy, start.maxEnergy, result.energyRate),
          regenSeconds(arriveHealth, health, start.maxHealth, result.healthRate),
        );
        if (!Number.isFinite(secs)) {
          continue;
        }
        const ready = travel + secs;
        const better = !best || (own && !best.own) || (own === best.own && ready < best.ready);
        if (!better) {
          continue;
        }
        best = {
          own,
          ready,
          travel,
          task: {
            module: reason === 'hp' ? 'hpSleep' : 'energySleep',
            key: `sleep:${hotel.townId}:${result.key}`,
            step: {
              kind: 'sleep',
              title: `Sleep: ${hotel.name} ${result.name}`,
              at: hotel.at,
              energyRate: result.energyRate,
              healthRate: result.healthRate,
              seconds: secs,
              cost: result.cost,
            },
            post: sleepPost(hotel.townId, result.key),
            wake: { energy, health },
            why: `${reason === 'hp' ? `HP low (${Math.round(source.health)}/${start.maxHealth})` : `energy low (${Math.floor(source.energy)})`}: sleep until ${reasons.join(' + ')}`,
          },
        };
      }
    }
    return best ? { task: best.task, ready: best.ready, travel: best.travel, energy } : null;
  };

  /** Walk to the bank town and deposit; null when no bank is within the allowed detour. */
  const bankPlan = (bankOptions: { anyDistance?: boolean; townId?: number | undefined } = {}): PlannedTask[] | null => {
    const source = tl.final;
    const named = input.towns.filter((target) => !skip.has(`bank:${target.id}`));
    if (!named.length) {
      return null;
    }
    const home = named.find((target) => target.id === input.homeTownId);
    let town =
      named.find((target) => target.id === bankOptions.townId) ??
      (home && wayTime(source.at, home.at) <= cfg.ownTownWithin ? home : undefined);
    if (!town) {
      town = named.reduce((accumulator, current) =>
        wayTime(source.at, current.at) < wayTime(source.at, accumulator.at) ? current : accumulator,
      );
      // Without anyDistance, only bank when the route passes a town.
      if (!bankOptions.anyDistance && wayTime(source.at, town.at) > cfg.bank.maxDetour) {
        return null;
      }
    }
    const cash = `$${Math.round(source.cash).toLocaleString('en-US')}`;
    const why =
      source.cash > cfg.bank.above
        ? `cash ${cash} is over $${cfg.bank.above.toLocaleString('en-US')}: banking it`
        : `the queued bank walk ends here: depositing ${cash}`;
    const deposit: PlannedTask = {
      module: 'bank',
      key: `bank:${town.id}`,
      why,
      step: { kind: 'action', title: `Deposit at ${town.name}`, cash: -source.cash },
      action: { type: 'deposit', townId: town.id },
    };
    if (source.at.x === town.at.x && source.at.y === town.at.y) {
      return [deposit];
    }
    return [
      {
        module: 'bank',
        key: `walk:${town.id}`,
        why,
        step: { kind: 'walk', title: `Walk to ${town.name} (bank)`, at: town.at },
        post: walkPost(town.id, 'town'),
      },
      deposit,
    ];
  };

  /** The nearest shopping trip within the buy trip and the budget: walk there, then buy / pick up. */
  const trips = [...(input.buyTrips ?? [])];
  const tripPlan = (): PlannedTask[] | null => {
    const source = tl.final;
    let best = -1;
    let bestWay = Infinity;
    for (const [index, target] of trips.entries()) {
      const width = wayTime(source.at, target.at);
      if (target.cost > budget || width > cfg.quests.buyTrip || skip.has(`buy:${target.townId}`) || width >= bestWay) {
        continue;
      }
      [best, bestWay] = [index, width];
    }
    if (best < 0) {
      return null;
    }
    const targetValue = trips.splice(best, 1)[0];
    if (!targetValue) {
      return null;
    }
    budget -= targetValue.cost;
    const why = `quest items: ${targetValue.what.join('; ')}`;
    const buy: PlannedTask = {
      module: 'quests',
      key: `buy:${targetValue.townId}`,
      why,
      step: {
        kind: 'action',
        title: `Buy at ${targetValue.name}${targetValue.cost ? ` ($${Math.round(targetValue.cost).toLocaleString('en-US')})` : ''}`,
        cash: -targetValue.cost,
      },
      action: { type: 'buy', townId: targetValue.townId },
    };
    if (source.at.x === targetValue.at.x && source.at.y === targetValue.at.y) {
      return [buy];
    }
    return [
      {
        module: 'quests',
        key: `walk:${targetValue.townId}`,
        why,
        step: { kind: 'walk', title: `Walk to ${targetValue.name} (quest items)`, at: targetValue.at },
        post: walkPost(targetValue.townId, 'town'),
      },
      buy,
    ];
  };

  // Exchange rates: fixed for the whole plan, from where the server queue ends (unless passed in).
  if (!rates) {
    rates = bestRates(candidates(tl.final.at, tl.final.health, tl.final.level));
  }

  // Queued jobs, scored like planned ones in queue order, so a queue and an alternative without it compare.
  let queuedValue = 0;
  input.fixed.forEach((st, index) => {
    if (st.kind !== 'job') {
      return;
    }
    const job = input.jobs.find((jobInfo) => jobInfo.id === st.jobId);
    const dur = job && closestDuration(job, st.duration);
    const self = tl.steps[index];
    if (!job || !dur || !self) {
      return;
    }
    const prev = tl.steps[index - 1];
    const special = input.specialJobs?.find(
      (entry) => entry.job.id === job.id && entry.at.x === st.at?.x && entry.at.y === st.at?.y,
    );
    const values = special?.values[dur] ?? job.values[dur];
    const foundValue = candidates(
      prev?.at ?? start.at,
      prev?.health ?? start.health,
      prev?.level ?? start.level,
      beforeQueue,
    ).find(
      (xCoord) =>
        xCoord.job.id === job.id &&
        xCoord.duration === dur &&
        (!special || (xCoord.special === special.special && xCoord.at.x === special.at.x)),
    );
    const inside =
      self.end <= horizonEnd ? 1 : Math.max(0, (horizonEnd - self.start) / Math.max(1, self.end - self.start));
    if (foundValue) {
      queuedValue += foundValue.score * foundValue.cost * inside;
    }
    beforeQueue.drop.set(job.id, (beforeQueue.drop.get(job.id) ?? 0) + MOTIVATION_LOSS[dur]);
    for (const [entryKey, currentValue] of Object.entries(runGains(job, dur, input.needs, values))) {
      if ((beforeQueue.remaining[entryKey] ?? 0) > 0) {
        beforeQueue.remaining[entryKey] = Math.max(0, (beforeQueue.remaining[entryKey] ?? 0) - currentValue);
      }
    }
  });

  // Your inserted sleeps / bank stops, in time order: each goes in once the plan reaches its time.
  const inserts = [...input.rules.inserts].sort((firstValue, second) => firstValue.at - second.at);
  let value = 0;
  while (tasks.length < maxTasks && jobsPlanned < planJobs && tl.end < horizonEnd) {
    const source = tl.final;
    if (inserts.length && (inserts[0]?.at ?? Number.POSITIVE_INFINITY) <= tl.end) {
      const ins = inserts.shift();
      if (!ins) {
        continue;
      }
      const key = `insert:${ins.kind}:${ins.at}`;
      const bank = ins.kind === 'bank' ? bankPlan({ anyDistance: true }) : null;
      const got = ins.kind === 'sleep' ? sleepPlan('energy', 0)?.task : bank?.[0];
      if (got) {
        push({ ...got, key, why: `you inserted a ${ins.kind === 'sleep' ? 'sleep' : 'bank stop'} here` });
      }
      const lastBank = bank?.at(-1);
      if (ins.kind === 'bank' && got?.step.kind === 'walk' && lastBank) {
        push(lastBank);
      }
      continue;
    }
    if (mods.hpSleep && source.health < cfg.hp.sleepBelow * start.maxHealth) {
      // A health item that lifts HP back over the threshold beats walking to a hotel.
      const item =
        useMod && cfg.consumables.health
          ? pickItem('health', (cfg.hp.sleepBelow * start.maxHealth - source.health) / start.maxHealth)
          : null;
      if (item) {
        push(useTask(item, `HP ${Math.round(source.health)}/${start.maxHealth}: use ${item.name} instead of sleeping`));
        continue;
      }
      const sl = sleepPlan('hp', 0);
      if (sl) {
        budget -= (sl.task.step as { cost?: number }).cost ?? 0;
        push(sl.task);
        continue;
      }
    }
    const bankDue =
      input.bankTownId !== undefined &&
      source.cash > 0 &&
      input.towns.some(
        (target) => target.id === input.bankTownId && target.at.x === source.at.x && target.at.y === source.at.y,
      );
    if (mods.bank && !banked && (source.cash > cfg.bank.above || bankDue)) {
      // Once per plan (the next replan, after depositing, looks again); no town in reach yet: try after each step.
      const task = bankPlan({ townId: bankDue ? input.bankTownId : undefined });
      if (task) {
        banked = true;
        push(...task);
        continue;
      }
    }
    if (mods.quests && trips.length) {
      // Each trip once per plan; one out of reach now is tried again after the next step.
      const taskInfo = tripPlan();
      if (taskInfo) {
        push(...taskInfo);
        continue;
      }
    }
    if (!mods.jobs) {
      break;
    }
    const candidate = candidates(source.at, source.health, source.level)[0];
    if (!candidate) {
      break;
    }
    if (useMod && cfg.consumables.motivation && candidate.job.motivation <= 0.75) {
      const item = pickItem('motivation', 0.01);
      if (
        item &&
        !tasks.some((task) => task.key === `use:${item.itemId}` && task.step.title.includes(candidate.job.name))
      ) {
        push({
          ...useTask(
            item,
            `${candidate.job.name} motivation ${Math.round(candidate.job.motivation * 100)}%: use ${item.name}`,
          ),
          step: { kind: 'action', title: `Use ${item.name} (${candidate.job.name})` },
        });
        candidate.job = {
          ...candidate.job,
          motivation: Math.min(1, candidate.job.motivation + item.effect.motivation),
        };
      }
    }
    if (source.energy < candidate.energy) {
      const sl = mods.energySleep
        ? sleepPlan('energy', candidate.energy, { title: candidate.job.name, xp: candidate.xp })
        : null;
      const wait = regenSeconds(source.energy, candidate.energy, start.maxEnergy, start.energyRegen);
      // A hotel within the own-town distance beats an item; else an item when it saves at least 30 minutes.
      const hotelNear = !!sl && sl.travel <= cfg.ownTownWithin;
      const other = Math.min(wait, sl ? sl.ready : Infinity);
      const item =
        useMod && cfg.consumables.energy && !hotelNear
          ? pickItem('energy', (candidate.energy - source.energy) / start.maxEnergy)
          : null;
      if (item && other >= 1800) {
        push(
          useTask(
            item,
            `energy ${Math.floor(source.energy)}: use ${item.name} (saves ${Math.round(Math.min(other, 86400) / 60)} min)`,
          ),
        );
        continue;
      }
    }
    if (source.energy < candidate.energy && mods.energySleep) {
      const sl = sleepPlan('energy', candidate.energy, { title: candidate.job.name, xp: candidate.xp });
      const wait = regenSeconds(source.energy, sl?.energy ?? candidate.energy, start.maxEnergy, start.energyRegen);
      if (sl && sl.ready < wait) {
        budget -= (sl.task.step as { cost?: number }).cost ?? 0;
        push(sl.task);
        continue;
      }
    }
    const values = candidate.values;
    const goal = (Object.keys(candidate.by) as Goal[]).reduce((accumulator, current) =>
      candidate.by[current] > candidate.by[accumulator] ? current : accumulator,
    );
    const forQuests = questParts(candidate.gains);
    const special = candidate.special ? ` · ${candidate.special} job` : '';
    push({
      module: 'jobs',
      key: candidate.key,
      step: {
        kind: 'job',
        title: `${candidate.job.name}${candidate.special ? ` (${candidate.special})` : ''}`,
        jobId: candidate.job.id,
        at: candidate.at,
        duration: values.duration,
        energy: values.energy,
        xp: values.experience,
        money: values.money,
        hpLoss: candidate.hpLoss,
      },
      post: jobPost(candidate.job.id, candidate.at, values.duration),
      value: candidate.score * candidate.cost,
      why:
        goal === 'quests' && forQuests.length
          ? `quest: ${forQuests.join('; ')}${special}`
          : `best ${GOAL_WORD[goal]} per ${cfg.per === 'energy' ? 'energy' : 'hour'}${forQuests.length ? ` · also ${forQuests.join('; ')}` : ''}${special}`,
    });
    const last = tl.steps[tl.steps.length - 1];
    if (!last) {
      continue;
    }
    // Value inside the horizon; a run crossing it counts for its share.
    const inside =
      last.end <= horizonEnd ? 1 : Math.max(0, (horizonEnd - last.start) / Math.max(1, last.end - last.start));
    value += candidate.score * candidate.cost * inside;
    drop.set(candidate.job.id, (drop.get(candidate.job.id) ?? 0) + MOTIVATION_LOSS[candidate.duration]);
    jobsPlanned++;
    for (const [gainKey, gainValue] of Object.entries(candidate.gains)) {
      if ((remaining[gainKey] ?? 0) > 1e-9) {
        remaining[gainKey] = Math.max(0, (remaining[gainKey] ?? 0) - gainValue);
      }
    }
  }
  const first = tasks[0];
  const why =
    first?.why ??
    (!mods.jobs ? 'Queue jobs is off.' : 'Nothing worth doing (no doable job, or everything is excluded).');
  const walk = tl.steps.reduce(
    (accumulator, st) => accumulator + Math.max(0, Math.min(st.depart + st.travel, horizonEnd) - st.depart),
    0,
  );
  return { tasks, timeline: tl, why, value, queuedValue, walk, rates };
}
