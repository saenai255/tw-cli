// Game state the TUI renders: character, task queue, jobs. Owns the GameClient and keeps state in
// sync the way the browser does (responses update energy/money; queue reloaded via task/get_tasks;
// full state from a fresh game.php load on reload()).
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenGame } from '../auth/login.ts';
import { CONFIG_DIR } from '../auth/session-store.ts';
import type { GameClient } from '../http/game-client.ts';
import { ChatPoller, type SelfUpdate } from '../realtime/chat.ts';
import { cachedJson } from '../util/disk-cache.ts';
import { errorMessage } from '../util/errors.ts';
import { entries, isObj, type JsonObject, obj } from '../util/json.ts';
import { type BuyTrip, expectedHpLoss } from './autopilot.ts';
import { type AutopilotFile, loadAutopilot, questInScope, saveAutopilot } from './autopilot-config.ts';
import { AutopilotRunner } from './autopilot-runner.ts';
import { Calibration } from './calibration.ts';
import { CharacterState, type Position } from './character.ts';
import { ServerClock } from './clock.ts';
import { DebugLog, diffSnapshots } from './debug-log.ts';
import { DuelApi, type DuelData, type DuelOpponent, duelPost, type NpcDuelResult } from './duels.ts';
import { type ActiveEvent, type EventItem, eventReadyItems, parseActiveEvent, withEventPoints } from './event.ts';
import { fetchHotel, type Hotel, type HotelRoom, roomRate } from './hotel.ts';
import { type EquipSets, Inventory, InventoryApi } from './inventory.ts';
import { baseId, type ItemCatalog, type ItemSetCatalog, loadItemCatalog, loadItemSets, statsOf } from './items.ts';
import { type ItemStats, type StatContext, setBonusLines } from './itemstats.ts';
import {
  DURATION_KEYS,
  type DurationKey,
  fetchJobDetail,
  fetchJobInfos,
  isDoable,
  JobCatalog,
  type JobDetail,
  type JobDurationValues,
  type JobInfo,
  type JobLocations,
  MOTIVATION_LOSS,
  nearestLocation,
  parseJobDetail,
  type SpecialKind,
  scaleJobValues,
  wayTime,
} from './jobs.ts';
import { collectLoginBonus, loginRewardText } from './loginbonus.ts';
import {
  MailApi,
  type Report,
  type ReportFolder,
  type ReportList,
  type ReportRow,
  reportLogLine,
  type Telegram,
  type TelegramList,
} from './mail.ts';
import { BuyCatalog, type BuyNeed, type BuyPick, chooseBuys, where } from './quest-buy.ts';
import {
  parseGameNumber,
  type Quest,
  QuestApi,
  type QuestEmployer,
  type QuestRequirement,
  questEnds,
} from './quests.ts';
import { RateTracker } from './rates.ts';
import { planRoute, questNeeds, type RouteNeed, type RouteObjective, type RoutePlan } from './route.ts';
import { SkillApi, type SkillPlan, Skills } from './skills.ts';
import { loadSpecialJobs, type SpecialJobDetail, saveSpecialJobs } from './special-jobs.ts';
import { jobPost, parseQueue, type QueuedTask, sleepPost, TaskApi, walkPost } from './tasks.ts';
import { TileCache } from './tiles.ts';
import { projectTimeline, type Timeline, type TimelineStep } from './timeline.ts';
import {
  buildPost,
  type Construction,
  fetchConstruction,
  fetchTownHall,
  type TownBuilding,
  type TownHall,
} from './townhall.ts';
import {
  type Bank,
  buyMobileTrader,
  buyOrderProblem,
  DEFAULT_FILTER,
  deposit,
  fetchBank,
  fetchMobileTrader,
  fetchShop,
  MarketApi,
  type MarketFilter,
  type MarketOffer,
  type MobileTrader,
  type MobileTraderItem,
  type Shop,
  type ShopKey,
  shopBuy,
  shopSell,
  useItem,
} from './trade.ts';
import { type Fort, type Town, WorldMap } from './world.ts';

export interface LogEntry {
  at: Date;
  level: 'info' | 'error';
  msg: string;
}

export interface JobOption {
  job: JobInfo;
  at: Position | null;
  /** Travel time in seconds from where the queue ends. */
  way: number | null;
  /** Silver/gold job at this exact location (values then come from its job/job reply). */
  special?: SpecialKind | null;
  /** Location-specific values from job/job, read at `valuesMotivation`. */
  values?: Partial<Record<DurationKey, JobDurationValues>> | undefined;
  valuesMotivation?: number | undefined;
  /** A discovered special whose real values have not been loaded yet (select it to load them). */
  pendingSpecial?: boolean;
}

/** What a quest still needs bought, where from, and why not when it cannot be done. */
export interface QuestPurchase {
  needs: BuyNeed[];
  picks: BuyPick[];
  /** A requirement buying cannot help with. */
  blocker: string | null;
  /** An item that cannot be bought within the limits. */
  problem: string | null;
}

/** Log lines kept for the screen; a carried-over log is trimmed harder so a wake does not flood it. */
const MAX_LOG_LINES = 200;
const CARRIED_LOG_LINES = 100;
/** A health drop this large right after a dangerous job is an attack, not the job's cost. */
const ATTACK_DROP_FRACTION = 0.3;
/** A drop below this many HP and this fraction of max is regeneration jitter, not an attack. */
const ATTACK_MIN_DROP = 2;
const ATTACK_MIN_DROP_FRACTION = 0.01;
/** A special reported as gone is not asked about again for this long. */
const SPECIAL_MISS_TTL_MS = 3_600_000;
/** A special's real values are re-read after this long (values and the job can change). */
const SPECIAL_FRESH_MS = 2 * 3_600_000;
/** The autopilot does not prefetch specials further than this walk from the queue end. */
const SPECIAL_PREFETCH_TRAVEL = 2 * 3_600;

const LAYERS_FILE = () => join(CONFIG_DIR, 'map-layers.json');
function loadMapLayers(): Record<string, boolean> {
  try {
    return Object.fromEntries(
      entries(JSON.parse(readFileSync(LAYERS_FILE(), 'utf8'))).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}
function saveMapLayers(layers: Record<string, boolean>): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(LAYERS_FILE(), JSON.stringify(layers), { mode: 0o600 });
  } catch {
    /* preference only */
  }
}

/** One planned route job: the task/add post, its energy cost and name. */
type RouteRun = { post: ReturnType<typeof jobPost>; energy: number; title: string };

export type JobSort = 'name' | 'xp' | 'money' | 'luck' | 'distance';
export const JOB_SORTS: JobSort[] = ['name', 'xp', 'money', 'luck', 'distance'];

/** Value a job is sorted by: the 1 h (else longest known) duration's XP / money; luck = max $ find (maxLuck). */
export function jobSortValue(
  job: JobInfo,
  sort: JobSort,
  values: Partial<Record<DurationKey, JobDurationValues>> = job.values,
): number {
  if (sort === 'luck') {
    return job.luckValue[1];
  }
  const jobInfo = values.long ?? values.middle ?? values.short;
  if (!jobInfo) {
    return -Infinity;
  }
  return sort === 'xp' ? jobInfo.experience : sort === 'money' ? jobInfo.money : 0;
}

export interface StartupStep {
  label: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
}

export class GameState extends EventEmitter {
  client!: GameClient;
  clock!: ServerClock;
  character!: CharacterState;
  catalog!: JobCatalog;
  tasks!: TaskApi;
  travelSpeed = 1;
  automationUntil = 0;
  worldName = '';
  queue: QueuedTask[] = [];
  jobs: JobInfo[] = [];
  private jobDetailLoading = new Set<string>();
  world = new WorldMap();
  tiles = new TileCache();
  log: LogEntry[] = [];
  /** Everything that happens, with data (Debug screen, B); the TUI also writes it to debug.jsonl. */
  debug = new DebugLog();
  private debugSnap: Record<string, unknown> | null = null;
  private debugStarted = new Set<number>();
  /** What the autopilot learns from reports, health and hotel sleeps (memory only unless the TUI sets a file). */
  calibration = new Calibration(null);
  /** Rates of sleeps on the queue (the queue entry has none): queueId → fraction of max per hour. */
  sleepRates = new Map<number, { energyRate: number; healthRate: number }>();
  /** Dangerous jobs finished whose HP loss has not been seen yet (next server health value). */
  private hpPending: { title: string; predicted: number } | null = null;
  /** Real job/job values of discovered silver/gold jobs, keyed by `${jobId}:${x},${y}`. */
  specialDetails = new Map<string, SpecialJobDetail>();
  /** Bumped when specialDetails changes, so the jobs list recomputes. */
  specialVersion = 0;
  /** Bumped when job values or motivation change, so the jobs list recomputes. */
  jobsVersion = 0;
  /** Discovered specials whose detail said they are no longer silver/gold, and when. */
  private specialMisses = new Map<string, number>();
  /** Special detail requests that failed: retry after this time. */
  private specialRetry = new Map<string, number>();
  /** Job reports already counted (ids). */
  private reportsSeen = new Set<number>();
  busy = false;
  items: ItemCatalog | null = null;
  itemSets: ItemSetCatalog | null = null;
  inventory = new Inventory();
  /** Saved equipment sets (loaded by the character screen's Sets tab). */
  equipSets: EquipSets | null = null;
  /** Player.hasLoginBonus from game.php; true while today's streak reward is uncollected. */
  hasLoginBonus = false;
  /** Active seasonal event and its personal progress (Game.init sesData/ceData). */
  event: ActiveEvent | null = null;
  skills = new Skills();
  quests: Quest[] = [];
  questCapacity = 0;
  saloon: { key: string; name: string }[] = [];
  employer: QuestEmployer | null = null;
  hotel: Hotel | null = null;
  /** Live updates (chat long-poll). */
  live: ChatPoller | null = null;
  liveStatus: 'off' | 'connecting' | 'on' | 'error' = 'off';
  unread = { reports: false, messages: false };
  /** Jobs marked on the map for a quest (`g` in the quest screen). */
  mapHighlight: { label: string; jobIds: Set<number> } | null = null;
  /** Map layers switched off by the user (v on the map); saved in the config dir. */
  mapLayers: Record<string, boolean> = loadMapLayers();
  /** Mail screen: last loaded report / telegram lists. */
  reports: ReportList | null = null;
  /** Newest reports (page 1, all folders) for the home screen; refreshed when the game says there is a new one. */
  recentReports: ReportRow[] | null = null;
  /** Measured XP/h and $/h, jobs done this session. */
  rates = new RateTracker();
  reportFolder: ReportFolder = 'all';
  telegrams: TelegramList | null = null;
  /** Trade screen: bank, shop and market of the town you are in (or your home town). */
  bank: Bank | null = null;
  shop: Shop | null = null;
  /** Rotating offers of the mobile trader (the trade screen's "Mobile trader" tab). */
  mobileTrader: MobileTrader | null = null;
  /** Where the autopilot can buy quest items (shops in reach, mobile trader, market), filled by the runner. */
  buyCatalog = new BuyCatalog();
  /** Town hall of the home town and the construction detail of its selected building. */
  townHall: TownHall | null = null;
  construction: Construction | null = null;
  market: {
    query: string;
    page: number;
    next: boolean;
    offers: MarketOffer[];
    filter: MarketFilter;
    searched: boolean;
  } = { query: '', page: 1, next: false, offers: [], filter: { ...DEFAULT_FILTER }, searched: false };
  /** My market: bids, sell offers and (for the trade town's market) buy orders. */
  marketMine: { bids: MarketOffer[]; offers: MarketOffer[]; buyOrders: MarketOffer[] } | null = null;
  /** Duels screen. */
  duels: DuelData | null = null;
  duelOpponents: DuelOpponent[] = [];
  lastNpcDuel: NpcDuelResult | null = null;
  private itemsFile: string | undefined;
  private itemSetsFile: string | undefined;
  private bagInit: JsonObject | null = null;
  private reopen: () => Promise<OpenGame>;

  constructor(game: OpenGame, reopen: () => Promise<OpenGame>) {
    super();
    this.reopen = reopen;
    this.apply(game);
  }

  private apply({ client, bootstrap }: OpenGame): void {
    this.client = client;
    const game = bootstrap.game ?? {};
    const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
    this.clock = new ServerClock(game.sincepoch === undefined ? undefined : Number(game.sincepoch));
    this.character = CharacterState.fromInit(bootstrap.character ?? {}, this.clock);
    if (Number(game.maxLevel) > 0) {
      this.character.maxLevel = Number(game.maxLevel);
    }
    this.catalog = new JobCatalog(bootstrap.game);
    this.tasks = new TaskApi(client);
    this.travelSpeed = Number(game.travelSpeed ?? 1);
    this.worldName = String(game.currentWorldName ?? '');
    this.automationUntil = Number(obj(obj(obj(bootstrap.premium).premiumBoni).automation).expiration ?? 0);
    this.queue = parseQueue(bootstrap.character?.taskQueue);
    this.itemsFile = str(game.itemsFile);
    this.itemSetsFile = str(game.itemSetsFile);
    const inventory = bootstrap.character?.inventory;
    this.bagInit = bootstrap.bag ?? (isObj(inventory) ? inventory : null);
    this.inventory = Inventory.fromInit(this.bagInit, this.items ?? undefined);
    this.equipSets = null;
    this.hasLoginBonus = !!bootstrap.player?.hasLoginBonus;
    this.event = parseActiveEvent(bootstrap.game);
    this.mobileTrader = null;
    this.townHall = null;
    this.construction = null;
    this.skills = Skills.fromInit(isObj(bootstrap.character?.skillData) ? bootstrap.character.skillData : undefined);
    const wasLive = !!this.live?.active;
    this.live?.stop();
    this.live = null;
    if (wasLive) {
      this.startLive();
    }
  }

  private get questApi(): QuestApi {
    return new QuestApi(this.client, (id) => this.itemName(id));
  }

  itemName(id: number): string {
    return this.items ? this.items.name(id) : `item ${id}`;
  }

  /** Title of a quest in the log or at the open employer, if we have it. */
  questTitle(id: number): string | undefined {
    return (
      this.quests.find((currentQuest) => currentQuest.id === id) ??
      this.employer?.open.find((currentQuest) => currentQuest.id === id)
    )?.title;
  }

  info(msg: string): void {
    this.push('info', msg);
  }

  error(msg: string): void {
    this.push('error', msg);
  }

  private push(level: LogEntry['level'], msg: string): void {
    this.log.push({ at: new Date(), level, msg });
    if (this.log.length > MAX_LOG_LINES) {
      this.log.shift();
    }
    this.debug.add('log', msg, { level });
    this.changed();
  }

  changed(): void {
    this.emit('change');
  }

  /** Job group id → map locations (from the minimap). */
  get locations(): JobLocations {
    return this.world.jobGroups;
  }

  /** A job's work/index values rescaled to its live motivation. */
  currentJobValues(job: JobInfo): Partial<Record<DurationKey, JobDurationValues>> {
    return this.scaleValues(job.values, job.valuesMotivation ?? job.motivation, job.motivation);
  }

  /** The values a job option actually pays at this location (special rows use their job/job reply). */
  jobValues(option: JobOption): Partial<Record<DurationKey, JobDurationValues>> {
    if (option.values) {
      return this.scaleValues(
        option.values,
        option.valuesMotivation ?? option.job.valuesMotivation ?? option.job.motivation,
        option.job.motivation,
      );
    }
    return this.currentJobValues(option.job);
  }

  private scaleValues(
    values: Partial<Record<DurationKey, JobDurationValues>>,
    fromMotivation: number,
    toMotivation: number,
  ): Partial<Record<DurationKey, JobDurationValues>> {
    const out: Partial<Record<DurationKey, JobDurationValues>> = {};
    for (const entryKey of DURATION_KEYS) {
      const durationValues = values[entryKey];
      if (durationValues) {
        out[entryKey] = scaleJobValues(durationValues, fromMotivation, toMotivation);
      }
    }
    return out;
  }

  specialKey(jobId: number, at: Position): string {
    return `${jobId}:${at.x},${at.y}`;
  }

  /** The silver/gold job at this exact spot, if its real values are known. */
  specialAt(jobId: number, at: Position): SpecialJobDetail | undefined {
    return this.specialDetails.get(this.specialKey(jobId, at));
  }

  /** Doable jobs of one map location's job group, with travel from where the queue ends. */
  jobsAtLocation(groupId: number, at: { x: number; y: number }): JobOption[] {
    const from = this.queueEndPosition;
    const way = wayTime(from, at, this.travelSpeed, this.character.speed);
    return this.jobs.filter((jobInfo) => jobInfo.groupid === groupId).map((job) => ({ job, at, way }));
  }

  travelTo(at: { x: number; y: number }): number {
    return wayTime(this.queueEndPosition, at, this.travelSpeed, this.character.speed);
  }

  get hasAutomation(): boolean {
    return this.automationUntil > this.clock.now();
  }

  get taskLimit(): number {
    return this.hasAutomation ? this.character.taskLimit.premium : this.character.taskLimit.normal;
  }

  /** Where the character will be once the current queue is done (jobs are queued sequentially). */
  get queueEndPosition(): Position {
    const last = this.queue[this.queue.length - 1];
    return last ? last.coords : this.character.position;
  }

  /** Drops finished tasks locally (TaskQueueUi.tick) and moves the character to their coords. */
  tick(): boolean {
    const now = this.clock.now();
    let changed = false;
    while ((this.queue[0]?.end ?? Number.POSITIVE_INFINITY) <= now) {
      const done = this.queue.shift();
      if (!done) {
        break;
      }
      this.character.position = done.coords;
      this.info(`Finished: ${done.title}`);
      if (done.type === 'job') {
        this.rates.jobsDone++;
        this.jobFinished(done);
      }
      this.rates.lastTask = { title: done.title, type: done.type, end: done.end };
      changed = true;
    }
    const character = this.character;
    this.rates.record(now, character.experience, character.cash + character.deposit);
    this.watchDebug();
    return changed;
  }

  /** A queued job ended: lower its motivation and expect its HP loss in the next health value. */
  private jobFinished(taskInfo: QueuedTask): void {
    const searchQuery = this.queuedJob(taskInfo);
    if (!searchQuery) {
      return;
    }
    // The game deducts motivation when the report is generated; work/index corrects any drift later.
    searchQuery.job.motivation = Math.max(0, searchQuery.job.motivation - MOTIVATION_LOSS[searchQuery.duration]);
    this.jobsVersion++;
    if (searchQuery.job.danger) {
      const predicted = expectedHpLoss(searchQuery.job.danger, searchQuery.values.duration, this.character.maxHealth);
      this.hpPending = { title: taskInfo.title, predicted: (this.hpPending?.predicted ?? 0) + predicted };
    }
  }

  /**
   * A fresh server health value after a dangerous job: the drop below the regen estimate is the job's HP loss.
   * More than 30 % of max HP at once is taken for an attack and not counted.
   */
  private observeHealth(before: number, after: number): void {
    const pick = this.hpPending;
    if (!pick) {
      return;
    }
    this.hpPending = null;
    const lost = Math.max(0, before - after);
    if (lost > ATTACK_DROP_FRACTION * this.character.maxHealth) {
      return void this.debug.add('state', `HP drop ${lost} after ${pick.title} looks like an attack: not calibrated`, {
        before,
        after,
        predicted: pick.predicted,
      });
    }
    this.calibration.addHp(pick.predicted, lost);
    this.debug.add('state', `Calibration: ${pick.title} cost ${lost} HP (predicted ${Math.round(pick.predicted)})`, {
      lost,
      predicted: pick.predicted,
      hpScale: this.calibration.hpScale,
    });
  }

  /** A level-up seen: did it refill energy (the planner assumes so)? */
  private observeLevelUp(): void {
    const character = this.character;
    const refilled = character.energy >= character.maxEnergy - 1;
    this.calibration.addLevelUp(refilled);
    this.debug.add(
      'state',
      `Calibration: level-up ${refilled ? 'refilled' : 'did NOT refill'} energy (${character.energy}/${character.maxEnergy})`,
      this.calibration.data.levelUps,
    );
  }

  /** New job reports (from a report list): drops per job and duration. One show_report request each. */
  async calibrateFromReports(rows: ReportRow[]): Promise<void> {
    for (const report of rows) {
      if (this.reportsSeen.has(report.id) || !/^job report/i.test(report.title)) {
        continue;
      }
      this.reportsSeen.add(report.id);
      try {
        const rep = await this.mail.jobReport(report.id, report.hash);
        const job = rep && this.jobs.find((jobInfo) => jobInfo.id === rep.jobId);
        if (!rep || !job || rep.seconds === null) {
          continue;
        }
        let dur: DurationKey | undefined;
        for (const entryKey of DURATION_KEYS) {
          if (job.values[entryKey]?.duration === rep.seconds) {
            dur = entryKey;
          }
        }
        if (!dur) {
          continue;
        }
        this.calibration.addJobRun(job.id, dur, rep.items);
        this.debug.add(
          'state',
          `Calibration: ${job.name} (${dur}) report: ${rep.items.map(([id, countValue]) => `${this.itemName(id)} ×${countValue}`).join(', ') || 'no items'}`,
          { report: report.id, ...rep },
        );
      } catch (err) {
        this.debug.add('request', `Job report ${report.id} for calibration failed`, {
          error: errorMessage(err),
        });
      }
    }
  }

  /** Server-side values the client tracks, for the debug diff (no regen estimates: they change every tick). */
  private debugSnapshot(): Record<string, unknown> {
    const character = this.character;
    const sv = character.serverValues;
    return {
      position: `${character.position.x},${character.position.y}`,
      town: this.townHere?.name ?? null,
      level: character.level,
      experience: character.experience,
      cash: character.cash,
      deposit: character.deposit,
      nuggets: character.nuggets,
      energy: sv.energy,
      health: sv.health,
      maxEnergy: character.maxEnergy,
      maxHealth: character.maxHealth,
      queue: this.queue.map((taskInfo) => `#${taskInfo.queueId} ${taskInfo.type} ${taskInfo.title}`),
      quests: this.quests.map(
        (currentQuest) =>
          `${currentQuest.title}${currentQuest.finishable ? ' (finishable)' : ''}: ${currentQuest.requirements.map((requirement) => `${requirement.solved ? '✓' : '·'} ${requirement.info}`).join(' | ')}`,
      ),
      bag: [...this.inventory.bag.values()].map((second) => `${this.itemName(second.itemId)} ×${second.count}`),
      wear: [...this.inventory.wear].map(([slot, id]) => `${slot}: ${this.itemName(id)}`),
      jobs: this.jobs.length,
      live: this.liveStatus,
      autopilot: this.autopilot.config.running
        ? this.autopilot.config.modules.dryRun
          ? 'running (dry run)'
          : 'running'
        : 'paused',
    };
  }

  /** Logs what changed since the last tick, and queue tasks as they are added, start and leave. */
  private watchDebug(): void {
    const snap = this.debugSnapshot();
    if (this.debugSnap) {
      const dataValue = diffSnapshots(this.debugSnap, snap);
      const keys = Object.keys(dataValue);
      if (keys.length) {
        this.debug.add('state', `Changed: ${keys.join(', ')}`, dataValue);
      }
    }
    this.debugSnap = snap;
    const now = this.clock.now();
    const head = this.queue[0];
    if (head && head.start <= now && !this.debugStarted.has(head.queueId)) {
      this.debugStarted.add(head.queueId);
      const searchQuery = this.queuedJob(head);
      this.debug.add('state', `Started: ${head.title}`, {
        task: {
          queueId: head.queueId,
          type: head.type,
          start: head.start,
          end: head.end,
          coords: head.coords,
          way: head.way,
        },
        job: searchQuery
          ? {
              id: searchQuery.job.id,
              duration: searchQuery.duration,
              values: searchQuery.values,
              motivation: searchQuery.job.motivation,
              danger: searchQuery.job.danger,
            }
          : undefined,
        energy: this.character.energy,
        health: this.character.health,
      });
    }
  }

  private async guard<Value>(label: string, fn: () => Promise<Value>): Promise<Value | undefined> {
    if (this.busy) {
      this.error('Busy, wait for the previous action to finish');
      return undefined;
    }
    this.busy = true;
    this.changed();
    const startedAt = Date.now();
    try {
      const resultValue = await fn();
      this.debug.add('request', `${label}: ok (${Date.now() - startedAt} ms)`);
      return resultValue;
    } catch (err) {
      this.debug.add('request', `${label}: failed (${Date.now() - startedAt} ms)`, {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      this.error(`${label}: ${errorMessage(err)}`);
      return undefined;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  setMapLayer(key: string, shown: boolean): void {
    this.mapLayers = { ...this.mapLayers, [key]: shown };
    saveMapLayers(this.mapLayers);
    this.changed();
  }

  /** First-start progress for the loading screen; null when start() was never called. */
  startup: { steps: StartupStep[]; done: boolean } | null = null;

  /** Runs one startup step; it failed when it logged an error (guard() reports errors to the log). */
  private async step(label: string, fn: () => Promise<unknown>): Promise<void> {
    const currentTime: StartupStep = { label, status: 'running', startedAt: Date.now() };
    this.startup?.steps.push(currentTime);
    this.changed();
    const errors = this.log.filter((line) => line.level === 'error').length;
    await fn();
    currentTime.status = this.log.filter((line) => line.level === 'error').length > errors ? 'error' : 'done';
    currentTime.endedAt = Date.now();
    this.changed();
  }

  /** `connect`: how long connecting took (shown as the loading screen's first, finished step). */
  async start(
    opts: { live?: boolean; connect?: { label: string; startedAt: number; endedAt: number } } = {},
  ): Promise<void> {
    this.startup = { steps: opts.connect ? [{ ...opts.connect, status: 'done' }] : [], done: false };
    await this.step('Server clock', () => this.guard('Clock sync', () => this.clock.sync(this.client)));
    await this.step('Jobs and map', () => this.loadJobs(true));
    this.loadSpecialCache();
    await this.step('Item data', () => this.loadItems());
    await this.step('Quest log', () => this.loadQuests(true));
    if (opts.live !== false) {
      await this.step('Live updates', async () => this.startLive());
    }
    this.startup.done = true;
    this.info(`Ready: ${this.jobs.length} jobs, ${this.items?.size ?? 0} items, ${this.quests.length} quests.`);
    void this.autoCollectLoginBonus();
  }

  /** Leaves the loading screen early (requests keep running in the background). */
  skipStartup(): void {
    if (this.startup) {
      this.startup.done = true;
    }
    this.changed();
  }

  // ---- live updates -------------------------------------------------------------------------

  /** After a rebuild (wake from sleep): keep the log and a running auto-route. */
  carryOver(prev: GameState): void {
    this.log.unshift(...prev.log.slice(-CARRIED_LOG_LINES));
    for (const entry of this.debug.entries) {
      prev.debug.add(entry.cat, entry.title, entry.data);
    }
    this.debug = prev.debug;
    this.sleepRates = prev.sleepRates;
    this.specialDetails = prev.specialDetails;
    this.specialVersion = prev.specialVersion;
    this.reportsSeen = prev.reportsSeen;
    this.hpPending = prev.hpPending;
    if (prev.autoRoute) {
      this.autoRoute = { ...prev.autoRoute, retryAt: 0 };
    }
    this.autopilot = prev.autopilot;
    this.mapLayers = prev.mapLayers;
    this.rates = prev.rates;
    this.recentReports = prev.recentReports;
    this.seenReports = prev.seenReports;
  }

  /** Starts the chat long-poll the browser keeps open; pushes XP/money/energy/position. */
  startLive(): void {
    if (this.live?.active) {
      return;
    }
    const poller = new ChatPoller(this.client);
    this.live = poller;
    this.liveStatus = 'connecting';
    poller.on('self', (value: SelfUpdate) => {
      this.liveStatus = 'on';
      this.applySelf(value);
    });
    poller.on('quests', () => void this.loadQuests(true));
    poller.on('reports', () => {
      this.unread.reports = true;
      void this.announceNewReport();
      void this.syncCharacter('report');
    });
    poller.on('read', (json) => {
      this.unread.reports = !json.reports;
      this.unread.messages = !json.messages;
      this.changed();
    });
    poller.on('nuggets', (countValue: number) => {
      this.character.nuggets = countValue;
      this.changed();
    });
    poller.on('ses', (stats) => this.applySesStats(stats));
    poller.on('tell', ({ from, message }: { from: string; message: string }) => this.info(`✉ ${from}: ${message}`));
    poller.on('chat', () => this.changed());
    poller.on('rooms', () => this.changed());
    poller.on('tellFailed', () => this.error('You can only whisper to players that you can see in a chat window.'));
    poller.on('invalid', (why: string) => {
      this.liveStatus = 'off';
      this.error(`Live updates stopped: ${why}. Press r to reload or A to log in.`);
    });
    poller.on('error', (caughtError: Error) => {
      this.liveStatus = 'error';
      this.error(`Live updates: ${caughtError.message} (retrying in 30 s)`);
    });
    poller.start();
    this.changed();
  }

  stopLive(): void {
    this.live?.stop();
    this.live = null;
    this.liveStatus = 'off';
    this.changed();
  }

  /** Last user input time; sent as `actioned` like the browser's click/keypress tracking. */
  touch(): void {
    if (this.live) {
      this.live.actioned = Date.now();
    }
  }

  applySelf(value: SelfUpdate): void {
    const character = this.character;
    if (
      value.x !== undefined &&
      value.y !== undefined &&
      (value.x !== character.position.x || value.y !== character.position.y)
    ) {
      character.position = { x: value.x, y: value.y };
    }
    const level = value.level;
    const leveled = level !== undefined && level > character.level;
    if (leveled && level !== undefined) {
      this.info(`Level up: ${level}!`);
      character.level = level;
    }
    const hpBefore = character.health;
    if (value.experience !== undefined && value.experience > character.experience) {
      character.experience = value.experience;
    }
    if (value.money !== undefined) {
      character.cash = value.money;
    }
    if (value.deposit !== undefined) {
      character.deposit = value.deposit;
    }
    // energy_date / health_date are offsets from now in seconds (Character.setEnergy @tw2game: getServerTime() + date).
    const now = this.clock.now();
    if (value.energy !== undefined) {
      character.setEnergy(value.energy, value.energyAt === undefined ? undefined : now + value.energyAt);
    }
    if (value.health !== undefined) {
      character.setHealth(value.health, value.healthAt === undefined ? undefined : now + value.healthAt);
      this.observeHealth(hpBefore, character.health);
    }
    if (leveled) {
      this.observeLevelUp();
    }
    this.changed();
  }

  /** Server time (ms) of the last successful syncCharacter(); 0 before the first. */
  lastSync = 0;
  private syncing = false;

  /**
   * Re-reads the character from a fresh game.php (the only place the browser gets the full set:
   * Character.init). Duels by other players change health/money server-side without a UserUpdate
   * push, so the header would otherwise keep showing regenerated, pre-attack values.
   * Runs in the background: no busy lock, errors only logged.
   */
  async syncCharacter(why = ''): Promise<void> {
    if (this.syncing) {
      return;
    }
    this.syncing = true;
    try {
      const { bootstrap } = await this.reopen();
      this.hasLoginBonus = !!bootstrap.player?.hasLoginBonus;
      this.inventory.setItemMeta(bootstrap.bag?.itemCooldown, bootstrap.bag?.itemLifetime);
      this.event = parseActiveEvent(bootstrap.game);
      const data = bootstrap.character;
      if (!data) {
        return;
      }
      const fresh = CharacterState.fromInit(data, this.clock);
      const character = this.character;
      const hpBefore = character.health;
      const cashBefore = character.cash;
      const leveled = fresh.level > character.level;
      if (leveled) {
        this.info(`Level up: ${fresh.level}!`);
      }
      character.level = fresh.level;
      character.experience = fresh.experience;
      character.cash = fresh.cash;
      character.deposit = fresh.deposit;
      character.nuggets = fresh.nuggets;
      character.position = fresh.position;
      character.homeTown = fresh.homeTown;
      character.duelLevel = fresh.duelLevel;
      character.maxEnergy = fresh.maxEnergy;
      character.maxHealth = fresh.maxHealth;
      character.healthRegen = fresh.healthRegen;
      character.energyRegen = fresh.energyRegen;
      character.setEnergy(Number(data.energy));
      character.setHealth(Number(data.health));
      character.lpPerPoint = fresh.lpPerPoint;
      this.observeHealth(hpBefore, character.health);
      if (leveled) {
        this.observeLevelUp();
      }
      if (data.taskQueue) {
        this.queue = parseQueue(data.taskQueue);
      }
      this.lastSync = Date.now();
      // Regen estimate vs. the server: a real drop means something happened to us.
      const lost = hpBefore - character.health;
      if (lost > Math.max(ATTACK_MIN_DROP, character.maxHealth * ATTACK_MIN_DROP_FRACTION)) {
        const cash = cashBefore > character.cash ? `, cash $${cashBefore} → $${character.cash}` : '';
        this.error(`⚔ Health ${hpBefore} → ${character.health}${cash}. Attacked? See reports (g r).`);
      }
      this.changed();
    } catch (err) {
      this.error(`Sync${why ? ` (${why})` : ''}: ${errorMessage(err)}`);
    } finally {
      this.syncing = false;
    }
  }

  /** Report ids already logged or listed, so each new report is logged once. */
  private seenReports = new Set<number>();

  /**
   * Logs each report not seen before, oldest first: job reports with their XP, money, HP and found items,
   * others by title (duels: "Duel: X vs Y"). Before any list was seen, only unread ones count as new.
   */
  private async announceNewReport(): Promise<void> {
    try {
      const list = await this.mail.reports(1, 'all');
      const known = this.seenReports.size > 0;
      const fresh = list.reports
        .filter((report) => !this.seenReports.has(report.id) && (known || !report.read))
        .reverse();
      this.recentReports = list.reports;
      void this.calibrateFromReports(list.reports);
      for (const report of list.reports) {
        this.seenReports.add(report.id);
      }
      for (const reportInfo of fresh) {
        this.info(reportLogLine(reportInfo));
      }
      if (!fresh.length) {
        this.info('New report.');
      }
    } catch {
      this.info('New report.');
    }
  }

  // ---- inventory & skills -------------------------------------------------------------------

  /** Item data (cached per game version). Inventory names need it. */
  async loadItems(): Promise<void> {
    if (this.items) {
      return;
    }
    await this.guard('Items', async () => {
      this.items = await loadItemCatalog(this.client, this.itemsFile, (messageValue) => this.info(messageValue));
      this.inventory.retype(this.items);
      this.info(`Item data: ${this.items.size} items.`);
    });
    if (!this.itemSets) {
      await this.guard('Item sets', async () => {
        this.itemSets = await loadItemSets(this.client, this.itemSetsFile, (messageValue) => this.info(messageValue));
      });
    }
  }

  /** What the web popup computes for this character: upgrade level, per-level bonuses, job names. */
  get statContext(): StatContext {
    return { charLevel: this.character.level, jobName: (id) => this.catalog.get(id)?.name };
  }

  itemStats(itemId: number): ItemStats | null {
    const entry = this.items?.get(itemId);
    return entry ? statsOf(entry, itemId, this.statContext) : null;
  }

  /** Item level requirement after Character.itemLevelRequirementDecrease (ItemPopup "- Level %1 (%2)"). */
  requiredLevel(itemId: number): { level: number; base: number } | null {
    const entry = this.items?.get(itemId);
    if (!entry?.level) {
      return null;
    }
    const dec = this.character.itemLevelDecrease;
    const decrease = (dec.all ?? 0) + (dec[entry.type] ?? 0);
    return { level: Math.max(1, entry.level - decrease), base: entry.level };
  }

  /** Set of an item: name, members (worn or not) and the bonus for the currently worn count. */
  itemSet(
    itemId: number,
  ): { name: string; worn: number; items: { id: number; name: string; worn: boolean }[]; bonus: string[] } | null {
    const entry = this.items?.get(itemId);
    const set = this.itemSets?.get(entry?.set);
    if (!set) {
      return null;
    }
    const wornBase = new Set([...this.inventory.wear.values()].map(baseId));
    const items = set.items.map((id) => ({
      id,
      name: this.items?.get(id * 1000)?.name ?? `item ${id}`,
      worn: wornBase.has(id),
    }));
    const worn = items.filter((index) => index.worn).length;
    return { name: set.name, worn, items, bonus: setBonusLines(set, worn, this.statContext) };
  }

  async refreshInventory(): Promise<void> {
    await this.guard('Inventory', async () => {
      const resultValue = await new InventoryApi(this.client).changedSince(this.inventory.lastInvId);
      this.inventory.applyChanges(resultValue.changes);
      this.inventory.applyWear(resultValue.wear);
    });
  }

  async loadEquipSets(): Promise<void> {
    await this.guard('Equipment sets', async () => {
      this.equipSets = await new InventoryApi(this.client).equipSets();
    });
  }

  /** Switches to a saved set; gear changes skill bonuses, so skills and jobs are refreshed too. */
  async switchEquipSet(id: number): Promise<void> {
    const set = this.equipSets?.sets.find((source) => source.id === id);
    if (!set) {
      return this.error('That equipment set is no longer available.');
    }
    const ok = await this.guard('Switch equipment', async () => {
      const resultValue = await new InventoryApi(this.client).switchEquip(id, this.inventory.lastInvId);
      this.inventory.applyChanges(resultValue.changes);
      this.inventory.setWearIds(resultValue.wear, this.items ?? undefined);
      if (resultValue.speed !== undefined) {
        this.character.speed = resultValue.speed;
      }
      this.info(`Equipped set: ${set.name}`);
      return true;
    });
    if (ok) {
      await this.afterGearChange();
    }
  }

  /** Saves the current wear as a new equipment set and returns its id when the server sends one. */
  async saveEquipSet(name: string): Promise<number | null> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      this.error('Give the equipment set a name.');
      return null;
    }
    const maximum = this.equipSets?.hasPremium ? this.equipSets.premiumMax : this.equipSets?.max;
    if (maximum && this.equipSets && this.equipSets.sets.length >= maximum) {
      this.error(`No free equipment-set slot (${this.equipSets.sets.length}/${maximum}).`);
      return null;
    }
    const saved = await this.guard('Save equipment set', async () => {
      const set = await new InventoryApi(this.client).saveEquip(trimmedName);
      this.info(`Saved equipment set: ${trimmedName}`);
      return set ?? true;
    });
    if (saved === undefined) {
      return null;
    }
    await this.loadEquipSets();
    return typeof saved === 'object'
      ? saved.id || null
      : (this.equipSets?.sets.find((set) => set.name === trimmedName)?.id ?? null);
  }

  /** Replaces a saved set with the current wear. */
  async replaceEquipSet(id: number): Promise<boolean> {
    const set = this.equipSets?.sets.find((source) => source.id === id);
    if (!set) {
      this.error('That equipment set is no longer available.');
      return false;
    }
    const replaced = await this.guard('Replace equipment set', async () => {
      await new InventoryApi(this.client).replaceEquip(id);
      this.info(`Replaced equipment set: ${set.name}`);
      return true;
    });
    if (replaced) {
      await this.loadEquipSets();
    }
    return !!replaced;
  }

  /** Collects today's reward and refreshes the character (XP/nuggets) and the streak. */
  async collectLoginReward(): Promise<void> {
    const rewards = await this.guard('Collect login bonus', async () => {
      const result = await collectLoginBonus(this.client);
      const text = loginRewardText(result);
      this.info(`Daily login bonus${text ? `: ${text}` : ' collected'}`);
      return result;
    });
    if (!rewards) {
      return;
    }
    this.hasLoginBonus = false;
    await this.syncCharacter('login bonus');
  }

  /** Startup hook: collect the free daily reward once when the bootstrap says it is available. */
  async autoCollectLoginBonus(): Promise<void> {
    if (!this.hasLoginBonus) {
      return;
    }
    await this.collectLoginReward();
  }

  /** Event generator items whose cooldown is over (header reminders). */
  eventReadyItems(): EventItem[] {
    return eventReadyItems(this.inventory, this.items, this.event, this.clock.now());
  }

  /** Live SesStatChanged: update the personal event counter without a full reload. */
  private applySesStats(stats: JsonObject): void {
    if (!this.event) {
      return;
    }
    for (const [key, value] of entries(stats)) {
      if (`ses:${key}` !== this.event.counterKey) {
        continue;
      }
      const points = Number(value);
      if (Number.isFinite(points)) {
        this.event = withEventPoints(this.event, points);
      }
    }
    this.changed();
  }

  async wear(itemId: number): Promise<void> {
    const type = this.items?.get(itemId)?.type;
    await this.guard('Wear', async () => {
      const resultValue = await new InventoryApi(this.client).carry(itemId, this.inventory.lastInvId);
      if (resultValue.error) {
        throw new Error(resultValue.error);
      }
      this.inventory.applyChanges(resultValue.changes);
      if (type) {
        this.inventory.wear.set(type, itemId);
      }
      if (resultValue.speed !== undefined) {
        this.character.speed = resultValue.speed;
      }
      this.info(`Equipped ${this.itemName(itemId)}`);
    });
    await this.afterGearChange();
  }

  async unwear(slot: string): Promise<void> {
    const id = this.inventory.wear.get(slot);
    if (id === undefined) {
      return;
    }
    await this.guard('Take off', async () => {
      const resultValue = await new InventoryApi(this.client).uncarry(slot, this.inventory.lastInvId);
      if (resultValue.error) {
        throw new Error(resultValue.error);
      }
      this.inventory.applyChanges(resultValue.changes);
      this.inventory.wear.delete(slot);
      if (resultValue.speed !== undefined) {
        this.character.speed = resultValue.speed;
      }
      this.info(`Took off ${this.itemName(id)}`);
    });
    await this.afterGearChange();
  }

  /** Gear changes skill bonuses → labor points; refresh both like the browser windows do. */
  private async afterGearChange(): Promise<void> {
    await this.refreshSkills();
    await this.loadJobs(true);
  }

  async refreshSkills(): Promise<void> {
    await this.guard('Skills', async () => {
      this.skills = await new SkillApi(this.client).overview();
      this.character.skills = this.skills.skills;
      this.character.skillBonus = this.skills.skillBonus;
    });
  }

  async saveSkills(plan: SkillPlan): Promise<boolean> {
    const ok = await this.guard('Save skills', async () => {
      const msg = await new SkillApi(this.client).save(plan);
      this.info(msg);
      return true;
    });
    await this.refreshSkills();
    if (ok) {
      await this.loadJobs(true);
    }
    return !!ok;
  }

  // ---- quests -------------------------------------------------------------------------------

  async loadQuests(quiet = false): Promise<void> {
    await this.guard('Quest log', async () => {
      const resultValue = await this.questApi.openQuests();
      const before = new Set(
        this.quests.filter((currentQuest) => currentQuest.finishable).map((currentQuest) => currentQuest.id),
      );
      this.quests = resultValue.quests;
      this.questCapacity = resultValue.capacity;
      for (const currentQuest of resultValue.quests) {
        if (currentQuest.finishable && !before.has(currentQuest.id) && quiet) {
          this.info(`Quest ready to finish: ${currentQuest.title}`);
        }
      }
      if (!quiet) {
        this.info(`Quest log: ${resultValue.quests.length}/${resultValue.capacity || '?'}`);
      }
    });
  }

  async loadSaloon(): Promise<void> {
    await this.guard('Saloon', async () => {
      this.saloon = await this.questApi.saloon();
    });
  }

  async openEmployer(key: string, at?: { x: number; y: number } | null): Promise<boolean> {
    const flag = await this.guard('Quest giver', async () => {
      this.employer = await this.questApi.employer(key, at);
      return true;
    });
    return !!flag;
  }

  async acceptQuest(currentQuest: Quest): Promise<void> {
    await this.guard('Accept quest', async () => {
      await this.questApi.accept(currentQuest.id);
      this.info(`Accepted: ${currentQuest.title}`);
    });
    await this.loadQuests(true);
    if (this.employer) {
      await this.openEmployer(
        this.employer.key,
        this.employer.x !== null && this.employer.y !== null ? { x: this.employer.x, y: this.employer.y } : null,
      );
    }
  }

  async finishQuest(currentQuest: Quest, rewardOption?: number): Promise<void> {
    await this.guard('Finish quest', async () => {
      const resultValue = await this.questApi.finish(currentQuest.id, rewardOption);
      if (resultValue.health !== undefined) {
        this.character.setHealth(resultValue.health);
      }
      this.info(
        `Finished: ${currentQuest.title}${resultValue.rewards.length ? ` → ${resultValue.rewards.join(', ')}` : ''}`,
      );
    });
    await this.loadQuests(true);
    if (this.items) {
      await this.refreshInventory();
    }
  }

  async cancelQuest(currentQuest: Quest): Promise<void> {
    await this.guard('Cancel quest', async () => {
      await this.questApi.cancel(currentQuest.id);
      this.info(`Cancelled quest: ${currentQuest.title}`);
    });
    await this.loadQuests(true);
  }

  /**
   * Where to get what an unsolved requirement needs: jobs that drop the item (Game.init.jobs yields), or the
   * job itself for "do job X" requirements. Each with the nearest location from the queue end.
   */
  requirementSources(req: QuestRequirement): (JobOption & { chance: number | null })[] {
    const found: { id: number; chance: number | null }[] = [];
    if (req.itemId !== undefined) {
      for (const yCoord of this.catalog.yielding(req.itemId)) {
        found.push({ id: yCoord.job.id, chance: yCoord.chance });
      }
    }
    if (req.jobId !== undefined) {
      found.push({ id: req.jobId, chance: null });
    }
    const from = this.queueEndPosition;
    return found.flatMap(({ id, chance }) => {
      const job = this.jobs.find((jobInfo) => jobInfo.id === id);
      if (!job) {
        return [];
      }
      const at = nearestLocation(this.locations.get(job.groupid), from);
      return [{ job, at, way: at ? wayTime(from, at, this.travelSpeed, this.character.speed) : null, chance }];
    });
  }

  /** Marks all source jobs of a quest's open requirements on the map; returns the nearest location. */
  highlightQuest(currentQuest: Quest): { x: number; y: number } | null {
    const sources = currentQuest.requirements
      .filter((requirement) => !requirement.solved)
      .flatMap((requirement) => this.requirementSources(requirement));
    if (!sources.length) {
      this.mapHighlight = null;
      return null;
    }
    this.mapHighlight = { label: currentQuest.title, jobIds: new Set(sources.map((source) => source.job.id)) };
    const near = sources
      .filter((source) => source.at)
      .sort((first, second) => (first.way ?? Infinity) - (second.way ?? Infinity))[0];
    this.changed();
    return near?.at ?? null;
  }

  // ---- walking & sleeping -------------------------------------------------------------------

  private queueFull(): boolean {
    if (this.queue.length < this.taskLimit) {
      return false;
    }
    this.error(
      `Task queue is full (${this.queue.length}/${this.taskLimit})${this.hasAutomation ? '' : '; automation premium raises the limit'}`,
    );
    return true;
  }

  /** Which way to page the market: the neighbour, or "next" from page 1 to page 2. */
  private marketNav(page: number): 'first' | 'next' | 'prev' {
    if (page > this.market.page) {
      return 'next';
    }
    if (page < this.market.page) {
      return 'prev';
    }
    return page > 1 ? 'next' : 'first';
  }

  /** Queued jobs cost energy; use the server's value, else subtract the accepted runs' costs. */
  applyQueuedEnergy(result: { energy?: number | undefined; added: unknown[] }, costs: readonly number[]): void {
    if (result.energy !== undefined) {
      this.character.setEnergy(result.energy);
      return;
    }
    if (!result.added.length) {
      return;
    }
    const spent = costs.slice(0, result.added.length).reduce((total, cost) => total + cost, 0);
    this.character.setEnergy(this.character.energy - spent);
  }

  private async addTask(label: string, post: Parameters<TaskApi['add']>[1][number], done: string): Promise<boolean> {
    if (this.queueFull()) {
      return false;
    }
    const flag = await this.guard(label, async () => {
      const res = await this.tasks.add(this.queue.length, [post], this.taskLimit);
      if (res.energy !== undefined) {
        this.character.setEnergy(res.energy);
      }
      for (const textValue of res.errors) {
        this.error(textValue);
      }
      if (!res.added.length) {
        return false;
      }
      this.queue.push(...res.added);
      this.info(done);
      return true;
    });
    return !!flag;
  }

  /** Map quest giver: TaskWalk(employer.key, 'questgiver', x, y) (QuestEmployerView @2225490). */
  walkToQuestGiver(key: string, name: string, at: { x: number; y: number }): Promise<boolean> {
    return this.addTask('Walk', walkPost(key, 'questgiver', at), `Walking to ${name}`);
  }

  /** Guidepost.start_walk(fortId, 'fort'). */
  walkToFort(fort: Fort): Promise<boolean> {
    return this.addTask('Walk', walkPost(fort.id, 'fort'), `Walking to ${fort.name}`);
  }

  async openHotel(townId: number): Promise<Hotel | null> {
    const hotelInfo = await this.guard('Hotel', async () => {
      this.hotel = await fetchHotel(this.client, townId);
      return this.hotel;
    });
    return hotelInfo ?? null;
  }

  /** TaskSleep(town_id, room); the server walks there first if needed. */
  async sleep(hotel: Hotel, room: HotelRoom): Promise<boolean> {
    const ok = await this.addTask(
      'Sleep',
      sleepPost(hotel.townId, room.key),
      `Sleeping in ${hotel.townName}: ${room.name}`,
    );
    const taskInfo = this.queue[this.queue.length - 1];
    if (ok && taskInfo?.type === 'sleep') {
      this.sleepRates.set(taskInfo.queueId, {
        energyRate: roomRate(room.energy) * this.calibration.roomScale,
        healthRate: roomRate(room.health),
      });
    }
    return ok;
  }

  async reload(): Promise<void> {
    await this.guard('Reload', async () => {
      this.apply(await this.reopen());
      this.lastSync = Date.now();
      this.info('Reloaded game state.');
    });
    await this.loadJobs(false, true);
    await this.loadQuests(true);
  }

  async refreshQueue(): Promise<void> {
    await this.guard('Task queue', async () => {
      this.queue = await this.tasks.list();
    });
  }

  /** Job infos (depend on gear, always fetched) and the minimap (cached 12 h on disk; `freshMap` refetches). */
  async loadJobs(quiet = false, freshMap = false): Promise<void> {
    await this.guard('Jobs', async () => {
      const jobs = await fetchJobInfos(this.client, this.catalog);
      const minimap = await cachedJson(
        `minimap-${new URL(this.client.worldUrl).host}`,
        async () => {
          const entry = await this.client.get('map', 'get_minimap');
          if (entry.error) {
            throw new Error(String(entry.msg ?? 'map/get_minimap failed'));
          }
          return entry;
        },
        { fresh: freshMap },
      );
      this.jobs = jobs.sort((first, second) => first.name.localeCompare(second.name));
      this.jobsVersion++;
      this.world = WorldMap.fromMinimap(minimap);
      if (!quiet) {
        this.info(`Loaded ${jobs.length} jobs.`);
      }
    });
  }

  /**
   * job/job is the only endpoint that returns danger and the location's real values, and it carries the
   * live motivation. Refreshes one selected/considered job, as the browser does when its window opens.
   */
  async loadJobDetail(job: JobInfo, at: Position): Promise<JobDetail | null> {
    const key = this.specialKey(job.id, at);
    if (this.jobDetailLoading.has(key)) {
      return null;
    }
    this.jobDetailLoading.add(key);
    try {
      const raw = await fetchJobDetail(this.client, job.id, at);
      const detail = parseJobDetail(raw);
      const current = this.jobs.find((jobInfo) => jobInfo.id === job.id);
      if (!current) {
        return detail;
      }
      let changed = false;
      if (detail.danger !== null && detail.danger !== current.danger) {
        current.danger = detail.danger;
        changed = true;
      }
      if (detail.motivation !== null && detail.motivation !== current.motivation) {
        current.motivation = detail.motivation;
        changed = true;
      }
      if (
        detail.luckValue &&
        (detail.luckValue[0] !== current.luckValue[0] || detail.luckValue[1] !== current.luckValue[1])
      ) {
        current.luckValue = detail.luckValue;
        changed = true;
      }
      if (detail.special) {
        this.specialRetry.delete(key);
        const seenAt = Date.now();
        this.specialDetails.set(key, {
          jobId: current.id,
          at: { ...at },
          kind: detail.special,
          detail,
          seenAt,
          raw,
        });
        // A job/job check can discover a special the tile cache missed; keep it in the same map.
        this.tiles.specialJobs.set(`${at.x},${at.y}#${current.id}`, {
          x: at.x,
          y: at.y,
          jobId: current.id,
          groupId: current.groupid,
          gold: detail.special === 'gold',
          silver: detail.special === 'silver',
          seenAt,
        });
        this.specialVersion++;
        changed = true;
        this.saveSpecialCache();
      } else {
        const tileKey = `${at.x},${at.y}#${job.id}`;
        let cacheChanged = false;
        if (this.tiles.specialJobs.has(tileKey)) {
          this.specialMisses.set(key, Date.now());
          this.tiles.specialJobs.delete(tileKey);
          cacheChanged = true;
        }
        if (this.specialDetails.delete(key)) {
          cacheChanged = true;
        }
        if (cacheChanged) {
          this.specialVersion++;
          changed = true;
          this.saveSpecialCache();
        }
        if (Object.keys(detail.values).length) {
          current.values = detail.values;
          current.valuesMotivation = detail.motivation ?? current.motivation;
          changed = true;
        }
      }
      if (changed) {
        this.jobsVersion++;
        this.changed();
      }
      return detail;
    } catch (err) {
      this.debug.add('request', `Job detail ${job.name} at ${at.x},${at.y} failed`, { error: errorMessage(err) });
      return null;
    } finally {
      this.jobDetailLoading.delete(key);
    }
  }

  /**
   * Loads the real values of the next discovered silver/gold job whose detail is not known yet (one request
   * per call; the caller decides when to spend it). Used by the autopilot toggle; the jobs screen loads the
   * selected row through loadJobDetail.
   */
  async loadNextSpecialJob(): Promise<boolean> {
    for (const special of this.tiles.specialJobs.values()) {
      const job = this.jobs.find((jobInfo) => jobInfo.id === special.jobId);
      if (!job || !isDoable(job)) {
        continue;
      }
      const at = { x: special.x, y: special.y };
      if (wayTime(this.queueEndPosition, at, this.travelSpeed, this.character.speed) > SPECIAL_PREFETCH_TRAVEL) {
        continue;
      }
      const key = this.specialKey(job.id, special);
      const known = this.specialDetails.get(key);
      const stale = known !== undefined && Date.now() - known.seenAt > SPECIAL_FRESH_MS;
      const missedAt = this.specialMisses.get(key);
      const retryAt = this.specialRetry.get(key);
      if (
        (known && !stale) ||
        this.jobDetailLoading.has(key) ||
        (missedAt !== undefined && Date.now() - missedAt < SPECIAL_MISS_TTL_MS) ||
        (retryAt !== undefined && Date.now() < retryAt)
      ) {
        continue;
      }
      const detail = await this.loadJobDetail(job, special);
      if (!detail) {
        this.specialRetry.set(key, Date.now() + 60_000);
      } else if (!detail.special) {
        this.specialMisses.set(key, Date.now());
        this.specialRetry.delete(key);
      } else {
        this.specialRetry.delete(key);
      }
      return true;
    }
    return false;
  }

  /** Re-reads a special job's values right before it is queued; false when it is no longer silver/gold. */
  async refreshSpecialJob(jobId: number, at: Position): Promise<boolean> {
    const job = this.jobs.find((jobInfo) => jobInfo.id === jobId);
    if (!job) {
      return false;
    }
    const detail = await this.loadJobDetail(job, at);
    if (!detail) {
      this.specialRetry.set(this.specialKey(jobId, at), Date.now() + 60_000);
      return false;
    }
    if (!detail.special) {
      this.specialDetails.delete(this.specialKey(jobId, at));
      this.specialVersion++;
      this.jobsVersion++;
      this.changed();
      return false;
    }
    return true;
  }

  /** Discovered special jobs with real values, for the autopilot planner. */
  specialJobOptions(): JobOption[] {
    const from = this.queueEndPosition;
    const out: JobOption[] = [];
    for (const special of this.tiles.specialJobs.values()) {
      const job = this.jobs.find((jobInfo) => jobInfo.id === special.jobId);
      const key = this.specialKey(special.jobId, special);
      const known = this.specialDetails.get(key);
      const missedAt = this.specialMisses.get(key);
      const retryAt = this.specialRetry.get(key);
      if (
        !job ||
        !known ||
        !isDoable(job) ||
        (missedAt !== undefined && Date.now() - missedAt < SPECIAL_MISS_TTL_MS) ||
        (retryAt !== undefined && Date.now() < retryAt)
      ) {
        continue;
      }
      const at = { x: special.x, y: special.y };
      out.push({
        job,
        at,
        way: wayTime(from, at, this.travelSpeed, this.character.speed),
        special: known.kind,
        values: this.scaleValues(known.detail.values, known.detail.motivation ?? job.motivation, job.motivation),
        valuesMotivation: job.motivation,
      });
    }
    return out;
  }

  /** Product names a job drops (static yields + per-duration drops), for search and display. */
  jobProducts(
    job: JobInfo,
    values: Partial<Record<DurationKey, JobDurationValues>> = this.currentJobValues(job),
  ): { itemId: number; name: string; percent: number | null }[] {
    const out = new Map<number, { itemId: number; name: string; percent: number | null }>();
    for (const yCoord of values.long?.items ?? values.middle?.items ?? []) {
      out.set(baseId(yCoord.itemId), {
        itemId: yCoord.itemId,
        name: this.itemName(yCoord.itemId),
        percent: yCoord.percent,
      });
    }
    for (const id of Object.keys(job.yields ?? {}).map(Number)) {
      if (!out.has(baseId(id))) {
        out.set(baseId(id), { itemId: id, name: this.itemName(id), percent: null });
      }
    }
    return [...out.values()];
  }

  /**
   * Jobs with the nearest location from where the queue ends, plus discovered silver/gold jobs with their
   * real job/job values. `filter` matches the job name or a product it drops. By default only jobs with
   * enough labor points; `showAll` adds the rest (as the web lists them: jobs you could reach by level).
   * `sort` orders by the 1 h values, best first.
   */
  jobOptions(filter = '', opts: { sort?: JobSort; showAll?: boolean } = {}): JobOption[] {
    const from = this.queueEndPosition;
    const textValue = filter.trim().toLowerCase();
    const sort = opts.sort ?? 'name';
    const allowed = (jobInfo: JobInfo) =>
      opts.showAll ? isDoable(jobInfo) || this.character.level >= jobInfo.level : isDoable(jobInfo);
    const matches = (jobInfo: JobInfo, values: Partial<Record<DurationKey, JobDurationValues>>) =>
      !textValue ||
      jobInfo.name.toLowerCase().includes(textValue) ||
      this.jobProducts(jobInfo, values).some((pick) => pick.name.toLowerCase().includes(textValue));
    const list: JobOption[] = this.jobs
      .filter((jobInfo) => allowed(jobInfo) && matches(jobInfo, this.currentJobValues(jobInfo)))
      .map((job) => {
        const at = nearestLocation(this.locations.get(job.groupid), from);
        return { job, at, way: at ? wayTime(from, at, this.travelSpeed, this.character.speed) : null };
      });
    for (const special of this.tiles.specialJobs.values()) {
      const job = this.jobs.find((jobInfo) => jobInfo.id === special.jobId);
      if (!job || !allowed(job)) {
        continue;
      }
      const known = this.specialDetails.get(this.specialKey(special.jobId, special));
      const kind = known?.kind ?? (special.gold ? 'gold' : 'silver');
      const values: Partial<Record<DurationKey, JobDurationValues>> = known?.detail.values ?? {};
      if (!matches(job, values)) {
        continue;
      }
      const at = { x: special.x, y: special.y };
      const way = wayTime(from, at, this.travelSpeed, this.character.speed);
      const normal = list.find((option) => option.job.id === job.id && option.at?.x === at.x && option.at?.y === at.y);
      if (normal) {
        normal.special = kind;
        normal.pendingSpecial = !known;
        normal.values = values;
        normal.valuesMotivation = known?.detail.motivation ?? job.motivation;
        normal.way = way;
        continue;
      }
      list.push({
        job,
        at,
        way,
        special: kind,
        pendingSpecial: !known,
        values,
        valuesMotivation: known?.detail.motivation ?? job.motivation,
      });
    }
    if (sort === 'name') {
      return list.sort(
        (first, second) =>
          first.job.name.localeCompare(second.job.name) ||
          (first.special ? 1 : 0) - (second.special ? 1 : 0) ||
          (first.at?.x ?? 0) - (second.at?.x ?? 0),
      );
    }
    if (sort === 'distance') {
      return list.sort((first, second) => (first.way ?? Infinity) - (second.way ?? Infinity));
    }
    return list.sort(
      (first, second) =>
        jobSortValue(second.job, sort, this.jobValues(second)) - jobSortValue(first.job, sort, this.jobValues(first)) ||
        first.job.name.localeCompare(second.job.name),
    );
  }

  async startJob(option: JobOption, duration: DurationKey): Promise<void> {
    const { job, at } = option;
    if (this.queueFull()) {
      return;
    }
    if (!at) {
      this.error(`No known location for ${job.name}`);
      return;
    }
    const seconds =
      this.jobValues(option)[duration]?.duration ?? job.values[duration]?.duration ?? job.durations[duration];
    const label = option.special ? `${option.special} ${job.name}` : job.name;
    await this.guard('Start job', async () => {
      const res = await this.tasks.add(this.queue.length, [jobPost(job.id, at, seconds)], this.taskLimit);
      if (res.energy !== undefined) {
        this.character.setEnergy(res.energy);
      }
      for (const textValue of res.errors) {
        this.error(textValue);
      }
      if (res.added.length) {
        this.queue.push(...res.added);
        this.info(`Queued ${label} (${duration}) at ${at.x},${at.y}`);
      }
    });
  }

  // ---- quest route ---------------------------------------------------------------------------

  /** Quests a route covers: one quest, its chain (accepted quests of the same chain) or the whole log. */
  routeQuests(scope: 'quest' | 'chain' | 'all', quest?: Quest): Quest[] {
    const open = this.quests.filter((currentQuest) => !currentQuest.finishable);
    if (scope === 'all' || !quest) {
      return open;
    }
    if (scope === 'chain') {
      return open.filter((currentQuest) =>
        quest.groupId ? currentQuest.groupId === quest.groupId : currentQuest.group === quest.group,
      );
    }
    return open.filter((currentQuest) => currentQuest.id === quest.id);
  }

  /** Outstanding needs of these quests, with bag counts and the names this game shows. */
  private needsOf(quests: Quest[]): RouteNeed[] {
    return questNeeds(
      quests,
      (id) => this.inventory.countBase(id),
      (id) => this.itemName(id),
      (id) => this.catalog.get(id)?.name ?? `job ${id}`,
    );
  }

  /** Best job route (from where the queue ends) for what these quests still need. */
  planQuestRoute(quests: Quest[], objective: RouteObjective = 'energy'): RoutePlan {
    const needs = this.needsOf(quests);
    return planRoute({
      needs,
      jobs: this.jobs,
      locations: (value) => this.locations.get(value),
      from: this.queueEndPosition,
      wayTime: (fromPosition, toPosition) => wayTime(fromPosition, toPosition, this.travelSpeed, this.character.speed),
      objective,
      walkEnergyPerSecond: (this.character.maxEnergy * this.character.energyRegen) / 3600,
      energyAvailable: this.character.energy,
    });
  }

  /**
   * Auto-route: the planned runs not queued yet. The 1 s ticker calls autoRouteStep(), which adds
   * the next ones (in route order) whenever the queue has room and there is energy for them.
   */
  autoRoute: { label: string; runs: RouteRun[]; total: number; retryAt: number } | null = null;

  private routeRuns(plan: RoutePlan): RouteRun[] {
    return plan.stops.flatMap((source) => {
      const jobInfo = source.job.values[source.duration];
      const run = {
        post: jobPost(source.job.id, source.at, jobInfo?.duration ?? source.job.durations[source.duration]),
        energy: jobInfo?.energy ?? Math.ceil(source.energy / Math.max(1, source.runs)),
        title: source.job.name,
      };
      return Array.from({ length: source.runs }, () => run);
    });
  }

  /** Queues the route's runs in order, as many as fit (one task/add call); `auto` keeps queueing the rest later. */
  async queueRoute(plan: RoutePlan, opts: { auto?: boolean; label?: string } = {}): Promise<number> {
    const runs = this.routeRuns(plan);
    const free = this.taskLimit - this.queue.length;
    if (opts.auto) {
      this.autoRoute = { label: opts.label ?? 'route', runs, total: runs.length, retryAt: 0 };
      const added = await this.autoRouteStep();
      if (this.autoRoute) {
        this.info(
          `Auto-route on: ${this.autoRoute.runs.length} more job(s) get queued as queue space and energy allow (R, then x stops).`,
        );
      }
      return added;
    }
    if (free <= 0) {
      this.queueFull();
      return 0;
    }
    // Only what the current energy pays for: the server would refuse the rest.
    const posts = runs.map((resultValue) => resultValue.post).slice(0, Math.min(free, plan.fitRuns));
    if (!posts.length) {
      this.error(
        `Not enough energy for the first route job (${this.character.energy} energy). Sleep or wait, then press R again.`,
      );
      return 0;
    }
    const value = await this.guard('Queue route', async () => {
      const res = await this.tasks.add(this.queue.length, posts, this.taskLimit);
      if (res.energy !== undefined) {
        this.character.setEnergy(res.energy);
      }
      for (const textValue of res.errors) {
        this.error(textValue);
      }
      this.queue.push(...res.added);
      const left = plan.totals.runs - res.added.length;
      const why =
        plan.fitRuns < plan.totals.runs && plan.fitRuns <= free ? 'you have the energy' : 'the queue has room';
      this.info(`Queued ${res.added.length} route job(s)${left > 0 ? `; ${left} more once ${why} (R again)` : ''}.`);
      return res.added.length;
    });
    return value ?? 0;
  }

  /** Adds the next auto-route runs that fit in the queue and the current energy; no request otherwise. */
  async autoRouteStep(): Promise<number> {
    const auto = this.autoRoute;
    if (!auto || this.busy || Date.now() < auto.retryAt) {
      return 0;
    }
    if (!auto.runs.length) {
      this.autoRoute = null;
      this.info(`Auto-route done: all ${auto.total} job(s) queued.`);
      return 0;
    }
    const free = this.taskLimit - this.queue.length;
    let energy = this.character.energy;
    const batch: RouteRun[] = [];
    for (const run of auto.runs) {
      if (batch.length >= free || run.energy > energy) {
        break;
      }
      batch.push(run);
      energy -= run.energy;
    }
    if (!batch.length) {
      return 0;
    }
    const added = await this.guard('Auto-route', async () => {
      const res = await this.tasks.add(
        this.queue.length,
        batch.map((second) => second.post),
        this.taskLimit,
      );
      this.applyQueuedEnergy(
        res,
        batch.map((run) => run.energy),
      );
      this.queue.push(...res.added);
      return res;
    });
    if (this.autoRoute !== auto) {
      return added?.added.length ?? 0; // stopped meanwhile
    }
    if (!added?.added.length) {
      // Refused (energy/queue out of sync, job gone, …): retry in a minute instead of hammering.
      for (const textValue of added?.errors ?? []) {
        this.error(`Auto-route: ${textValue}`);
      }
      auto.retryAt = Date.now() + 60_000;
      void this.refreshQueue();
      return 0;
    }
    for (const errorText of added.errors) {
      this.error(`Auto-route: ${errorText}`);
    }
    auto.runs = auto.runs.slice(added.added.length);
    this.info(
      `Auto-route: queued ${added.added.map((taskInfo) => taskInfo.title).join(', ')} (${auto.runs.length} left).`,
    );
    if (!auto.runs.length) {
      this.autoRoute = null;
      this.info(`Auto-route done: all ${auto.total} job(s) queued.`);
    }
    this.changed();
    return added.added.length;
  }

  stopAutoRoute(): void {
    if (!this.autoRoute) {
      return;
    }
    this.info(`Auto-route stopped (${this.autoRoute.runs.length} job(s) not queued).`);
    this.autoRoute = null;
    this.changed();
  }

  // ---- autopilot -----------------------------------------------------------------------------

  /** Settings, rules and the last plan (autopilot.json). */
  autopilot: AutopilotFile = loadAutopilot();
  /** Plans and carries out; the TUI ticker calls runner.step() every second. */
  runner = new AutopilotRunner(this);

  /** The quest screen's route shortcut: autopilot on, quests first, limited to these quests. */
  startAutopilotForQuests(ids: number[], label: string): void {
    this.stopAutoRoute();
    this.updateAutopilot((autopilotFile) => {
      autopilotFile.rules.onlyQuests = ids;
      autopilotFile.config.running = true;
      autopilotFile.config.modules.jobs = true;
      autopilotFile.config.priority = [
        'quests',
        ...autopilotFile.config.priority.filter((group) => group !== 'quests'),
      ];
    });
    this.info(`Autopilot on for ${label}: quests first (G to change, R to pause).`);
  }

  /** Runs one autopilot request under the busy lock; errors are thrown to the caller (it retries / pauses). */
  async autopilotCall<Value>(fn: () => Promise<Value>, label = 'autopilot request'): Promise<Value> {
    if (this.busy) {
      this.debug.add('request', `${label}: refused (busy)`);
      throw new Error('busy');
    }
    this.busy = true;
    this.changed();
    const startedAt = Date.now();
    try {
      const resultValue = await fn();
      this.debug.add('request', `${label}: ok (${Date.now() - startedAt} ms)`, { result: resultValue });
      return resultValue;
    } catch (err) {
      this.debug.add('request', `${label}: failed (${Date.now() - startedAt} ms)`, {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      throw err;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  /**
   * The first open requirement of a quest the autopilot cannot get, or null when it can finish the quest:
   * items need a doable job that drops them, enough in the bag, or (buying on) a place to buy them within the
   * limits; job requirements a doable job; a time window only waits. Anything else ("Go to …", "Resolve …",
   * duels) it cannot do yet.
   */
  questBlocker(currentQuest: Quest): string | null {
    const purchaseValue = this.questPurchase(currentQuest);
    return purchaseValue.blocker ?? purchaseValue.problem;
  }

  /**
   * What a quest still needs bought (items no doable job drops and the bag lacks), where from (`picks`), and why
   * not: `blocker` is a requirement that buying cannot help with, `problem` an item it cannot buy. `used`: bag
   * items earlier quests count on (questPurchases); this quest's are added to it.
   */
  questPurchase(currentQuest: Quest, used = new Map<number, number>()): QuestPurchase {
    const cfg = this.autopilot.config.quests;
    const have = (itemId: number) => Math.max(0, this.inventory.countBase(itemId) - (used.get(baseId(itemId)) ?? 0));
    // Bag items this quest counts on, per item (a "have it" and a "wear it" requirement share one).
    const mine = new Map<number, number>();
    for (const requirement of currentQuest.requirements) {
      if (requirement.itemId !== undefined && requirement.kind !== 'bought') {
        mine.set(
          baseId(requirement.itemId),
          Math.max(
            mine.get(baseId(requirement.itemId)) ?? 0,
            Math.min(have(requirement.itemId), requirement.count ?? 1),
          ),
        );
      }
    }
    const needs = new Map<number, BuyNeed>();
    const want = (itemId: number, count: number, name: string) => {
      const prev = needs.get(baseId(itemId));
      if (count > have(itemId) && (!prev || prev.count < count - have(itemId))) {
        needs.set(baseId(itemId), { itemId, name, count: count - have(itemId) });
      }
    };
    const result = this.purchaseOf(currentQuest, have, want, needs, cfg);
    for (const [id, countValue] of mine) {
      used.set(id, (used.get(id) ?? 0) + countValue);
    }
    return result;
  }

  /** questPurchase for several quests in order: bag items go to the first quest that needs them, the rest buy more. */
  questPurchases(quests: Quest[]): Map<number, ReturnType<GameState['questPurchase']>> {
    const used = new Map<number, number>();
    return new Map(quests.map((currentQuest) => [currentQuest.id, this.questPurchase(currentQuest, used)]));
  }

  private purchaseOf(
    currentQuest: Quest,
    have: (itemId: number) => number,
    want: (itemId: number, count: number, name: string) => void,
    needs: Map<number, BuyNeed>,
    cfg: AutopilotFile['config']['quests'],
  ): QuestPurchase {
    const nothingToBuy = (blocker: string | null): QuestPurchase => ({
      needs: [],
      picks: [],
      blocker,
      problem: null,
    });
    for (const requirement of currentQuest.requirements) {
      if (requirement.solved || requirement.kind === 'window') {
        continue;
      }
      if (requirement.itemId !== undefined) {
        if (have(requirement.itemId) >= (requirement.count ?? 1)) {
          continue;
        }
        if (this.requirementSources(requirement).some((xCoord) => isDoable(xCoord.job) && xCoord.at)) {
          continue;
        }
        if (!cfg.buy) {
          return nothingToBuy(`${requirement.info}: no doable job drops it`);
        }
        want(requirement.itemId, requirement.count ?? 1, this.itemName(requirement.itemId));
        continue;
      }
      if (requirement.kind === 'bought' && requirement.buy && cfg.buy) {
        const id = this.items?.findByName(requirement.buy);
        if (id === undefined) {
          return nothingToBuy(`${requirement.info}: unknown item`);
        }
        // Bought means bought: one in the bag does not count.
        needs.set(baseId(id), { itemId: id, name: requirement.buy, count: 1 });
        continue;
      }
      if (requirement.jobId !== undefined) {
        const job = this.jobs.find((jobInfo) => jobInfo.id === requirement.jobId);
        if (job && isDoable(job)) {
          continue;
        }
        return nothingToBuy(`${requirement.info}: job not doable`);
      }
      return nothingToBuy(`${requirement.info}: the autopilot cannot do this`);
    }
    if (!needs.size) {
      return nothingToBuy(null);
    }
    const list = [...needs.values()];
    const from = this.queueEndPosition;
    const towns = new Map(
      this.world.towns.filter((townInfo) => townInfo.name).map((townInfo) => [townInfo.id, townInfo]),
    );
    const { picks, problem } = chooseBuys(
      list,
      (id) =>
        this.buyCatalog.sources(
          id,
          (xCoord) => this.items?.get(xCoord)?.price ?? 0,
          (tid) => {
            const entry = towns.get(tid);
            return entry?.name ? { name: entry.name, at: { x: entry.x, y: entry.y } } : undefined;
          },
          (at) => this.townAt(at)?.id,
        ),
      {
        buyLimit: cfg.buyLimit,
        marketLimit: cfg.marketLimit,
        market: cfg.market,
        walkValue: cfg.walkValue / 60,
        maxWalk: cfg.buyTrip,
      },
      (at) => wayTime(from, at, this.travelSpeed, this.character.speed),
    );
    return { needs: list, picks, blocker: null, problem };
  }

  /**
   * Quests the autopilot may work on: open quests (or the route's), minus excluded ones and chains.
   * `includeUnfinishable` also keeps quests it cannot finish.
   */
  autopilotQuests(includeUnfinishable = this.autopilot.config.quests.unfinishable): Quest[] {
    const { rules, config } = this.autopilot;
    return this.routeQuests('all').filter(
      (quest) => questInScope(quest, rules, config) && (includeUnfinishable || !this.questBlocker(quest)),
    );
  }

  /**
   * Shop stops for the quests the autopilot works on (one per town: what to buy there, for what) and pickups of
   * market offers it bought. Mobile-trader and market buys need no walk; the quest module does them on the spot.
   */
  buyTrips(): BuyTrip[] {
    const trips = new Map<number, BuyTrip>();
    const add = (townId: number, name: string, at: Position, cost: number, what: string) => {
      const entry = trips.get(townId) ?? { townId, name, at, cost: 0, what: [] };
      entry.cost += cost;
      entry.what.push(what);
      trips.set(townId, entry);
    };
    if (this.autopilot.config.quests.buy) {
      const quests = this.autopilotQuests(false);
      const all = this.questPurchases(quests);
      for (const currentQuest of quests) {
        const purchase = all.get(currentQuest.id);
        if (!purchase) {
          continue;
        }
        for (const pick of purchase.picks) {
          if (pick.source.kind === 'shop') {
            add(
              pick.source.townId,
              pick.source.townName,
              pick.source.at,
              pick.cost,
              `${pick.count > 1 ? `${pick.count}× ` : ''}${pick.name} (${where(pick.source).split(' in ')[0]}) for "${currentQuest.soloTitle || currentQuest.title}"`,
            );
          }
        }
      }
    }
    for (const pickInfo of this.autopilot.pickups) {
      add(
        pickInfo.townId,
        pickInfo.townName,
        pickInfo.at,
        0,
        `pick up ${pickInfo.count > 1 ? `${pickInfo.count}× ` : ''}${this.itemName(pickInfo.itemId)} (market) for "${pickInfo.quest}"`,
      );
    }
    return [...trips.values()];
  }

  /**
   * What the Quests goal works on, with the autopilot's extras per need: urgency `weight` (up to 2× for a quest
   * ending within 3 days) and the quests' XP / $ rewards spread over the units each quest still needs.
   */
  autopilotNeeds(): RouteNeed[] {
    const quests = this.autopilotQuests();
    const needs = this.needsOf(quests);
    const now = this.clock.now();
    for (const currentQuest of quests) {
      const mine = needs.filter((need) => need.quests.includes(currentQuest.soloTitle || currentQuest.title));
      const units = mine.reduce(
        (accumulator, currentValue) =>
          accumulator + (currentValue.unit === 'seconds' ? currentValue.amount / 3600 : currentValue.amount),
        0,
      );
      if (!mine.length || units <= 0) {
        continue;
      }
      const rewardTotal = (pattern: RegExp) =>
        currentQuest.rewards.reduce(
          (total, reward) =>
            total + (reward.item === null && pattern.test(reward.text) ? parseGameNumber(reward.text) : 0),
          0,
        );
      const xp = rewardTotal(/experience/i);
      const money = rewardTotal(/dollar/i);
      const ends = questEnds(currentQuest.limited);
      const left = ends === null ? Infinity : (ends - now) / 3600;
      const weight = 1 + Math.max(0, Math.min(1, 1 - left / 72));
      for (const need of mine) {
        const per = need.unit === 'seconds' ? 1 / 3600 : 1;
        need.xpPerUnit = (need.xpPerUnit ?? 0) + (xp / units) * per;
        need.moneyPerUnit = (need.moneyPerUnit ?? 0) + (money / units) * per;
        need.weight = Math.max(need.weight ?? 1, weight);
      }
    }
    return needs;
  }

  /** Changes the autopilot file and saves it. */
  updateAutopilot(fn: (autopilotFile: AutopilotFile) => void): void {
    fn(this.autopilot);
    saveAutopilot(this.autopilot);
    this.changed();
  }

  /**
   * A queued job's definition and the duration it runs for. The queue entry has no duration key (not seen in
   * task/get_tasks), so it is the duration closest to the work time (end − walk end).
   */
  queuedJob(taskInfo: QueuedTask): { job: JobInfo; duration: DurationKey; values: JobDurationValues } | null {
    const job = taskInfo.jobId === undefined ? undefined : this.jobs.find((jobInfo) => jobInfo.id === taskInfo.jobId);
    if (!job) {
      return null;
    }
    const special = this.specialAt(job.id, taskInfo.coords);
    const values = special
      ? this.scaleValues(special.detail.values, special.detail.motivation ?? job.motivation, job.motivation)
      : this.currentJobValues(job);
    const secs = taskInfo.end - (taskInfo.way?.end ?? taskInfo.start);
    let found: { job: JobInfo; duration: DurationKey; values: JobDurationValues } | null = null;
    let best = Infinity;
    for (const entryKey of DURATION_KEYS) {
      const jobInfo = values[entryKey];
      if (jobInfo && Math.abs(jobInfo.duration - secs) < best) {
        [found, best] = [{ job, duration: entryKey, values: jobInfo }, Math.abs(jobInfo.duration - secs)];
      }
    }
    return found;
  }

  /** A server queue entry as a fixed timeline step; job rewards from the job's values for its duration. */
  queuedStep(taskInfo: QueuedTask): TimelineStep {
    const fixed = { start: taskInfo.start, end: taskInfo.end };
    if (taskInfo.type === 'job' && taskInfo.jobId !== undefined) {
      const searchQuery = this.queuedJob(taskInfo);
      const secs = taskInfo.end - (taskInfo.way?.end ?? taskInfo.start);
      return {
        kind: 'job',
        title: taskInfo.title,
        jobId: taskInfo.jobId,
        at: taskInfo.coords,
        duration: secs,
        energy: 0,
        xp: searchQuery?.values.experience ?? 0,
        money: searchQuery?.values.money ?? 0,
        fixed,
      };
    }
    // Sleep rates are not in the queue entry; base regen until the room's units are known (docs/autopilot.md).
    if (taskInfo.type === 'sleep') {
      const entry = this.sleepRates.get(taskInfo.queueId);
      return {
        kind: 'sleep',
        title: taskInfo.title,
        at: taskInfo.coords,
        energyRate: entry?.energyRate ?? this.character.energyRegen,
        healthRate: entry?.healthRate ?? this.character.healthRegen,
        fixed,
      };
    }
    return { kind: 'walk', title: taskInfo.title, at: taskInfo.coords, fixed };
  }

  /** Projection of the server queue followed by `planned` steps, from now. */
  timeline(planned: TimelineStep[] = []): Timeline {
    const character = this.character;
    return projectTimeline(
      {
        now: this.clock.now(),
        at: character.position,
        energy: character.energy,
        maxEnergy: character.maxEnergy,
        health: character.health,
        maxHealth: character.maxHealth,
        energyRegen: character.energyRegen,
        healthRegen: character.healthRegen,
        level: character.level,
        experience: character.experience,
        maxLevel: character.maxLevel,
        cash: character.cash,
      },
      [...this.queue.map((taskInfo) => this.queuedStep(taskInfo)), ...planned],
      {
        wayTime: (fromPosition, toPosition) => wayTime(fromPosition, toPosition, this.travelSpeed, character.speed),
      },
    );
  }

  /** Marks the route's jobs on the map. */
  highlightRoute(plan: RoutePlan, label: string): { x: number; y: number } | null {
    if (!plan.stops.length) {
      return null;
    }
    this.mapHighlight = { label, jobIds: new Set(plan.stops.map((source) => source.job.id)) };
    this.changed();
    return plan.stops[0]?.at ?? null;
  }

  /** Loads silver/gold jobs discovered in the last day, with any real job/job values already fetched. */
  loadSpecialCache(): void {
    const saved = loadSpecialJobs(this.client.worldUrl);
    let changed = false;
    for (const job of saved.jobs) {
      const key = `${job.x},${job.y}#${job.jobId}`;
      const current = this.tiles.specialJobs.get(key);
      if (!current || job.seenAt > current.seenAt) {
        this.tiles.specialJobs.set(key, job);
        changed = true;
      }
    }
    for (const special of saved.details) {
      const key = this.specialKey(special.jobId, special.at);
      const current = this.specialDetails.get(key);
      if (!current || special.seenAt > current.seenAt) {
        this.specialDetails.set(key, special);
        changed = true;
      }
    }
    if (changed) {
      this.specialVersion++;
      this.jobsVersion++;
      this.changed();
    }
    this.debug.add(
      'state',
      `Special jobs: loaded ${saved.jobs.length} position(s), ${saved.details.length} with values from disk`,
    );
  }

  private saveSpecialCache(): void {
    let pruned = false;
    for (const [key, special] of this.specialDetails) {
      if (!this.tiles.specialJobs.has(`${special.at.x},${special.at.y}#${special.jobId}`)) {
        this.specialDetails.delete(key);
        pruned = true;
      }
    }
    saveSpecialJobs(this.client.worldUrl, this.tiles.specialJobs.values(), this.specialDetails.values());
    if (pruned) {
      this.specialVersion++;
      this.jobsVersion++;
    }
  }

  /** Discovers silver/gold job positions around the map cursor (the browser's normal tile loader). */
  async loadTilesAround(at: { x: number; y: number }): Promise<void> {
    try {
      if (await this.tiles.loadAround(this.client, at)) {
        this.specialVersion++;
        this.saveSpecialCache();
        this.changed();
      }
    } catch (err) {
      this.error(`Map tiles: ${errorMessage(err)}`);
    }
  }

  /** Guidepost.start_walk(townId, 'town') → TaskWalk(unitId, type) with no x/y. */
  walkToTown(town: Town): Promise<boolean> {
    return this.addTask('Walk', walkPost(town.id, 'town'), `Walking to ${town.name ?? `town ${town.id}`}`);
  }

  async cancel(position: number): Promise<void> {
    const task = this.queue[position];
    if (!task) {
      return;
    }
    await this.guard('Cancel', async () => {
      const res = await this.tasks.cancel(this.queue, [position]);
      if (res.energy !== undefined) {
        this.character.setEnergy(res.energy);
      }
      if (res.money !== undefined) {
        this.character.cash = res.money;
      }
      for (const textValue of res.errors) {
        this.error(textValue);
      }
      this.queue = res.queue;
      this.info(`Cancelled: ${task.title}`);
    });
  }

  // ---- chat ---------------------------------------------------------------------------------

  /** Says something in a chat room, or whispers when `room` is "tell:<name>". */
  async chatSay(room: string, text: string): Promise<boolean> {
    const live = this.live;
    if (!live?.active) {
      this.error('Chat needs live updates (press L).');
      return false;
    }
    try {
      if (room.startsWith('tell:')) {
        await live.whisper(room.slice(5), text);
      } else {
        await live.say(room, text);
      }
      return true;
    } catch (err) {
      this.error(`Chat: ${errorMessage(err)}`);
      return false;
    }
  }

  // ---- mail ---------------------------------------------------------------------------------

  private get mail(): MailApi {
    return new MailApi(this.client, (id) => this.itemName(id));
  }

  async loadReports(page = 1, folder: ReportFolder = this.reportFolder): Promise<void> {
    await this.guard('Reports', async () => {
      this.reports = await this.mail.reports(page, folder);
      this.reportFolder = folder;
      this.unread.reports = false;
    });
  }

  /** Home screen's report list: one page-1 read in the background (no busy lock, errors only logged). */
  async loadRecentReports(): Promise<void> {
    try {
      this.recentReports = (await this.mail.reports(1, 'all')).reports;
      for (const report of this.recentReports) {
        this.seenReports.add(report.id);
      }
      this.changed();
    } catch (err) {
      this.error(`Reports: ${errorMessage(err)}`);
    }
  }

  async openReport(row: ReportRow): Promise<Report | null> {
    const report = await this.guard('Report', async () => {
      const rep = await this.mail.report(row.id, row.hash);
      row.read = true;
      return rep;
    });
    return report ?? null;
  }

  async deleteReport(row: ReportRow): Promise<void> {
    const ok = await this.guard('Delete report', async () => {
      await this.mail.deleteReport(row.id, this.reportFolder);
      this.info(`Deleted report: ${row.title}`);
      return true;
    });
    if (ok) {
      await this.loadReports(this.reports?.page ?? 1);
    }
  }

  async loadTelegrams(page = 1): Promise<void> {
    await this.guard('Telegrams', async () => {
      this.telegrams = await this.mail.telegrams(page);
      this.unread.messages = false;
    });
  }

  async openTelegram(id: number, page = 0): Promise<Telegram | null> {
    const foundValue = await this.guard('Telegram', async () => {
      const telegram = await this.mail.telegram(id, page);
      const row = this.telegrams?.telegrams.find((xCoord) => xCoord.id === id);
      if (row) {
        row.unread = false;
      }
      return telegram;
    });
    return foundValue ?? null;
  }

  async replyTelegram(id: number, text: string): Promise<boolean> {
    const ok = await this.guard('Reply', async () => {
      await this.mail.reply(id, text);
      this.info('Reply sent.');
      return true;
    });
    return !!ok;
  }

  async sendTelegram(to: string, subject: string, text: string): Promise<boolean> {
    const ok = await this.guard('Telegram', async () => {
      await this.mail.send(to, subject, text);
      this.info(`Your telegram to ${to} was sent!`);
      return true;
    });
    if (ok) {
      await this.loadTelegrams(1);
    }
    return !!ok;
  }

  async deleteTelegram(id: number): Promise<void> {
    const ok = await this.guard('Delete telegram', async () => {
      await this.mail.deleteTelegram(id);
      return true;
    });
    if (ok) {
      await this.loadTelegrams(this.telegrams?.page ?? 1);
    }
  }

  // ---- town: bank, shops, market, item use ---------------------------------------------------

  /** Town at the character's position (you are in it), else null. */
  get townHere(): Town | null {
    const positionValue = this.character.position;
    return (
      this.world.towns.find(
        (townInfo) => townInfo.x === positionValue.x && townInfo.y === positionValue.y && townInfo.name,
      ) ?? null
    );
  }

  /** Where the trade screen shops: the town you stand in, else your home town. */
  get tradeTown(): { id: number; name: string; here: boolean } | null {
    const here = this.townHere;
    if (here) {
      return { id: here.id, name: here.name ?? `town ${here.id}`, here: true };
    }
    const home = this.character.homeTown;
    if (!home) {
      return null;
    }
    const foundValue = this.world.towns.find((townInfo) => townInfo.id === home.id);
    return { id: home.id, name: foundValue?.name ?? `town ${home.id}`, here: false };
  }

  townAt(at: { x: number; y: number }): Town | undefined {
    return this.world.towns.find((townInfo) => townInfo.x === at.x && townInfo.y === at.y);
  }

  async openBank(townId: number): Promise<void> {
    await this.guard('Bank', async () => {
      this.bank = await fetchBank(this.client, townId);
    });
  }

  /** City hall of the home town (construction rights live there). */
  async loadTownHall(): Promise<void> {
    const home = this.character.homeTown;
    if (!home) {
      return this.error('You are not a member of a town.');
    }
    await this.guard('Town hall', async () => {
      this.townHall = await fetchTownHall(this.client, home.id);
    });
  }

  async openConstruction(building: TownBuilding): Promise<Construction | null> {
    const home = this.character.homeTown;
    if (!home) {
      this.error('You are not a member of a town.');
      return null;
    }
    const resultValue = await this.guard('Construction', async () => {
      this.construction = await fetchConstruction(this.client, home.x, home.y, building.key);
      return this.construction;
    });
    return resultValue ?? null;
  }

  /** Queues TaskBuild; the server walks to the town first when needed. */
  async queueConstruction(duration: number, pay: 'town' | 'player'): Promise<boolean> {
    const candidate = this.construction;
    if (!candidate) {
      return false;
    }
    if (!candidate.durations.some((dataValue) => dataValue.seconds === duration)) {
      this.error('That construction duration is not available.');
      return false;
    }
    return this.addTask(
      'Construction',
      buildPost({ x: candidate.x, y: candidate.y }, candidate.key, duration, pay),
      `Queued construction: ${candidate.name}`,
    );
  }

  async depositMoney(amount: number): Promise<void> {
    const bank = this.bank;
    if (!bank) {
      return;
    }
    if (!(amount > 0)) {
      return this.error('Enter an amount to deposit.');
    }
    if (amount > this.character.cash) {
      return this.error(`You only have ${this.character.cash} in cash.`);
    }
    await this.guard('Deposit', async () => {
      const resultValue = await deposit(this.client, bank.townId, amount);
      this.character.cash = resultValue.cash;
      this.character.deposit = resultValue.deposit;
      this.bank = { ...bank, cash: resultValue.cash, deposit: resultValue.deposit };
      this.info(`You deposited $ ${amount} and paid a fee of $ ${resultValue.fee}`);
    });
  }

  async openShop(key: ShopKey, townId: number): Promise<void> {
    await this.guard('Shop', async () => {
      this.shop = await fetchShop(this.client, key, townId);
    });
  }

  /** Rotating offers of the mobile trader; no town needed. */
  async openMobileTrader(): Promise<void> {
    await this.guard('Mobile trader', async () => {
      this.mobileTrader = await fetchMobileTrader(this.client);
    });
  }

  async buyMobileTrader(item: MobileTraderItem): Promise<void> {
    const ok = await this.guard('Buy from mobile trader', async () => {
      const resultValue = await buyMobileTrader(this.client, item);
      this.applyMoney(resultValue);
      const name = this.itemName(item.itemId);
      this.info(
        `Bought ${name}${resultValue.message && !resultValue.message.includes(name) ? `: ${resultValue.message}` : ''}`,
      );
      return true;
    });
    if (!ok) {
      return;
    }
    await this.refreshInventory();
    await this.openMobileTrader();
  }

  /** Shop price: item price × the shop's charge (Trader.addItemToInv). */
  shopPrice(itemId: number): number {
    return Math.round((this.items?.get(itemId)?.price ?? 0) * (this.shop?.charge || 1));
  }

  private applyMoney(resultValue: { cash?: number | undefined; deposit?: number | undefined }): void {
    if (typeof resultValue.cash === 'number') {
      this.character.cash = resultValue.cash;
    }
    if (typeof resultValue.deposit === 'number') {
      this.character.deposit = resultValue.deposit;
    }
  }

  async buyFromShop(itemId: number): Promise<void> {
    const shop = this.shop;
    if (!shop) {
      return;
    }
    await this.guard('Buy', async () => {
      const resultValue = await shopBuy(this.client, shop.key, shop.townId, itemId, this.inventory.lastInvId);
      this.inventory.applyChanges(resultValue.changes);
      this.applyMoney(resultValue);
      this.info(`Bought ${this.itemName(itemId)}`);
    });
  }

  async sellToShop(itemId: number, count = 1): Promise<void> {
    const shop = this.shop;
    const item = this.inventory.bag.get(itemId);
    if (!shop || !item) {
      return;
    }
    if (this.items?.get(itemId)?.sellable === false) {
      return this.error(`${this.itemName(itemId)} cannot be sold.`);
    }
    await this.guard('Sell', async () => {
      const resultValue = await shopSell(
        this.client,
        shop.key,
        shop.townId,
        item,
        Math.min(count, item.count),
        this.inventory.lastInvId,
      );
      this.inventory.applyChanges(resultValue.changes);
      this.applyMoney(resultValue);
      this.info(`Sold ${count > 1 ? `${count}× ` : ''}${this.itemName(itemId)}`);
    });
  }

  async useItem(itemId: number, count = 1): Promise<void> {
    const entry = this.items?.get(itemId);
    if (entry && entry.usetype === 'none') {
      return this.error(`${entry.name} cannot be used.`);
    }
    await this.guard('Use item', async () => {
      const resultValue = await useItem(this.client, itemId, count, this.inventory.lastInvId, (id) =>
        this.itemName(id),
      );
      this.inventory.applyChanges(resultValue.changes);
      if (resultValue.itemCooldown !== undefined) {
        this.inventory.itemCooldown.set(itemId, resultValue.itemCooldown);
      }
      if (resultValue.itemLifetime !== undefined) {
        this.inventory.itemLifetime.set(itemId, resultValue.itemLifetime);
      }
      if (resultValue.energy !== undefined) {
        this.character.setEnergy(resultValue.energy);
      }
      if (resultValue.health !== undefined) {
        this.character.setHealth(resultValue.health);
      }
      this.info(
        `Used ${this.itemName(itemId)}${resultValue.effects.length ? `: ${resultValue.effects.join(' ')}` : ''}`,
      );
    });
    if (entry?.usetype === 'buff' || entry?.usebonus?.length) {
      await this.refreshSkills();
    }
    if (entry?.usebonus?.some((textValue) => /work motivation/i.test(textValue))) {
      await this.loadJobs(true);
    }
  }

  private get marketApi(): MarketApi {
    return new MarketApi(this.client);
  }

  /** Searches goods for sale (or buy orders, with filter.buyOrders). Keeps the last filter when none is given. */
  async searchMarket(query: string, page = 1, filter: MarketFilter = this.market.filter): Promise<void> {
    const nav = this.marketNav(page);
    await this.guard('Market', async () => {
      const resultValue = await this.marketApi.search(query, page, filter, nav);
      this.market = {
        query,
        page,
        next: resultValue.next,
        offers: resultValue.offers,
        filter: { ...filter },
        searched: true,
      };
      if (!resultValue.offers.length) {
        this.info(`No ${filter.buyOrders ? 'buy orders' : 'market offers'}${query ? ` for "${query}"` : ''}.`);
      }
    });
  }

  async loadMarketMine(): Promise<void> {
    const town = this.tradeTown;
    await this.guard('Market', async () => {
      const [bids, offers, buyOrders] = await Promise.all([
        this.marketApi.myBids(),
        this.marketApi.myOffers(),
        town ? this.marketApi.myBuyOrders(town.id) : Promise.resolve([]),
      ]);
      this.marketMine = { bids, offers, buyOrders };
    });
  }

  /**
   * Bids on a market offer, or on a buy order (you sell the item; at or below its instant price it sells at once).
   * Goods for sale: ≥ the buy-now price buys at once; cash first unless fromBank.
   */
  async bidMarket(offer: MarketOffer, amount: number, fromBank = false): Promise<void> {
    if (offer.sellerId && offer.sellerId === this.character.playerId) {
      return this.error('That is your own offer.');
    }
    if (!(amount > 0)) {
      return this.error('Enter an amount.');
    }
    const selling = offer.direction === 'BUY';
    if (selling && this.inventory.count(offer.itemId) < offer.count) {
      return this.error(
        `You need ${offer.count}× ${this.itemName(offer.itemId)} in your bag to sell into this buy order.`,
      );
    }
    // Like the web's bid dialog: going past the instant price only ever gets the instant price.
    if (offer.buyNow !== null && (selling ? amount < offer.buyNow : amount > offer.buyNow)) {
      amount = offer.buyNow;
    }
    await this.guard('Bid', async () => {
      const resultValue = await this.marketApi.bid(offer, amount, fromBank);
      this.applyMoney(resultValue);
      if (resultValue.changes.length) {
        this.inventory.applyChanges(resultValue.changes);
      }
      const name = this.itemName(offer.itemId);
      this.info(
        resultValue.instant
          ? selling
            ? `You sold ${name} for $ ${amount} (collect the money at ${offer.town.name}).`
            : `You have won ${name} (pick it up at ${offer.town.name}).`
          : `You have posted your bid of $ ${amount}.`,
      );
    });
    if (selling && this.items) {
      await this.refreshInventory();
    }
    await this.searchMarket(this.market.query, this.market.page);
  }

  private atTown(at: { x: number; y: number }): boolean {
    const positionValue = this.character.position;
    return positionValue.x === at.x && positionValue.y === at.y;
  }

  /** Picks up a finished offer's goods/money; you must stand in the market town. */
  async pickUpMarket(offer: MarketOffer): Promise<void> {
    if (!this.atTown(offer.town)) {
      return this.error(`Go to ${offer.town.name} to pick this up (w walks there).`);
    }
    await this.guard('Pick up', async () => {
      const resultValue = await this.marketApi.fetch(offer.id);
      this.applyMoney(resultValue);
      this.info('You have accepted the market delivery.');
    });
    await this.loadMarketMine();
    if (this.items) {
      await this.refreshInventory();
    }
  }

  /** Picks up everything finished at the market of the town you stand in. */
  async pickUpAllMarket(): Promise<void> {
    const town = this.townHere;
    if (!town) {
      return this.error('Stand in a town to pick up its market deliveries.');
    }
    await this.guard('Pick up', async () => {
      const resultValue = await this.marketApi.fetchAll(town.id);
      this.applyMoney(resultValue);
      this.info(`You have accepted the market deliveries at ${town.name ?? 'this town'}.`);
    });
    await this.loadMarketMine();
    if (this.items) {
      await this.refreshInventory();
    }
  }

  /** Withdraws one of your running sell offers or buy orders (in the market town, as the web asks for). */
  async withdrawMarket(offer: MarketOffer): Promise<void> {
    if (!this.atTown(offer.town)) {
      return this.error(`Go to ${offer.town.name} to withdraw this (w walks there).`);
    }
    await this.guard('Withdraw', async () => {
      const resultValue = await this.marketApi.withdraw(offer);
      if (resultValue.refund) {
        this.character.cash += resultValue.refund;
      }
      this.info(
        resultValue.refund
          ? `The offer was withdrawn; $ ${resultValue.refund} of fees were refunded to you.`
          : 'The offer was withdrawn; no fees were refunded to you.',
      );
    });
    await this.loadMarketMine();
    if (this.items) {
      await this.refreshInventory();
    }
  }

  /** Auctionable items whose name matches `query` (exact name first), for placing a buy order. */
  findAuctionable(query: string): { id: number; name: string }[] {
    const textValue = query.trim().toLowerCase();
    if (!textValue || !this.items) {
      return [];
    }
    const all = this.items
      .all()
      .filter((itemInfo) => itemInfo.auctionable && itemInfo.name.toLowerCase().includes(textValue));
    const exact = all.filter((itemInfo) => itemInfo.name.toLowerCase() === textValue);
    return (exact.length ? exact : all).map((itemInfo) => ({ id: itemInfo.id * 1000, name: itemInfo.name }));
  }

  /** Places a buy order at the trade town's market for an item by name. */
  async placeBuyOrder(options: {
    query: string;
    count: number;
    days: number;
    maxBid?: number | undefined;
    instant?: number | undefined;
    fromBank: boolean;
  }): Promise<boolean> {
    const town = this.tradeTown;
    if (!town) {
      this.error('You need to be in a town (or have a home town) to place a buy order.');
      return false;
    }
    const found = this.findAuctionable(options.query);
    if (found.length !== 1) {
      this.error(
        found.length
          ? `"${options.query}" matches ${found.length} items (${found
              .slice(0, 4)
              .map((value) => value.name)
              .join(', ')}${found.length > 4 ? ', …' : ''}); be more exact.`
          : `No market item is called "${options.query}".`,
      );
      return false;
    }
    const item = found[0];
    if (!item) {
      return false;
    }
    const problem = buyOrderProblem(options, this.items?.get(item.id)?.sell ?? 0);
    if (problem) {
      this.error(problem);
      return false;
    }
    const ok = await this.guard('Buy order', async () => {
      const resultValue = await this.marketApi.buyOrder({ ...options, townId: town.id, itemId: item.id });
      this.applyMoney(resultValue);
      this.info(
        `Buy order for ${options.count > 1 ? `${options.count}× ` : ''}${item.name} placed at ${town.name}; the fee is $ ${resultValue.fee}`,
      );
      return true;
    });
    if (ok) {
      await this.loadMarketMine();
    }
    return !!ok;
  }

  async sellOnMarket(options: {
    itemId: number;
    count: number;
    days: number;
    startPrice?: number | undefined;
    buyNow?: number | undefined;
  }): Promise<boolean> {
    const town = this.tradeTown;
    if (!town) {
      this.error('You need to be in a town (or have a home town) to sell on the market.');
      return false;
    }
    const ok = await this.guard('Market offer', async () => {
      const resultValue = await this.marketApi.sell({ ...options, townId: town.id });
      this.applyMoney(resultValue);
      this.info(`The goods are offered for sale; the fee is $ ${resultValue.fee}`);
      return true;
    });
    if (ok && this.items) {
      await this.refreshInventory();
    }
    return !!ok;
  }

  /** Walks to a town given by coordinates (market towns are only known by position). */
  walkToTownAt(at: { x: number; y: number }, name: string): Promise<boolean> {
    const townInfo = this.townAt(at);
    if (!townInfo) {
      this.error(`No known town at ${at.x},${at.y}`);
      return Promise.resolve(false);
    }
    return this.addTask('Walk', walkPost(townInfo.id, 'town'), `Walking to ${name || townInfo.name}`);
  }

  // ---- duels --------------------------------------------------------------------------------

  private get duelApi(): DuelApi {
    return new DuelApi(this.client);
  }

  async loadDuels(): Promise<void> {
    await this.guard('Duels', async () => {
      this.duels = await this.duelApi.data();
      this.duelOpponents = (await this.duelApi.opponents()).opponents;
    });
  }

  async fightNpc(npcId: number): Promise<void> {
    const npc = this.duels?.npcs.find((npcN) => npcN.id === npcId);
    const before = { xp: this.character.experience, energy: this.character.energy };
    await this.guard('NPC duel', async () => {
      const resultValue = await this.duelApi.fightNpc(npcId);
      // Kept for the autopilot: which NPC levels you beat and what a duel pays / costs.
      if (npc) {
        const rec = {
          at: this.clock.now(),
          level: npc.level,
          won: !resultValue.died && !/lost|defeat/i.test(resultValue.result),
          xp: Math.max(0, (resultValue.experience ?? before.xp) - before.xp),
          energy: Math.max(0, before.energy - (resultValue.energy ?? before.energy)),
        };
        this.updateAutopilot((autopilotFile) => (autopilotFile.duels = [...autopilotFile.duels, rec].slice(-200)));
      }
      this.lastNpcDuel = resultValue;
      this.duels = resultValue.data;
      const character = this.character;
      if (resultValue.energy !== undefined) {
        character.setEnergy(Math.floor(resultValue.energy));
      }
      if (resultValue.health !== undefined) {
        character.setHealth(Math.floor(resultValue.health));
      }
      if (resultValue.money !== undefined) {
        character.cash = resultValue.money;
      }
      if (resultValue.experience !== undefined) {
        character.experience = resultValue.experience;
      }
      if (resultValue.level !== undefined) {
        character.level = resultValue.level;
      }
      this.info(
        `NPC duel: ${resultValue.result || 'done'}${resultValue.died ? ' (you passed out and wake up in your home town)' : ''}`,
      );
    });
    if (this.lastNpcDuel?.died) {
      await this.reload();
    }
  }

  /** Queues a duel against a player (TaskDuel). */
  duelPlayer(opponent: DuelOpponent): Promise<boolean> {
    return this.addTask('Duel', duelPost(opponent.playerId), `Duel against ${opponent.name} queued`);
  }
}
