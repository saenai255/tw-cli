// Autopilot runner: the 1 s ticker calls step(). It replans when the inputs' fingerprint changes (checked every
// 2 s, so bursts of updates cause one replan) and, while running, carries the plan out: sends the planned tasks
// as queue space allows, deposits on arrival, cancels a sleep at its wake target, and cancels queued tasks when
// a fresh plan is clearly better. Failures back off 1 → 5 → 15 min; after 3 the step is left out of plans.
import type { FormValue } from '../http/form.ts';
import { errorMessage } from '../util/errors.ts';
import {
  type Consumable,
  chooseCancel,
  type HotelOption,
  type Plan,
  type PlanInput,
  parseConsumable,
  planAutopilot,
  type SpecialJobInput,
} from './autopilot.ts';
import type { AutopilotFile, PlannedTask } from './autopilot-config.ts';
import { duelOutlook, fingerprint } from './autopilot-config.ts';
import { QuestModule } from './autopilot-quests.ts';
import { DuelApi } from './duels.ts';
import { fetchHotel, roomRate } from './hotel.ts';
import { baseId } from './items.ts';
import { type DurationKey, isDoable, type JobDurationValues, wayTime } from './jobs.ts';
import { MARKET_TTL_MS, SHOP_TTL_MS, where } from './quest-buy.ts';
import type { GameState } from './state.ts';
import { deposit, fetchMobileTrader, fetchShop, MarketApi, SHOPS, type Shop, useItem } from './trade.ts';

const BACKOFF_S = [60, 300, 900] as const;
const backoffSeconds = (attempt: number): number => BACKOFF_S[Math.min(attempt, BACKOFF_S.length) - 1] ?? BACKOFF_S[0];
/** After this many failures a step is left out of plans until the inputs change. */
const MAX_FAILURES = 3;
/** A shorter sleep cannot tell the room's rate from regeneration noise. */
const MIN_MEASURED_HOURS = 0.25;
const HOTEL_TTL_MS = 10 * 60_000;
const CHECK_MS = 2_000;
const CANCEL_CHECK_MS = 30_000;
/** A special job detail older than this is re-read before the job is queued (used-up gold jobs, daily reset). */
const SPECIAL_FRESH_MS = 30 * 60_000;
/** work/index re-read: job values and motivation change as jobs are done and reset daily. */
const JOBS_REFRESH_MS = 30 * 60_000;
/** Quest shopping: at most this many towns' shops are read (nearest first), one request at a time this far apart. */
const SHOP_TOWNS = 10;
const BUY_SCAN_GAP_MS = 3_000;

export class AutopilotRunner {
  plan: Plan | null = null;
  /** Shown before the first replan: the saved plan of the last run. */
  stale = true;
  private state: GameState;
  private lastPrint = '';
  private lastCheck = 0;
  private hotels = new Map<number, { at: number; option: HotelOption | null }>();
  private failures = new Map<string, { count: number; until: number }>();
  private wakes = new Map<number, { energy: number; health: number }>();
  private lastCancel = 0;
  /** Last cancel check (it plans twice): at most every CANCEL_CHECK_MS, or right after a replan. */
  private lastCancelCheck = 0;
  private jobsAt = Date.now();
  /** Sleeps the autopilot queued: energy and time when queued, to measure the room's real rate on wake-up. */
  private sleeps = new Map<number, { energy: number; at: number; rate: number }>();
  private resumed = false;
  private duelsAt = 0;
  private acting = false;
  /** Why the next fingerprint-driven replan happens, when it is not just "inputs changed". */
  private replanReason: string | null = null;
  private scanning = false;
  private scanAt = 0;

  private quests: QuestModule;

  constructor(state: GameState) {
    this.state = state;
    this.quests = new QuestModule({
      state,
      get config() {
        return state.autopilot.config;
      },
      budget: () => this.budget(),
      spend: (countValue) => this.spend(countValue),
      skipped: () => this.skipped(),
      fail: (entryKey, message) => this.fail(entryKey, message),
    });
  }

  private get config() {
    return this.state.autopilot.config;
  }

  /** Replan at the next 2 s check, saying why it was not just "inputs changed". */
  private replanNext(reason: string): void {
    this.lastPrint = '';
    this.replanReason = reason;
  }

  /** Step keys left out of plans: MAX_FAILURES failures, or still backing off. */
  private skipped(): Set<string> {
    const now = Date.now();
    return new Set(
      [...this.failures]
        .filter(([, value]) => value.count >= MAX_FAILURES || value.until > now)
        .map(([entryKey]) => entryKey),
    );
  }

  private fail(key: string, msg: string): void {
    const failure = this.failures.get(key) ?? { count: 0, until: 0 };
    failure.count++;
    failure.until = Date.now() + backoffSeconds(failure.count) * 1000;
    this.failures.set(key, failure);
    this.state.debug.add('autopilot', `Failure ${failure.count}/${MAX_FAILURES}: ${key}`, {
      key,
      msg,
      count: failure.count,
      retryAt: new Date(failure.until).toISOString(),
    });
    this.state.error(
      `Autopilot: ${msg}${failure.count >= MAX_FAILURES ? ' (skipped from now on; plan redone without it)' : ` (retry in ${backoffSeconds(failure.count) / 60} min)`}`,
    );
    if (/session|logged out|log in|login/i.test(msg)) {
      this.pause('the session expired; reconnect with r or A');
    }
  }

  pause(why: string): void {
    if (!this.config.running) {
      return;
    }
    this.state.updateAutopilot((autopilotFile) => (autopilotFile.config.running = false));
    this.state.error(`Autopilot paused: ${why}.`);
  }

  private today(): string {
    return new Date(this.state.clock.nowMs()).toISOString().slice(0, 10);
  }

  private budget(): number {
    const spending = this.state.autopilot.spent;
    return Math.max(0, this.config.spend.daily - (spending.day === this.today() ? spending.amount : 0));
  }

  private spend(amount: number): void {
    if (amount <= 0) {
      return;
    }
    const day = this.today();
    this.state.updateAutopilot(
      (autopilotFile) =>
        (autopilotFile.spent = {
          day,
          amount: (autopilotFile.spent.day === day ? autopilotFile.spent.amount : 0) + amount,
        }),
    );
  }

  /** Home town's hotel and the one nearest to where the queue ends (travelTo), fetched at most every 10 min. */
  private hotelOptions(): HotelOption[] {
    const gameState = this.state;
    const named = gameState.world.towns.filter((townInfo) => townInfo.name);
    const near = named.length
      ? named.reduce((accumulator, current) =>
          gameState.travelTo(current) < gameState.travelTo(accumulator) ? current : accumulator,
        )
      : undefined;
    const ids = [
      ...new Set([gameState.character.homeTown?.id, near?.id].filter((xCoord): xCoord is number => !!xCoord)),
    ];
    const out: HotelOption[] = [];
    for (const id of ids) {
      const entry = this.hotels.get(id);
      if (!entry || Date.now() - entry.at > HOTEL_TTL_MS) {
        this.hotels.set(id, { at: Date.now(), option: entry?.option ?? null });
        void fetchHotel(gameState.client, id)
          .then((hotel) => {
            const town = gameState.world.towns.find((townInfo) => townInfo.id === id);
            if (!town) {
              return;
            }
            this.hotels.set(id, {
              at: Date.now(),
              option: {
                townId: id,
                name: hotel.townName,
                at: { x: town.x, y: town.y },
                rooms: hotel.rooms
                  .filter((room) => room.available)
                  .map((room) => ({
                    key: room.key,
                    name: room.name,
                    cost: room.free ? 0 : room.costs,
                    energyRate: roomRate(room.energy) * gameState.calibration.roomScale,
                    healthRate: roomRate(room.health),
                  })),
              },
            });
            this.replanNext('hotel data');
          })
          .catch(() => {});
      }
      const entryValue = this.hotels.get(id)?.option;
      if (entryValue) {
        out.push(entryValue);
      }
    }
    return out;
  }

  /** Bag items with an energy / health / motivation effect, minus the reserve. */
  private consumables(): Consumable[] {
    const gameState = this.state;
    if (!gameState.items) {
      return [];
    }
    const out: Consumable[] = [];
    for (const it of gameState.inventory.bag.values()) {
      const itemInfo = gameState.items.get(it.itemId);
      const effect = itemInfo ? parseConsumable(itemInfo.usebonus, itemInfo.usetype) : null;
      const count = it.count - this.config.consumables.reserve;
      if (itemInfo && effect && count > 0) {
        out.push({ itemId: it.itemId, name: itemInfo.name, count, value: itemInfo.price, effect });
      }
    }
    return out;
  }

  /** Everything the plan depends on, hashed. Server values only (not the regen estimate), so it is stable. */
  private inputs(hotels: HotelOption[]): unknown {
    const gameState = this.state;
    const character = gameState.character;
    return {
      // Rounded: queue times come back with sub-ms jitter from the clock offset on every poll.
      queue: gameState.queue.map((task) => [task.queueId, Math.round(task.end)]),
      c: [
        character.position,
        character.level,
        character.experience,
        character.cash,
        character.deposit,
        Object.values(character.serverValues).map(Math.round),
      ],
      quests: gameState.quests.map((quest) => [quest.id, quest.requirements.map((requirement) => requirement.solved)]),
      needs: gameState.autopilotNeeds().map((need) => [need.key, need.amount]),
      jobs: gameState.jobs.map((jobInfo) => [
        jobInfo.id,
        jobInfo.motivation,
        jobInfo.jobPoints,
        gameState.currentJobValues(jobInfo).long?.experience,
      ]),
      special: this.specialJobInputs().map((special) => [
        special.job.id,
        special.special,
        special.at.x,
        special.at.y,
        special.values.long?.experience,
        special.values.long?.money,
      ]),
      config: { ...this.config, running: undefined },
      rules: gameState.autopilot.rules,
      hotels: hotels.map((hotel) => [hotel.townId, hotel.rooms.length]),
      items: this.consumables().map((consumable) => [consumable.itemId, consumable.count]),
      skip: [...this.skipped()],
      budget: this.budget(),
      buy: [gameState.buyCatalog.version, gameState.autopilot.pickups.length],
    };
  }

  /** A plan from these inputs; `rates` keeps a cancel check's alternatives in the current plan's units. */
  private snapshot(
    fixedQueue = this.state.queue,
    energyBonus = 0,
    hotels = this.hotelOptions(),
    rates = this.plan?.rates,
  ): Plan {
    return planAutopilot({ ...this.planInput(fixedQueue, energyBonus, hotels), rates });
  }

  /** Jobs with rewards scaled to the live motivation and drop rates blended with job reports. */
  private calibratedJobs(): GameState['jobs'] {
    const cal = this.state.calibration;
    return this.state.jobs.map((job) => {
      const current = this.state.currentJobValues(job);
      const values =
        Object.keys(cal.data.drops).length === 0
          ? current
          : Object.fromEntries(
              Object.entries(current).map(([entryKey, durationValues]) => [
                entryKey,
                durationValues && {
                  ...durationValues,
                  items: durationValues.items?.map((drop) => ({
                    ...drop,
                    expected: cal.dropRate(job.id, entryKey, drop.itemId, drop.expected),
                  })),
                },
              ]),
            );
      return { ...job, values, valuesMotivation: job.motivation };
    });
  }

  /** Discovered silver/gold jobs with their real values, only when the user opted in. */
  private specialJobInputs(): SpecialJobInput[] {
    if (!this.config.jobs.special) {
      return [];
    }
    return this.state.specialJobOptions().flatMap((option) =>
      option.at && option.special && option.values
        ? [
            {
              job: option.job,
              at: option.at,
              special: option.special,
              values: option.values,
              valuesMotivation: option.valuesMotivation ?? option.job.motivation,
            },
          ]
        : [],
    );
  }

  private planInput(fixedQueue = this.state.queue, energyBonus = 0, hotels = this.hotelOptions()): PlanInput {
    const gameState = this.state;
    const character = gameState.character;
    return {
      start: {
        now: gameState.clock.now(),
        at: character.position,
        energy: Math.min(character.maxEnergy, character.energy + energyBonus),
        maxEnergy: character.maxEnergy,
        health: character.health,
        maxHealth: character.maxHealth,
        energyRegen: character.energyRegen,
        healthRegen: character.healthRegen,
        level: character.level,
        experience: character.experience,
        maxLevel: character.maxLevel,
        cash: character.cash,
        healthPerLevel: character.lpPerPoint,
      },
      fixed: fixedQueue.map((task) => gameState.queuedStep(task)),
      jobs: this.calibratedJobs(),
      specialJobs: this.specialJobInputs(),
      locations: (value) => gameState.locations.get(value),
      wayTime: (position, positionValue) => wayTime(position, positionValue, gameState.travelSpeed, character.speed),
      config: this.config,
      rules: gameState.autopilot.rules,
      needs: gameState.autopilotNeeds(),
      itemValue: (id) => gameState.items?.get(id)?.sell ?? 0,
      hotels,
      consumables: this.consumables(),
      homeTownId: character.homeTown?.id,
      towns: gameState.world.towns.flatMap((townInfo) =>
        townInfo.name ? [{ id: townInfo.id, name: townInfo.name, at: { x: townInfo.x, y: townInfo.y } }] : [],
      ),
      bankTownId: this.bankWalk()?.townId,
      buyTrips: gameState.buyTrips(),
      budget: this.budget(),
      skip: this.skipped(),
      hpScale: gameState.calibration.hpScale,
    };
  }

  /**
   * What the autopilot sees right now, for the debug log and screen: energy, HP, where you are and how far the
   * home / nearest town is, the bag, and every open quest with its requirements and the nearest place to get each.
   */
  context(): Record<string, unknown> {
    const gameState = this.state;
    const character = gameState.character;
    const way = (to: { x: number; y: number }) =>
      Math.round(wayTime(character.position, to, gameState.travelSpeed, character.speed));
    const named = gameState.world.towns.filter((townInfo) => townInfo.name);
    const nearest = named.length
      ? named.reduce((accumulator, current) => (way(current) < way(accumulator) ? current : accumulator))
      : undefined;
    const home = character.homeTown;
    const homeTown = home ? gameState.world.towns.find((townInfo) => townInfo.id === home.id) : undefined;
    const needs = gameState.autopilotNeeds();
    return {
      energy: `${character.energy}/${character.maxEnergy}`,
      health: `${character.health}/${character.maxHealth}`,
      homeTown: home
        ? { name: homeTown?.name ?? `town ${home.id}`, at: { x: home.x, y: home.y }, seconds: way(home) }
        : null,
      nearestTown: nearest ? { name: nearest.name, at: { x: nearest.x, y: nearest.y }, seconds: way(nearest) } : null,
      position: character.position,
      townHere: gameState.townHere?.name ?? null,
      queueEnd: gameState.queueEndPosition,
      quests: gameState.quests.map((quest) => ({
        id: quest.id,
        title: quest.title,
        chain: quest.group,
        finishable: quest.finishable,
        inScope: needs.some((need) => need.quests.includes(quest.soloTitle || quest.title)) || undefined,
        blocker: gameState.questBlocker(quest) ?? undefined,
        buy: (() => {
          const purchase = gameState.questPurchase(quest);
          return purchase.needs.length
            ? {
                needs: purchase.needs,
                picks: purchase.picks.map((pickInfo) => ({
                  item: pickInfo.name,
                  count: pickInfo.count,
                  cost: pickInfo.cost,
                  from: where(pickInfo.source),
                })),
                problem: purchase.problem ?? undefined,
              }
            : undefined;
        })(),
        giver: quest.employerName,
        giverSeconds: quest.employerAt ? way(quest.employerAt) : null,
        requirements: quest.requirements.map((requirement) => {
          const src = requirement.solved
            ? []
            : gameState
                .requirementSources(requirement)
                .sort((firstValue, second) => (firstValue.way ?? Infinity) - (second.way ?? Infinity));
          return {
            info: requirement.info,
            kind: requirement.kind,
            solved: requirement.solved,
            have: requirement.itemId !== undefined ? gameState.inventory.countBase(requirement.itemId) : undefined,
            need: requirement.count,
            nearest: src[0]
              ? {
                  job: src[0].job.name,
                  at: src[0].at,
                  seconds: src[0].way === null ? null : Math.round(src[0].way),
                  chance: src[0].chance,
                  fromQueueEnd: true,
                }
              : undefined,
            sources: src.length || undefined,
          };
        }),
      })),
      inventory: [...gameState.inventory.bag.values()].map((second) => ({
        id: second.itemId,
        name: gameState.itemName(second.itemId),
        count: second.count,
      })),
      consumables: this.consumables().map((consumable) => ({
        name: consumable.name,
        usable: consumable.count,
        effect: consumable.effect,
      })),
      worn: Object.fromEntries([...gameState.inventory.wear].map(([slot, id]) => [slot, gameState.itemName(id)])),
      queue: gameState.queue.map((task) => ({
        title: task.title,
        type: task.type,
        start: new Date(task.start * 1000).toISOString(),
        end: new Date(task.end * 1000).toISOString(),
      })),
      taskLimit: gameState.taskLimit,
      now: new Date(gameState.clock.now() * 1000).toISOString(),
      running: this.config.running,
      dryRun: this.config.modules.dryRun,
      busy: gameState.busy,
      server: character.serverValues,
      regen: { energyPerHour: character.energyRegen, healthPerHour: character.healthRegen },
      level: character.level,
      experience: character.experience,
      cash: character.cash,
      deposit: character.deposit,
      budgetLeft: this.budget(),
      needs,
      buyTrips: gameState.buyTrips(),
      pickups: gameState.autopilot.pickups,
      shopsRead: [...gameState.buyCatalog.shops].map(([id, candidateValue]) => ({
        town: gameState.world.towns.find((townInfo) => townInfo.id === id)?.name ?? id,
        at: new Date(candidateValue.at).toISOString(),
        shops: candidateValue.shops.map((shop) => `${shop.key} (${shop.items.length})`),
      })),
      calibration: gameState.calibration.summary(),
      rates: this.plan?.rates,
      failures: Object.fromEntries(
        [...this.failures].map(([entryKey, value]) => [
          entryKey,
          { count: value.count, until: new Date(value.until).toISOString() },
        ]),
      ),
    };
  }

  /** The planner's input without functions, compact enough for the log (jobs: values per duration). */
  private debugInput(input: PlanInput): Record<string, unknown> {
    const { jobs, locations, wayTime: _w, itemValue: _v, skip, specialJobs, ...rest } = input;
    const valuesOf = (values: Partial<Record<DurationKey, JobDurationValues>>) =>
      Object.fromEntries(
        Object.entries(values).map(([entryKey, durationValues]) => [
          entryKey,
          durationValues && {
            s: durationValues.duration,
            e: durationValues.energy,
            xp: durationValues.experience,
            $: durationValues.money,
            items: durationValues.items?.map((drop) => [drop.itemId, drop.percent]),
          },
        ]),
      );
    return {
      ...rest,
      skip: [...(skip ?? [])],
      jobs: jobs.map((jobInfo) => ({
        id: jobInfo.id,
        groupid: jobInfo.groupid,
        name: jobInfo.name,
        motivation: jobInfo.motivation,
        danger: jobInfo.danger,
        doable: isDoable(jobInfo),
        excluded: input.rules.excludedJobs.includes(jobInfo.id) || undefined,
        locations: locations(jobInfo.groupid)?.length ?? 0,
        values: valuesOf(jobInfo.values),
      })),
      specialJobs: specialJobs?.map((special) => ({
        jobId: special.job.id,
        name: special.job.name,
        special: special.special,
        at: special.at,
        values: valuesOf(special.values),
      })),
    };
  }

  /** The plan as logged: tasks with why / value / wake, and the timeline's per-step states. */
  private debugOutput(plan: Plan): Record<string, unknown> {
    return {
      why: plan.why,
      value: plan.value,
      tasks: plan.tasks.map((task) => ({
        key: task.key,
        module: task.module,
        step: task.step,
        why: task.why,
        value: task.value,
        wake: task.wake,
        action: task.action,
      })),
      timeline: plan.timeline.steps.map(({ step, ...st }) => ({ step: step.title, ...st })),
      final: plan.timeline.final,
      end: plan.timeline.end,
    };
  }

  /** Replans now (debounced by the caller); logs what changed. */
  replan(reason = 'inputs changed'): Plan {
    const old = this.state.clock.now() - 6 * 3600;
    if (this.state.autopilot.rules.inserts.some((xCoord) => xCoord.at < old)) {
      this.state.updateAutopilot(
        (autopilotFile) =>
          (autopilotFile.rules.inserts = autopilotFile.rules.inserts.filter((xCoord) => xCoord.at >= old)),
      );
    }
    const hotels = this.hotelOptions();
    const print = fingerprint(this.inputs(hotels));
    const prev = this.plan;
    const input = this.planInput(undefined, 0, hotels);
    const plan = planAutopilot(input);
    this.plan = plan;
    this.state.debug.add(
      'sim',
      `Replan (${reason}): ${plan.tasks.length} task(s), next ${plan.tasks[0]?.step.title ?? 'nothing'}`,
      {
        reason,
        context: this.context(),
        input: this.debugInput(input),
        output: this.debugOutput(plan),
      },
    );
    this.stale = false;
    this.lastPrint = print;
    this.state.updateAutopilot(
      (autopilotFile) => (autopilotFile.plan = { fingerprint: print, savedAt: Date.now(), tasks: plan.tasks }),
    );
    const next = plan.tasks[0]?.step.title ?? 'nothing';
    if (!prev || prev.tasks[0]?.key !== plan.tasks[0]?.key || prev.tasks.length !== plan.tasks.length) {
      this.state.info(`Autopilot replanned (${reason}): ${plan.tasks.length} task(s), next ${next}. ${plan.why}`);
    }
    return plan;
  }

  /** Called every second by the TUI ticker. */
  async step(): Promise<void> {
    const gameState = this.state;
    if (gameState.startup && !gameState.startup.done) {
      return;
    }
    if (this.acting || gameState.busy) {
      return;
    }
    const now = Date.now();
    if (now - this.lastCheck >= CHECK_MS) {
      this.lastCheck = now;
      const print = fingerprint(this.inputs(this.hotelOptions()));
      if (print !== this.lastPrint) {
        this.replan(this.replanReason ?? (this.plan ? 'inputs changed' : 'start'));
        this.replanReason = null;
      }
      this.scanBuySources();
      if (this.config.jobs.special) {
        void gameState.loadNextSpecialJob();
      }
      if (now - this.jobsAt >= JOBS_REFRESH_MS) {
        this.jobsAt = now;
        void gameState.loadJobs(true);
      }
      if (this.config.running && !this.resumed) {
        this.resumed = true;
        gameState.info('Autopilot resumed.');
      }
    }
    const dataValue = gameState.debug;
    if (!this.config.running || this.config.modules.dryRun || !this.plan) {
      dataValue.once(
        'gate',
        'autopilot',
        !this.plan
          ? 'Idle: no plan yet'
          : !this.config.running
            ? 'Idle: paused (plans only)'
            : 'Idle: dry run (plans only, sends nothing)',
      );
      return;
    }
    dataValue.once('gate', 'autopilot', 'Acting: running');
    this.acting = true;
    try {
      if (await this.wakeUp()) {
        return;
      }
      if (await this.maybeCancelForBetter()) {
        return;
      }
      if (this.config.modules.quests && (await this.quests.step())) {
        return;
      }
      if (this.config.modules.npcDuels && this.config.duels.forXp && (await this.duelForXp())) {
        return;
      }
      await this.carryOut();
    } finally {
      this.acting = false;
    }
  }

  /**
   * NPC duel for XP, between tasks: HP ≥ 70 %, NPC level ≤ duel level + margin, ready, and the duel record says
   * that level is won and pays more XP per energy than the best planned job. Never players.
   */
  private async duelForXp(): Promise<boolean> {
    const gameState = this.state;
    const character = gameState.character;
    if (
      gameState.queue.length ||
      character.health < 0.7 * character.maxHealth ||
      Date.now() - this.duelsAt < 5 * 60_000
    ) {
      return false;
    }
    this.duelsAt = Date.now();
    gameState.debug.add('autopilot', 'NPC duels: checking', {
      health: character.health,
      maxHealth: character.maxHealth,
      duelLevel: character.duelLevel,
      levelMargin: this.config.duels.levelMargin,
    });
    let data: Awaited<ReturnType<DuelApi['data']>>;
    try {
      data = await gameState.autopilotCall(() => new DuelApi(gameState.client).data(), 'duel data');
      gameState.duels = data;
    } catch {
      return false;
    }
    const job = this.plan?.tasks.find((task) => task.step.kind === 'job')?.step;
    const jobRate = job && job.kind === 'job' && job.energy > 0 ? job.xp / job.energy : 0;
    const now = gameState.clock.now();
    const best = data.npcs
      .filter(
        (npcN) =>
          npcN.readyIn <= 0 &&
          npcN.level <= character.duelLevel + this.config.duels.levelMargin &&
          !this.skipped().has(`duel:${npcN.id}`),
      )
      .map((npc) => ({ npc, outlook: duelOutlook(gameState.autopilot.duels, npc.level, now) }))
      .filter(
        (candidate): candidate is { npc: typeof candidate.npc; outlook: { xp: number; energy: number } } =>
          !!candidate.outlook &&
          candidate.outlook.energy <= character.energy &&
          candidate.outlook.xp / candidate.outlook.energy > jobRate,
      )
      .sort(
        (firstValue, second) =>
          second.outlook.xp / second.outlook.energy - firstValue.outlook.xp / firstValue.outlook.energy,
      )[0];
    gameState.debug.add('autopilot', best ? `NPC duels: fight ${best.npc.name}` : 'NPC duels: none worth it', {
      jobXpPerEnergy: jobRate,
      npcs: data.npcs.map((npcN) => ({
        id: npcN.id,
        name: npcN.name,
        level: npcN.level,
        readyIn: npcN.readyIn,
        outlook: duelOutlook(gameState.autopilot.duels, npcN.level, now),
      })),
    });
    if (!best) {
      return false;
    }
    gameState.info(
      `Autopilot: NPC duel ${best.npc.name} (level ${best.npc.level}): ~${Math.round(best.outlook.xp)} XP for ~${Math.round(best.outlook.energy)} energy beats the best job.`,
    );
    await gameState.fightNpc(best.npc.id);
    if (gameState.lastNpcDuel?.died) {
      this.pause('lost an NPC duel (passed out)');
    }
    this.replanNext('NPC duel');
    return true;
  }

  /** Cancels a running sleep once live energy and health confirm its wake target. */
  private async wakeUp(): Promise<boolean> {
    const gameState = this.state;
    const head = gameState.queue[0];
    if (head?.type !== 'sleep') {
      return false;
    }
    const wake = this.wakes.get(head.queueId);
    if (!wake) {
      return false;
    }
    const character = gameState.character;
    if (character.energy < wake.energy || character.health < wake.health) {
      gameState.debug.once(
        'wake',
        'autopilot',
        `Sleeping: waiting for wake target (energy ≥ ${Math.round(wake.energy)}, HP ≥ ${Math.round(wake.health)})`,
        { sleep: head.title, wake },
      );
      return false;
    }
    try {
      const before = character.energy;
      gameState.debug.add('autopilot', 'Wake-up: target reached, cancelling the sleep', {
        energy: character.energy,
        health: character.health,
        wake,
        sleep: head.title,
      });
      const res = await gameState.autopilotCall(
        () => gameState.tasks.cancel(gameState.queue, [0]),
        'cancel sleep (wake-up)',
      );
      gameState.queue = res.queue;
      if (res.energy !== undefined) {
        character.setEnergy(res.energy);
      }
      this.wakes.delete(head.queueId);
      this.measureRoom(head, res.energy);
      gameState.info(
        `Autopilot: woke up (energy ${before}/${wake.energy}, HP ${character.health}/${Math.round(wake.health)}).`,
      );
      void gameState.syncCharacter('after wake-up'); // checks the sleep kept its energy (unverified until seen live)
    } catch (err) {
      this.fail(`wake:${head.queueId}`, `wake-up failed: ${errorMessage(err)}`);
    }
    return true;
  }

  /**
   * The room's real energy rate from a sleep the autopilot queued and cancelled: energy at the start (the value
   * when queued plus base regen until the sleep began) against the server's energy after the cancel. Counted
   * only when uncapped (below max) and after 15+ minutes of sleep.
   */
  private measureRoom(task: GameState['queue'][number], after: number | undefined): void {
    const gameState = this.state;
    const character = gameState.character;
    const entry = this.sleeps.get(task.queueId);
    this.sleeps.delete(task.queueId);
    if (!entry || after === undefined || entry.rate <= 0) {
      return;
    }
    const now = gameState.clock.now();
    const begin = Math.max(entry.at, task.start);
    const hours = (now - begin) / 3600;
    const startEnergy = Math.min(
      character.maxEnergy,
      entry.energy + (character.maxEnergy * character.energyRegen * Math.max(0, begin - entry.at)) / 3600,
    );
    if (hours < MIN_MEASURED_HOURS || after >= character.maxEnergy - 1) {
      return void gameState.debug.add('autopilot', 'Room rate: not measured (short or capped sleep)', {
        hours,
        startEnergy,
        after,
      });
    }
    const rate = (after - startEnergy) / (character.maxEnergy * hours);
    gameState.calibration.addRoom(rate / entry.rate);
    gameState.debug.add(
      'autopilot',
      `Room rate measured: ${(rate * 100).toFixed(1)} % / h vs ${(entry.rate * 100).toFixed(1)} % read`,
      { hours, startEnergy, after, roomScale: gameState.calibration.roomScale },
    );
  }

  /**
   * Cancels the queue from some position on when replanning from there is better by the margin over the
   * horizon, or about as good (within `sameWithin`) with `walkSaved` less walking (a walk to town, a job outside
   * it, a walk back). Every cut point is tried; the running task is kept (its energy is not refunded). At most
   * one cancel per cooldown.
   */
  private async maybeCancelForBetter(): Promise<boolean> {
    const gameState = this.state;
    const config = this.config;
    if (gameState.queue.length === 0 || Date.now() - this.lastCancel < config.cancel.cooldown * 1000 || !this.plan) {
      return false;
    }
    // Construction is a manual town task the autopilot never plans; leave it alone.
    if (gameState.queue.some((task) => task.type === 'build')) {
      return false;
    }
    if (Date.now() - this.lastCancelCheck < CANCEL_CHECK_MS) {
      return false;
    }
    this.lastCancelCheck = Date.now();
    const refund = (from: number) =>
      gameState.queue
        .slice(from)
        .reduce((accumulator, current) => accumulator + (current.type === 'job' ? this.jobEnergy(current) : 0), 0);
    const option = (from: number) => {
      const pickInfo = this.snapshot(gameState.queue.slice(0, from), refund(from));
      return {
        from,
        value: pickInfo.value + pickInfo.queuedValue,
        walk: Math.round(pickInfo.walk),
        next: pickInfo.tasks.slice(0, 5).map((task) => task.step.title),
      };
    };
    const cur = option(gameState.queue.length);
    const running = (gameState.queue[0]?.start ?? Number.POSITIVE_INFINITY) <= gameState.clock.now();
    const cuts = Array.from({ length: gameState.queue.length - (running ? 1 : 0) }, (_, index) =>
      option(index + (running ? 1 : 0)),
    );
    const pick = chooseCancel(cur, cuts, config.cancel);
    const cmp = {
      current: cur,
      cuts,
      margin: config.cancel.margin,
      sameWithin: config.cancel.sameWithin,
      walkSaved: config.cancel.walkSaved,
      threshold: cur.value * (1 + config.cancel.margin),
      queue: gameState.queue.map((task) => task.title),
      pick: pick ?? null,
    };
    if (!pick) {
      gameState.debug.once(
        'cancel',
        'autopilot',
        `Cancel check: keep the queue (${gameState.queue.map((task) => task.title).join(', ')})`,
        cmp,
      );
      return false;
    }
    const positions = gameState.queue
      .map((_, index) => index)
      .slice(pick.from)
      .reverse();
    const titles = gameState.queue
      .slice(pick.from)
      .map((task) => task.title)
      .join(', ');
    const reason =
      pick.why === 'better'
        ? `a fresh plan is ${Math.round((pick.value / cur.value - 1) * 100)}% better over ${Math.round(config.cancel.horizon / 3600)} h`
        : `about the same value (${((pick.value / cur.value - 1) * 100).toFixed(1)}%), ${Math.round((cur.walk - pick.walk) / 60)} min less walking`;
    gameState.debug.add(
      'autopilot',
      `Cancel check: cancelling ${titles} (${pick.why === 'better' ? 'better plan' : 'less walking'})`,
      { ...cmp, positions },
    );
    try {
      const res = await gameState.autopilotCall(
        () => gameState.tasks.cancel(gameState.queue, positions),
        `cancel ${titles}`,
      );
      gameState.queue = res.queue;
      if (res.energy !== undefined) {
        gameState.character.setEnergy(res.energy);
      }
      this.lastCancel = Date.now();
      gameState.info(`Autopilot: cancelled ${titles}: ${reason}.`);
      this.replan(pick.why === 'better' ? 'cancelled for a better plan' : 'cancelled for less walking');
    } catch (err) {
      this.fail('cancel', `cancel failed: ${errorMessage(err)}`);
      this.lastCancel = Date.now();
    }
    return true;
  }

  /** Energy a queued job cost: the value for its duration (a short job refunds 1, not the long job's 12). */
  private jobEnergy(task: GameState['queue'][number]): number {
    const found = this.state.jobs.find((jobInfo) => jobInfo.id === task.jobId);
    if (!found) {
      return 0;
    }
    const secs = task.end - (task.way?.end ?? task.start);
    const vs = Object.values(found.values).filter((jobInfo) => !!jobInfo);
    const first = vs[0];
    if (!first) {
      return 0;
    }
    return (
      vs.reduce(
        (accumulator, current) =>
          Math.abs(current.duration - secs) < Math.abs(accumulator.duration - secs) ? current : accumulator,
        first,
      ).energy ?? 0
    );
  }

  /** Sends the next planned tasks the queue has room for; runs an on-the-spot action when its turn comes. */
  private async carryOut(): Promise<void> {
    const gameState = this.state;
    const tasks = this.plan?.tasks ?? [];
    const first = tasks[0];
    if (!first) {
      return void gameState.debug.once('carry', 'autopilot', 'Carry out: nothing planned', { why: this.plan?.why });
    }
    if (first.step.kind === 'job' && first.step.jobId !== undefined) {
      const known = gameState.specialAt(first.step.jobId, first.step.at);
      if (known && Date.now() - known.seenAt > SPECIAL_FRESH_MS) {
        gameState.debug.add('autopilot', `Carry out: refreshing ${known.kind} job ${first.step.title}`, {
          jobId: first.step.jobId,
          at: first.step.at,
          seenAt: new Date(known.seenAt).toISOString(),
        });
        await gameState.refreshSpecialJob(first.step.jobId, first.step.at);
        this.replan('special job refreshed');
        return;
      }
    }
    if (first.action) {
      if (gameState.queue.length) {
        return void gameState.debug.once(
          'carry',
          'autopilot',
          `Carry out: ${first.step.title} waits for the queue to finish`,
          {
            task: first,
            queue: gameState.queue.length,
          },
        );
      }
      gameState.debug.add('autopilot', `Carry out: ${first.step.title}`, { task: first, why: first.why });
      await this.act(first);
      return;
    }
    const free = gameState.taskLimit - gameState.queue.length;
    if (free <= 0) {
      return void gameState.debug.once(
        'carry',
        'autopilot',
        `Carry out: queue full (${gameState.queue.length}/${gameState.taskLimit})`,
      );
    }
    const batch: PlannedTask[] = [];
    let stop = 'end of plan';
    for (const task of tasks) {
      if (batch.length >= free) {
        stop = `queue room (${free})`;
        break;
      }
      if (task.action || !task.post) {
        stop = `${task.step.title} is an on-the-spot action`;
        break;
      }
      // Jobs pay energy when queued: only what the current energy covers.
      const left =
        gameState.character.energy -
        batch.reduce(
          (accumulator, current) => accumulator + (current.step.kind === 'job' ? current.step.energy : 0),
          0,
        );
      if (task.step.kind === 'job' && task.step.energy > left) {
        stop = `${task.step.title} needs ${task.step.energy} energy, ${left} left`;
        break;
      }
      batch.push(task);
      if (task.step.kind === 'sleep') {
        stop = 'a sleep ends the batch';
        break;
      } // later tasks depend on its wake-up
    }
    if (!batch.length) {
      return void gameState.debug.once(
        'carry',
        'autopilot',
        `Carry out: waiting (${stop.replace(/, \d+ left$/, '')})`,
        {
          stop,
          energy: gameState.character.energy,
          next: tasks[0],
        },
      );
    }
    gameState.debug.add('autopilot', `Carry out: queue ${batch.map((task) => task.step.title).join(', ')}`, {
      stop,
      energy: gameState.character.energy,
      free,
      batch: batch.map((task) => ({ key: task.key, why: task.why, step: task.step, post: task.post })),
    });
    try {
      const res = await gameState.autopilotCall(
        () =>
          gameState.tasks.add(
            gameState.queue.length,
            batch.map((task) => task.post as Record<string, FormValue>),
            gameState.taskLimit,
          ),
        'queue tasks',
      );
      gameState.applyQueuedEnergy(
        res,
        batch.map((queued) => (queued.step.kind === 'job' ? queued.step.energy : 0)),
      );
      gameState.queue.push(...res.added);
      res.added.forEach((task, index) => {
        const taskInfo = batch[index];
        if (!taskInfo) {
          return;
        }
        if (taskInfo.key.startsWith('insert:')) {
          this.dropInsert(taskInfo.key);
        }
        const depositAction = tasks[tasks.indexOf(taskInfo) + 1]?.action;
        if (taskInfo.step.kind === 'walk' && depositAction?.type === 'deposit') {
          gameState.updateAutopilot(
            (autopilotFile) => (autopilotFile.bankWalk = { queueId: task.queueId, townId: depositAction.townId }),
          );
        }
        if (taskInfo.step.kind === 'sleep') {
          if (taskInfo.wake) {
            this.wakes.set(task.queueId, taskInfo.wake);
          }
          gameState.sleepRates.set(task.queueId, {
            energyRate: taskInfo.step.energyRate,
            healthRate: taskInfo.step.healthRate,
          });
          this.sleeps.set(task.queueId, {
            energy: gameState.character.energy,
            at: gameState.clock.now(),
            rate: taskInfo.step.energyRate / gameState.calibration.roomScale,
          });
          this.spend(taskInfo.step.cost ?? 0);
        }
      });
      if (res.added.length) {
        gameState.info(`Autopilot: queued ${res.added.map((task) => task.title).join(', ')}. ${batch[0]?.why ?? ''}`);
      }
      const failed = batch.slice(res.added.length)[0];
      // "You need at least N more energy points": our energy estimate ran ahead of the server's. Correct it and
      // replan (towards a sleep or an item) instead of backing the job off as if it had failed.
      const short = Number(/at least (\d+) more energy/i.exec(res.errors.join(' '))?.[1]);
      if (failed?.step.kind === 'job' && short > 0) {
        gameState.character.setEnergy(Math.max(0, failed.step.energy - short));
        gameState.info(
          `Autopilot: ${failed.step.title} needs ${short} more energy than the server has; energy corrected to ${gameState.character.energy}.`,
        );
      } else if (failed) {
        this.fail(failed.key, `${failed.step.title} refused${res.errors.length ? `: ${res.errors.join('; ')}` : ''}`);
      }
      this.replan('queued');
    } catch (err) {
      const head = batch[0];
      if (head) {
        this.fail(head.key, `${head.step.title}: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * Fills the buy catalog for quest items no job drops (Quests module, buying on): the mobile trader, the shops
   * of the nearest towns within the buy trip, market offers. One read at a time, in the background like hotel
   * data (also while paused or in dry run: reads only); each answer is a planner input, so it replans.
   */
  private scanBuySources(): void {
    const gameState = this.state;
    const config = this.config;
    if (
      !config.modules.quests ||
      !config.quests.buy ||
      this.scanning ||
      Date.now() - this.scanAt < BUY_SCAN_GAP_MS ||
      !gameState.items
    ) {
      return;
    }
    // Items of quests that buying could unblock (a "Go to …" quest is not worth a read).
    const wanted = new Map<number, string>();
    for (const quest of gameState.autopilotQuests(true)) {
      const purchase = gameState.questPurchase(quest);
      if (!purchase.blocker) {
        for (const need of purchase.needs) {
          wanted.set(baseId(need.itemId), need.name);
        }
      }
    }
    if (!wanted.size) {
      return;
    }
    const cat = gameState.buyCatalog;
    let job: { what: string; run: () => Promise<void> } | null = null;
    if (cat.mobileStale()) {
      job = { what: 'mobile trader', run: async () => cat.setMobile(await fetchMobileTrader(gameState.client)) };
    }
    if (!job) {
      const from = gameState.queueEndPosition;
      const far = (target: { x: number; y: number }) =>
        wayTime(from, target, gameState.travelSpeed, gameState.character.speed);
      const town = gameState.world.towns
        .filter((townInfo) => townInfo.name && far(townInfo) <= config.quests.buyTrip)
        .sort((firstValue, second) => far(firstValue) - far(second))
        .slice(0, SHOP_TOWNS)
        .find((townInfo) => Date.now() - (cat.shops.get(townInfo.id)?.at ?? 0) > SHOP_TTL_MS);
      if (town) {
        job = {
          what: `shops in ${town.name}`,
          run: async () => {
            const shops: Shop[] = [];
            // Read from anywhere (the trade screen does it for the home town; other towns unverified).
            for (const def of SHOPS) {
              shops.push(
                ...(await fetchShop(gameState.client, def.key, town.id).then(
                  (shop) => [shop],
                  () => [],
                )),
              );
            }
            cat.setShops(town.id, shops);
          },
        };
      }
    }
    if (!job && config.quests.market) {
      const item = [...wanted].find(([id]) => Date.now() - (cat.market.get(id)?.at ?? 0) > MARKET_TTL_MS);
      if (item) {
        job = {
          what: `market: ${item[1]}`,
          run: () =>
            new MarketApi(gameState.client).search(item[1]).then(
              (result) => cat.setMarket(item[0] * 1000, result.offers),
              (err) => {
                cat.setMarket(item[0] * 1000, []);
                throw err;
              },
            ),
        };
      }
    }
    if (!job) {
      return;
    }
    const transform = job;
    this.scanning = true;
    const startedAt = Date.now();
    void transform
      .run()
      .then(
        () =>
          gameState.debug.add('quest', `Buy sources: read ${transform.what} (${Date.now() - startedAt} ms)`, {
            wanted: [...wanted.values()],
          }),
        (err) => {
          gameState.debug.add('quest', `Buy sources: reading ${transform.what} failed`, {
            error: errorMessage(err),
          });
          // Do not retry at once: mark it read (empty) until the TTL passes.
          if (transform.what === 'mobile trader') {
            cat.setMobile({ items: [], changesAt: null });
          }
        },
      )
      .finally(() => {
        this.scanning = false;
        this.scanAt = Date.now();
        this.replanReason = `buy sources (${transform.what})`;
      });
  }

  /** The queued bank walk still owed a deposit: while it is queued or you stand in its town; forgotten otherwise. */
  private bankWalk(): AutopilotFile['bankWalk'] {
    const gameState = this.state;
    const width = gameState.autopilot.bankWalk;
    if (!width) {
      return null;
    }
    if (gameState.queue.some((task) => task.queueId === width.queueId) || gameState.townHere?.id === width.townId) {
      return width;
    }
    gameState.debug.add('autopilot', 'Bank walk gone without a deposit: forgotten', {
      bankWalk: width,
      position: gameState.character.position,
    });
    gameState.updateAutopilot((autopilotFile) => (autopilotFile.bankWalk = null));
    return null;
  }

  /** An inserted step was carried out: its rule is done. */
  private dropInsert(key: string): void {
    const [, kind, at] = key.split(':');
    this.state.updateAutopilot(
      (autopilotFile) =>
        (autopilotFile.rules.inserts = autopilotFile.rules.inserts.filter(
          (xCoord) => !(xCoord.kind === kind && String(xCoord.at) === at),
        )),
    );
  }

  private async act(task: PlannedTask): Promise<void> {
    const gameState = this.state;
    if (task.action?.type === 'use') {
      const itemId = task.action.itemId;
      try {
        const result = await gameState.autopilotCall(
          () => useItem(gameState.client, itemId, 1, gameState.inventory.lastInvId, (id) => gameState.itemName(id)),
          `use ${gameState.itemName(itemId)}`,
        );
        gameState.inventory.applyChanges(result.changes);
        if (result.energy !== undefined) {
          gameState.character.setEnergy(result.energy);
        }
        if (result.health !== undefined) {
          gameState.character.setHealth(result.health);
        }
        gameState.info(
          `Autopilot: used ${gameState.itemName(itemId)}${result.effects.length ? `: ${result.effects.join(' ')}` : ''} (${task.why ?? ''}).`,
        );
        if (/motivation/i.test(task.step.title)) {
          void gameState.loadJobs(true); // motivation is in the job values
        }
        this.replan('item used');
      } catch (err) {
        this.fail(task.key, `${task.step.title}: ${errorMessage(err)}`);
      }
      return;
    }
    if (task.action?.type === 'buy') {
      if (gameState.townHere?.id !== task.action.townId) {
        return this.fail(task.key, `${task.step.title}: not in that town yet`);
      }
      // Usually done already: the quest step buys in the town you stand in before the plan gets here.
      if (!(await this.quests.buyHere())) {
        gameState.debug.add('autopilot', `${task.step.title}: nothing left to buy here`, { task: task });
      }
      this.replan('bought quest items');
      return;
    }
    if (task.action?.type !== 'deposit') {
      return;
    }
    const townId = task.action.townId;
    if (gameState.townHere?.id !== townId) {
      return this.fail(task.key, `${task.step.title}: not in that town yet`);
    }
    const cash = gameState.character.cash;
    if (gameState.autopilot.bankWalk) {
      gameState.updateAutopilot((autopilotFile) => (autopilotFile.bankWalk = null));
    }
    if (cash <= 0) {
      return void this.replan('nothing to deposit');
    }
    try {
      const resultValue = await gameState.autopilotCall(
        () => deposit(gameState.client, townId, cash),
        `deposit $${cash}`,
      );
      gameState.character.cash = resultValue.cash;
      gameState.character.deposit = resultValue.deposit;
      gameState.info(`Autopilot: deposited $ ${cash} (fee $ ${resultValue.fee}).`);
      this.replan('deposited');
    } catch (err) {
      this.fail(task.key, `deposit: ${errorMessage(err)}`);
    }
  }
}
