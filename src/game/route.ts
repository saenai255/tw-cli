// Quest route planner: which jobs to do, where, how long and in what order to collect what open quests
// still need (items that jobs drop, and "do job X" requirements). Greedy: from the current position,
// repeatedly take the job run that covers the most outstanding need per cost, then move there.
// Drop amounts use the job window's numbers: (prop + probBonus)% per run from work/index, i.e. 767% ≈ 7.67
// items expected per run. These are expectations, not guarantees; the plan is redone after each refresh.
import type { Position } from './character.ts';
import { baseId } from './items.ts';
import type { DurationKey, JobDurationValues, JobInfo } from './jobs.ts';
import { DURATION_KEYS, isDoable } from './jobs.ts';
import type { Quest, QuestRequirement } from './quests.ts';

export type RouteObjective = 'energy' | 'time';

/** Walking costs about one energy per ten minutes when no live regeneration figure is available. */
export const DEFAULT_WALK_ENERGY_PER_SECOND = 1 / 600;

export interface RouteNeed {
  key: string; // "item:<base>" | "job:<id>"
  label: string;
  /** Items: how many; job requirements: runs or seconds (see unit). */
  amount: number;
  unit: 'items' | 'runs' | 'seconds';
  itemId?: number;
  jobId?: number;
  quests: string[];
  /** Autopilot extras (state.autopilotNeeds): urgency (1 normal, up to 2 for a quest about to expire). */
  weight?: number;
  /** The quests' XP / money rewards per unit of this need (each quest's reward spread over what it still needs). */
  xpPerUnit?: number;
  moneyPerUnit?: number;
}

export interface RouteStop {
  job: JobInfo;
  at: Position;
  duration: DurationKey;
  runs: number;
  /** Travel to this stop from the previous one (seconds). */
  travel: number;
  /** Expected progress per need key over all runs. */
  gains: Record<string, number>;
  energy: number;
  seconds: number;
  xp: number;
  money: number;
}

export interface RoutePlan {
  needs: RouteNeed[];
  stops: RouteStop[];
  /** Needs no doable job covers (bought, quest items, not enough labor points, …), with the reason. */
  unmet: { need: RouteNeed; why: string }[];
  /** Needs left after the run limit (rare). */
  leftover: Record<string, number>;
  totals: { energy: number; seconds: number; travel: number; xp: number; money: number; runs: number };
  /** Runs (in order) whose energy fits in `energyAvailable`; all runs when no budget was given. */
  fitRuns: number;
  /** Energy missing for the whole route (0 when it fits or no budget was given). */
  energyShort: number;
}

/** "(0/4)" → 4 runs left; "Trading (30 minutes)" → 1800 s; else the jsInfo count. */
function jobRequirementAmount(requirement: QuestRequirement): { amount: number; unit: 'runs' | 'seconds' } {
  const frac = requirement.info.match(/\((\d+)\s*\/\s*(\d+)\)/);
  if (frac) {
    return { amount: Math.max(0, Number(frac[2]) - Number(frac[1])), unit: 'runs' };
  }
  const time = requirement.info.match(/(\d+)\s*(second|minute|hour)/i);
  if (time) {
    const unitSeconds = { second: 1, minute: 60, hour: 3600 } as Record<string, number>;
    return {
      amount: Number(time[1]) * (unitSeconds[time[2]?.toLowerCase() ?? ''] ?? 1),
      unit: 'seconds',
    };
  }
  const count = requirement.count ?? 1;
  return count >= 15 ? { amount: count, unit: 'seconds' } : { amount: count, unit: 'runs' };
}

/** Outstanding needs of these quests, summed per item / job; items already in the bag are subtracted. */
export function questNeeds(
  quests: Quest[],
  have: (itemId: number) => number,
  itemName: (id: number) => string,
  jobName: (id: number) => string,
): RouteNeed[] {
  const needs = new Map<string, RouteNeed>();
  const add = (count: Omit<RouteNeed, 'quests'>, quest: string) => {
    const cur = needs.get(count.key);
    if (cur) {
      cur.amount += count.amount;
      if (!cur.quests.includes(quest)) {
        cur.quests.push(quest);
      }
    } else {
      needs.set(count.key, { ...count, quests: [quest] });
    }
  };
  for (const currentQuest of quests) {
    for (const requirement of currentQuest.requirements) {
      if (requirement.solved) {
        continue;
      }
      if (requirement.itemId !== undefined) {
        add(
          {
            key: `item:${baseId(requirement.itemId)}`,
            label: itemName(requirement.itemId),
            amount: requirement.count ?? 1,
            unit: 'items',
            itemId: requirement.itemId,
          },
          currentQuest.soloTitle || currentQuest.title,
        );
      } else if (requirement.jobId !== undefined) {
        const { amount, unit } = jobRequirementAmount(requirement);
        if (amount > 0) {
          add(
            {
              key: `job:${requirement.jobId}:${unit}`,
              label: jobName(requirement.jobId),
              amount,
              unit,
              jobId: requirement.jobId,
            },
            currentQuest.soloTitle || currentQuest.title,
          );
        }
      }
    }
  }
  for (const need of needs.values()) {
    if (need.unit === 'items' && need.itemId !== undefined) {
      need.amount = Math.max(0, need.amount - have(need.itemId));
    }
  }
  return [...needs.values()].filter((need) => need.amount > 0);
}

export interface PlanInput {
  needs: RouteNeed[];
  jobs: JobInfo[];
  /** Map locations of a job group. */
  locations: (groupId: number) => Position[] | undefined;
  from: Position;
  wayTime: (from: Position, to: Position) => number;
  objective?: RouteObjective;
  maxRuns?: number;
  /**
   * Energy-mode weight of walking: energy per second of walking. Walking costs time, not energy; time is
   * worth the energy that regenerates meanwhile (maxEnergy · energyRegenFactor / 3600). Default 1/600.
   */
  walkEnergyPerSecond?: number;
  /** Energy available now: the plan reports how many runs fit (`fitRuns`) and the shortfall. */
  energyAvailable?: number;
}

/** Expected progress of one run of `job` for `duration` towards each need. */
export function runGains(
  job: JobInfo,
  duration: DurationKey,
  needs: RouteNeed[],
  jobInfo: JobDurationValues | undefined = job.values[duration],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!jobInfo) {
    return out;
  }
  for (const need of needs) {
    if (need.unit === 'items' && need.itemId !== undefined) {
      const itemId = need.itemId;
      const found = jobInfo.items?.find((index) => baseId(index.itemId) === baseId(itemId));
      if (found && found.expected > 0) {
        out[need.key] = found.expected;
      }
    } else if (need.jobId === job.id) {
      out[need.key] = need.unit === 'runs' ? 1 : jobInfo.duration;
    }
  }
  return out;
}

function nearest(
  locs: Position[] | undefined,
  from: Position,
  way: (position: Position, positionValue: Position) => number,
): { at: Position; travel: number } | null {
  let best: { at: Position; travel: number } | null = null;
  for (const at of locs ?? []) {
    const timeValue = way(from, at);
    if (!best || timeValue < best.travel) {
      best = { at, travel: timeValue };
    }
  }
  return best;
}

export function planRoute(input: PlanInput): RoutePlan {
  const { needs, jobs, from, wayTime } = input;
  const objective = input.objective ?? 'energy';
  const maxRuns = input.maxRuns ?? 300;
  const walkWeight =
    input.walkEnergyPerSecond && input.walkEnergyPerSecond > 0
      ? input.walkEnergyPerSecond
      : DEFAULT_WALK_ENERGY_PER_SECOND;
  const remaining: Record<string, number> = Object.fromEntries(needs.map((need) => [need.key, need.amount]));
  const unmet: RoutePlan['unmet'] = [];

  // Candidates: doable jobs × durations that make progress on some need.
  type Cand = { job: JobInfo; duration: DurationKey; gains: Record<string, number> };
  const cands: Cand[] = [];
  for (const job of jobs) {
    if (!isDoable(job) || !input.locations(job.groupid)?.length) {
      continue;
    }
    for (const duration of DURATION_KEYS) {
      const gains = runGains(job, duration, needs);
      if (Object.keys(gains).length) {
        cands.push({ job, duration, gains });
      }
    }
  }
  for (const need of needs) {
    if (cands.some((candidate) => candidate.gains[need.key])) {
      continue;
    }
    let why = 'no job drops it (buy it, or it comes from another quest)';
    if (need.jobId !== undefined) {
      const found = jobs.find((jobInfo) => jobInfo.id === need.jobId);
      why = !found
        ? 'job unknown'
        : !isDoable(found)
          ? `not enough labor points (${found.laborPoints})`
          : 'job has no known location';
    } else if (
      need.itemId !== undefined &&
      jobs.some((jobInfo) =>
        Object.values(jobInfo.values).some((durationValues) =>
          durationValues?.items?.some((drop) => baseId(drop.itemId) === baseId(need.itemId ?? 0)),
        ),
      )
    ) {
      why = 'only jobs you lack labor points for drop it';
    }
    unmet.push({ need: need, why });
    delete remaining[need.key];
  }

  const stops: RouteStop[] = [];
  let pos = from;
  let runs = 0;
  const open = () => Object.values(remaining).some((value) => value > 1e-9);
  while (open() && runs < maxRuns) {
    let best: { c: Cand; at: Position; travel: number; score: number } | null = null;
    for (const candidate of cands) {
      let fractionClosed = 0;
      for (const [key, value] of Object.entries(candidate.gains)) {
        const rem = remaining[key] ?? 0;
        if (rem <= 1e-9) {
          continue;
        }
        const total = needs.find((need) => need.key === key)?.amount;
        if (!total) {
          continue;
        }
        fractionClosed += Math.min(rem, value) / total;
      }
      if (fractionClosed <= 0) {
        continue;
      }
      const loc = nearest(input.locations(candidate.job.groupid), pos, wayTime);
      if (!loc) {
        continue;
      }
      const jobInfo = candidate.job.values[candidate.duration];
      if (!jobInfo) {
        continue;
      }
      // Energy is what limits a day of jobs; travel costs time only, weighted by the energy regenerated meanwhile.
      const cost = objective === 'energy' ? jobInfo.energy + loc.travel * walkWeight : jobInfo.duration + loc.travel;
      let score = fractionClosed / Math.max(cost, 1e-6);
      score += ((jobInfo.experience + jobInfo.money) / Math.max(cost, 1e-6)) * 1e-9; // tie-break: more XP/$
      if (!best || score > best.score) {
        best = { c: candidate, at: loc.at, travel: loc.travel, score };
      }
    }
    if (!best) {
      break;
    }
    const { c: candidateValue, at, travel } = best;
    const durationValues = candidateValue.job.values[candidateValue.duration];
    if (!durationValues) {
      break;
    }
    const last = stops[stops.length - 1];
    if (
      last &&
      last.job.id === candidateValue.job.id &&
      last.duration === candidateValue.duration &&
      last.at.x === at.x &&
      last.at.y === at.y
    ) {
      last.runs++;
    } else {
      stops.push({
        job: candidateValue.job,
        at,
        duration: candidateValue.duration,
        runs: 1,
        travel,
        gains: {},
        energy: 0,
        seconds: 0,
        xp: 0,
        money: 0,
      });
    }
    const source = stops[stops.length - 1];
    if (!source) {
      break;
    }
    source.energy += durationValues.energy;
    source.seconds += durationValues.duration;
    source.xp += durationValues.experience;
    source.money += durationValues.money;
    for (const [entryKey, currentValue] of Object.entries(candidateValue.gains)) {
      if ((remaining[entryKey] ?? 0) <= 1e-9) {
        continue;
      }
      const left = remaining[entryKey] ?? 0;
      const used = Math.min(left, currentValue);
      remaining[entryKey] = left - used;
      source.gains[entryKey] = (source.gains[entryKey] ?? 0) + currentValue;
    }
    pos = at;
    runs++;
  }
  const leftover = Object.fromEntries(Object.entries(remaining).filter(([, value]) => value > 1e-9));
  const totals = stops.reduce(
    (accumulator, current) => ({
      energy: accumulator.energy + current.energy,
      seconds: accumulator.seconds + current.seconds + current.travel,
      travel: accumulator.travel + current.travel,
      xp: accumulator.xp + current.xp,
      money: accumulator.money + current.money,
      runs: accumulator.runs + current.runs,
    }),
    { energy: 0, seconds: 0, travel: 0, xp: 0, money: 0, runs: 0 },
  );
  let fitRuns = totals.runs;
  let energyShort = 0;
  if (input.energyAvailable !== undefined) {
    fitRuns = 0;
    let left = input.energyAvailable;
    outer: for (const sourceValue of stops) {
      const per = sourceValue.energy / sourceValue.runs;
      for (let index = 0; index < sourceValue.runs; index++) {
        if (per > left) {
          break outer;
        }
        left -= per;
        fitRuns++;
      }
    }
    energyShort = Math.max(0, totals.energy - input.energyAvailable);
  }
  return { needs, stops, unmet, leftover, totals, fitRuns, energyShort };
}
