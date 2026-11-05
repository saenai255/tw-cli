// Seasonal events (SES) and community events, as west.events.Manager runs them (tw2game @914000):
//   game.php Game.init: sesData {<EventId>: {meta:{start?, end}, counter:{key:'ses:<stat>', value}, rewards:
//     {<collected>: {id: item id | 'wof-unlock' | 'avatar-part-N', desc}}, friendsbar:{label, cooldown s}, premium}}
//     and ceData {<id>: {event_name, event_end, event_progress, event_stages:{<points>:[{reward, reward_id, text}]}}}.
//   Dates are "dd.mm.yyyy hh:mm[:ss]" in server time (Europe/Berlin: DayOfDead's end 16.11.2026 12:00 matches the
//     wheel's endDate 1794826800 = 11:00 UTC).
//   Live: chat Response.SesStatChanged {<stat>: value} → 'ses:<stat>' (the counter); CommEventChanged {event_id,
//     event_stage}.
//   Friends (FriendsBar @196400): friendsbar/search (mode) {search_type:'friends'} → {players:[{player_id, name,
//     townname, …}], eventActivations:[{friend_id, event_name, activation_time}]}; friendsbar/event {player_id, event}
//     and event_all {event} → {error, msg, activationTime?}. One gift per friend per `cooldown`.
//   Currency log: ses/log (mode) {ses_id, page, limit:25} → {entries:[{date, type, value, description, details}],
//     page, hasNext}; wofPay values are spent (negative).
//   Wheels: game.php west.wof.WofManager.init([{id, type, name, title, free, endDate}]); the Day of the Dead one is
//     the Loteria card game (west.window.events.day_of_the_dead.wof @534431): wheeloffortune/init (mode) {wofid} →
//     {mode:{game:{free_games, status, current:{stage, bribe_cost, change_reward_cost}}, stages:[{rewards, card}],
//     cost, currencies, conversion}, prizes:{gamblePrizes}}; wheeloffortune/gamble {action, wofid, …} → {game,
//     stages, nuggets?}. Actions: open {currency_id} (paid unless free), gamble {card}, continue (risks the
//     current reward), bribe {currency_id:2} after a loss, change {currency_id} on the last stage, end (collect).
import type { FormValue } from '../http/form.ts';
import type { GameClient } from '../http/game-client.ts';
import { arr, entries, isObj, type JsonObject, obj, objs } from '../util/json.ts';
import { plainText } from './quests.ts';

export interface Milestone {
  /** Currency collected that unlocks it. */
  at: number;
  /** Item id, or null for unlocks such as 'wof-unlock' and avatar parts. */
  itemId: number | null;
  text: string;
}

export interface SeasonalEvent {
  id: string;
  currency: string;
  startsAt: number | null;
  endsAt: number | null;
  /** SesStatChanged key that carries the counter ('dayofdead_collected'). */
  counterStat: string | null;
  collected: number;
  milestones: Milestone[];
  gift: { label: string; cooldown: number } | null;
}

export interface CommunityStage {
  at: number;
  rewards: string[];
}

export interface CommunityEvent {
  id: string;
  name: string;
  endsAt: number | null;
  progress: number;
  stages: CommunityStage[];
}

export interface Wheel {
  id: number;
  type: string;
  title: string;
  free: number;
  endsAt: number;
}

export interface Friend {
  playerId: number;
  name: string;
  town: string;
}

/** Last gift time per friend and event (epoch s). */
export type GiftActivations = Map<number, Map<string, number>>;

export interface LogEntry {
  at: number;
  type: string;
  value: number;
  text: string;
}

export interface LogPage {
  entries: LogEntry[];
  page: number;
  hasNext: boolean;
}

export type CardGameStatus = 'closed' | 'running' | 'won' | 'lost' | 'bribed';

export interface PayOption {
  currencyId: number;
  name: string;
  price: number;
}

export interface CardGame {
  status: CardGameStatus;
  freeGames: number;
  stage: number;
  /** What the current stage pays when collected (item names). */
  reward: string[];
  /** Stage reward pools, index 0 = stage 1. */
  pools: string[][];
  start: PayOption[];
  bribe: PayOption[];
  change: PayOption[];
}

export const CARD_GAME_STAGES = 5;
export const CARD_GAME_CARDS = 3;

/** Currency names from each event class's l10n (only Day of the Dead's is in the current bundle). */
const CURRENCY: Record<string, string> = { DayOfDead: 'Cempasúchil' };

/** west.gui.payOption ids (WheelofFortune.getPayOptionType). */
const PAY_TYPES: Record<number, string> = { 1: 'bonds', 2: 'nuggets', 4: 'dollars', 8: 'veteran points', 16: 'SES' };
/** mode.conversion keys (getPayOptionType(id).toLowerCase()). */
const CONVERSION_KEY: Record<number, string> = { 1: 'bond', 2: 'nugget', 4: 'dollar', 8: 'veteran', 16: 'ses' };

const SERVER_TIME_ZONE = 'Europe/Berlin';

/** "dd.mm.yyyy hh:mm[:ss]" in server time → epoch s; null when it does not parse. */
export function parseServerDate(text: unknown): number | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(text ?? '').trim());
  if (!match) {
    return null;
  }
  const [, day, month, year, hour = '0', minute = '0', second = '0'] = match;
  const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Math.round((asUtc - zoneOffsetMs(asUtc)) / 1000);
}

/** How far SERVER_TIME_ZONE's wall clock is ahead of UTC at this instant. */
function zoneOffsetMs(epochMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SERVER_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(epochMs));
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wall - epochMs;
}

const itemIdOf = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function parseSeasonalEvents(game: JsonObject | null): SeasonalEvent[] {
  return entries(obj(game?.sesData)).flatMap(([id, value]) => {
    if (!isObj(value)) {
      return [];
    }
    const meta = obj(value.meta);
    const counter = obj(value.counter);
    const key = String(counter.key ?? '');
    const friendsbar = obj(value.friendsbar);
    const milestones = entries(obj(value.rewards))
      .map(([at, reward]) => ({
        at: Number(at),
        itemId: itemIdOf(obj(reward).id),
        text: plainText(obj(reward).desc ?? ''),
      }))
      .filter((milestone) => Number.isFinite(milestone.at))
      .sort((first, second) => first.at - second.at);
    return [
      {
        id,
        currency: CURRENCY[id] ?? id,
        startsAt: parseServerDate(meta.start),
        endsAt: parseServerDate(meta.end),
        counterStat: key.startsWith('ses:') ? key.slice(4) : null,
        collected: Number(counter.value) || 0,
        milestones,
        gift: friendsbar.label
          ? { label: plainText(friendsbar.label), cooldown: Number(friendsbar.cooldown) || 0 }
          : null,
      },
    ];
  });
}

export function parseCommunityEvents(game: JsonObject | null): CommunityEvent[] {
  return entries(obj(game?.ceData)).flatMap(([id, value]) => {
    if (!isObj(value)) {
      return [];
    }
    const stages = entries(obj(value.event_stages))
      .map(([at, rewards]) => ({
        at: Number(at),
        rewards: objs(rewards).map((reward) => plainText(reward.text ?? reward.reward ?? '')),
      }))
      .filter((stage) => Number.isFinite(stage.at))
      .sort((first, second) => first.at - second.at);
    return [
      {
        id,
        name: plainText(value.event_name ?? id),
        endsAt: parseServerDate(value.event_end),
        progress: Number(value.event_progress) || 0,
        stages,
      },
    ];
  });
}

/** The WofManager.init list. */
export function parseWheels(list: unknown): Wheel[] {
  return objs(list).map((wheel) => ({
    id: Number(wheel.id) || 0,
    type: String(wheel.type ?? ''),
    title: plainText(wheel.title ?? wheel.name ?? ''),
    free: Number(wheel.free) || 0,
    endsAt: Number(wheel.endDate) || 0,
  }));
}

/** Running at `now` (epoch s): started (or no start) and not ended. */
export const isRunning = (event: { startsAt?: number | null; endsAt: number | null }, now: number): boolean =>
  (event.startsAt ?? 0) <= now && (event.endsAt === null || event.endsAt > now);

export const nextMilestone = (event: SeasonalEvent): Milestone | null =>
  event.milestones.find((milestone) => milestone.at > event.collected) ?? null;

export const nextCommunityStage = (event: CommunityEvent): CommunityStage | null =>
  event.stages.find((stage) => stage.at > event.progress) ?? null;

/** Friends whose cooldown for this event is over (FriendsBar.searchEventActivations). */
export function giftableFriends(
  friends: readonly Friend[],
  activations: GiftActivations,
  event: SeasonalEvent,
  now: number,
): Friend[] {
  const cooldown = event.gift?.cooldown ?? 0;
  return friends.filter((friend) => {
    const last = activations.get(friend.playerId)?.get(event.id) ?? 0;
    return last + cooldown <= now;
  });
}

/** When the next friend can get a gift again (epoch s), or null with no friends. */
export function nextGiftAt(
  friends: readonly Friend[],
  activations: GiftActivations,
  event: SeasonalEvent,
): number | null {
  const cooldown = event.gift?.cooldown ?? 0;
  const times = friends.map((friend) => (activations.get(friend.playerId)?.get(event.id) ?? 0) + cooldown);
  return times.length ? Math.min(...times) : null;
}

export function parseFriends(json: JsonObject): { friends: Friend[]; activations: GiftActivations } {
  const friends = objs(json.players).map((player) => ({
    playerId: Number(player.player_id) || 0,
    name: plainText(player.name ?? ''),
    town: plainText(player.townname ?? ''),
  }));
  const activations: GiftActivations = new Map();
  for (const activation of objs(json.eventActivations)) {
    const friendId = Number(activation.friend_id);
    const byEvent = activations.get(friendId) ?? new Map<string, number>();
    byEvent.set(String(activation.event_name), Number(activation.activation_time) || 0);
    activations.set(friendId, byEvent);
  }
  return { friends, activations };
}

export function parseLogPage(json: JsonObject): LogPage {
  return {
    entries: objs(json.entries).map((entry) => {
      const value = Number(entry.value) || 0;
      return {
        at: Number(entry.date) || 0,
        type: String(entry.type ?? ''),
        value:
          entry.type === 'wofPay' ? -value : entry.type === 'adminDrop' && entry.details === 'deduct' ? -value : value,
        text: plainText(entry.description ?? ''),
      };
    }),
    page: Number(json.page) || 1,
    hasNext: !!json.hasNext,
  };
}

/** A reward as the server sends it: an item id, {item_id | itemId | id, count?}, or a list of those. */
export function rewardNames(value: unknown, itemName: (id: number) => string): string[] {
  if (Array.isArray(value)) {
    return arr(value).flatMap((part) => rewardNames(part, itemName));
  }
  if (isObj(value)) {
    const id = itemIdOf(value.item_id ?? value.itemId ?? value.id);
    const count = Number(value.count ?? value.amount) || 1;
    if (id === null) {
      return value.name ? [plainText(value.name)] : [];
    }
    return [`${itemName(id)}${count > 1 ? ` ×${count}` : ''}`];
  }
  const id = itemIdOf(value);
  return id === null ? [] : [itemName(id)];
}

const STATUSES: CardGameStatus[] = ['closed', 'running', 'won', 'lost', 'bribed'];

/** Prices keyed by pay id ({"2": 10}) or currency word ({nuggets: 10}). */
function payOptions(prices: unknown): PayOption[] {
  return entries(obj(prices)).flatMap(([key, price]) => {
    const byName = Object.entries(PAY_TYPES).find(([, name]) => name === key || name.startsWith(key));
    const currencyId = Number(key) || Number(byName?.[0]) || 0;
    if (!currencyId) {
      return [];
    }
    return [{ currencyId, name: PAY_TYPES[currencyId] ?? key, price: Math.ceil(Number(price)) }];
  });
}

/**
 * Card game state from wheeloffortune/init (whole reply) merged with a later gamble reply ({game, stages}).
 * Unverified: reward and price shapes (only the client code was read; check against a live reply).
 */
export function parseCardGame(
  init: JsonObject,
  update: JsonObject | null,
  itemName: (id: number) => string,
  currencyName = 'SES',
): CardGame {
  const mode = obj(init.mode);
  const game = { ...obj(mode.game), ...obj(update?.game) };
  const current = obj(game.current);
  const stages = update?.stages !== undefined ? arr(update.stages) : arr(mode.stages);
  const stage = Number(current.stage) || 1;
  const status = STATUSES.find((candidate) => candidate === game.status) ?? 'closed';
  const conversion = obj(mode.conversion);
  const startPrice = Number(obj(mode.cost).main) || 0;
  const startIds = arr(obj(mode.currencies).main).map(Number);
  const named = (option: PayOption): PayOption =>
    option.currencyId === 16 ? { ...option, name: currencyName } : option;
  /** Pools by stage id (getRewardsForStage(stage_id), 1-based). */
  const gamblePrizes = obj(init.prizes).gamblePrizes;
  const poolOf = (stageId: number) =>
    rewardNames(Array.isArray(gamblePrizes) ? gamblePrizes[stageId] : obj(gamblePrizes)[String(stageId)], itemName);
  return {
    status,
    freeGames: Number(game.free_games) || 0,
    stage,
    reward: rewardNames(obj(stages[stage - 1]).rewards, itemName),
    pools: Array.from({ length: CARD_GAME_STAGES }, (_unused, index) => poolOf(index + 1)),
    start: startIds
      .filter((currencyId) => PAY_TYPES[currencyId])
      .map((currencyId) =>
        named({
          currencyId,
          name: PAY_TYPES[currencyId] ?? '',
          price: Math.ceil(startPrice * (Number(conversion[CONVERSION_KEY[currencyId] ?? '']) || 1)),
        }),
      ),
    bribe: payOptions(current.bribe_cost).map(named),
    change: payOptions(current.change_reward_cost).map(named),
  };
}

/** What can be done next in the card game. */
export function cardGameActions(game: CardGame): {
  start: boolean;
  pick: boolean;
  next: boolean;
  collect: boolean;
  bribe: boolean;
  change: boolean;
} {
  const played = game.status === 'won' || game.status === 'lost' || game.status === 'bribed';
  const success = game.status === 'won' || game.status === 'bribed';
  const last = game.stage >= CARD_GAME_STAGES;
  return {
    start: game.status === 'closed',
    pick: game.status === 'running',
    next: success && !last,
    collect: played,
    bribe: game.status === 'lost',
    change: success && last,
  };
}

export class EventApi {
  private client: GameClient;

  constructor(client: GameClient) {
    this.client = client;
  }

  async friends(): Promise<ReturnType<typeof parseFriends>> {
    const json = await this.client.remoteCallMode('friendsbar', 'search', { search_type: 'friends' });
    failOn(json, 'Friends list');
    return parseFriends(json);
  }

  /** Sends the event currency to every friend whose cooldown is over; the server's message. */
  async giftAll(eventId: string): Promise<string> {
    const json = await this.client.remoteCall('friendsbar', 'event_all', { event: eventId });
    failOn(json, 'Sending to friends');
    return plainText(json.msg ?? 'Sent.');
  }

  async log(eventId: string, page = 1): Promise<LogPage> {
    const json = await this.client.remoteCallMode('ses', 'log', { ses_id: eventId, page, limit: 25 });
    failOn(json, 'Event log');
    return parseLogPage(json);
  }

  async wheel(wheelId: number): Promise<JsonObject> {
    const json = await this.client.remoteCallMode('wheeloffortune', 'init', { wofid: wheelId });
    failOn(json, 'Loteria');
    return json;
  }

  async gamble(wheelId: number, action: string, data: Record<string, FormValue> = {}): Promise<JsonObject> {
    const json = await this.client.remoteCall('wheeloffortune', 'gamble', { ...data, action, wofid: wheelId });
    failOn(json, 'Loteria');
    return json;
  }
}

function failOn(json: JsonObject, what: string): void {
  if (json.error) {
    throw new Error(plainText(json.msg ?? (typeof json.error === 'string' ? json.error : `${what} failed`)));
  }
}

/** Loteria (or another wheel the TUI can play): the init reply and the state after the last action. */
export interface CardGameSession {
  wheel: Wheel;
  init: JsonObject;
  game: CardGame;
}

/** The type of wheel the TUI plays (the Day of the Dead card game); other wheels stay in the browser. */
export const CARD_GAME_WHEEL = 'dayofdeadwof';

/** Everything event-related GameState keeps: what game.php said, live counters, friends, log, card game. */
export class EventBoard {
  seasonal: SeasonalEvent[] = [];
  community: CommunityEvent[] = [];
  wheels: Wheel[] = [];
  friends: Friend[] | null = null;
  activations: GiftActivations = new Map();
  /** When the friends list was read (ms). */
  friendsAt = 0;
  log: (LogPage & { eventId: string }) | null = null;
  cardGame: CardGameSession | null = null;

  static fromBootstrap(game: JsonObject | null, wheels: unknown): EventBoard {
    const board = new EventBoard();
    board.seasonal = parseSeasonalEvents(game);
    board.community = parseCommunityEvents(game);
    board.wheels = parseWheels(wheels);
    return board;
  }

  running(now: number): SeasonalEvent[] {
    return this.seasonal.filter((event) => isRunning(event, now));
  }

  runningCommunity(now: number): CommunityEvent[] {
    return this.community.filter((event) => isRunning(event, now));
  }

  /** The Loteria while it runs. */
  cardGameWheel(now: number): Wheel | null {
    return this.wheels.find((wheel) => wheel.type === CARD_GAME_WHEEL && wheel.endsAt > now) ?? null;
  }

  /** Running events with a friend gift and the friends who can get it now (empty before the list is read). */
  giftsDue(now: number): { event: SeasonalEvent; friends: Friend[] }[] {
    return this.running(now)
      .filter((event) => event.gift)
      .map((event) => ({ event, friends: giftableFriends(this.friends ?? [], this.activations, event, now) }));
  }

  setFriends(list: ReturnType<typeof parseFriends>, atMs: number): void {
    this.friends = list.friends;
    this.activations = list.activations;
    this.friendsAt = atMs;
  }

  /** Applies a SesStatChanged push; returns the milestones it crossed, per event. */
  applyStats(stats: Record<string, number>): { event: SeasonalEvent; reached: Milestone[] }[] {
    return this.seasonal.flatMap((event) => {
      const value = event.counterStat ? stats[event.counterStat] : undefined;
      if (value === undefined) {
        return [];
      }
      const before = event.collected;
      event.collected = value;
      const reached = event.milestones.filter((milestone) => milestone.at > before && milestone.at <= value);
      return [{ event, reached }];
    });
  }
}
