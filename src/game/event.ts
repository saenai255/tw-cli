// Seasonal event data from Game.init (`sesData` counter/rewards + `ceData` event name/end) and the
// cooldown-driven event generator items (Flower pot etc., usetype 'use').
import { entries, isObj, type JsonObject, obj, objs, vals } from '../util/json.ts';
import type { Inventory } from './inventory.ts';
import type { ItemCatalog, ItemDef } from './items.ts';

export interface EventReward {
  at: number;
  id: string | number | null;
  text: string;
}

export interface ActiveEvent {
  id: string;
  /** Raw `sesData` key (e.g. "DayOfDead"), used by the friendsbar requests. */
  apiKey: string;
  name: string;
  /** Personal counter value (`sesData.<event>.counter.value`). */
  points: number;
  /** Counter key, e.g. "ses:dayofdead_collected", for live SesStatChanged updates. */
  counterKey: string;
  rewards: EventReward[];
  next: EventReward | null;
  /** The game's formatted end date, kept as text (server timezone). */
  ends: string | null;
  /** Friend points from `sesData.<event>.friendsbar`; null when the event has none. */
  friendsbar: { cooldown: number; label: string } | null;
  /** Community reward thresholds from `ceData.<id>.event_stages`. */
  communityRewards: EventReward[];
  /** Community progress (`ceData.<id>.event_progress`). */
  communityPoints: number;
}

/** One friend in the friendsbar search, with the last event point sent (server seconds). */
export interface EventFriend {
  playerId: number;
  name: string;
  level: number;
  activationAt: number | null;
}

export interface EventItem {
  itemId: number;
  name: string;
  /** Event currency amount from usebonus, e.g. 1250 Cempasúchil. */
  amount: number;
  currency: string;
}

const prettifyEventKey = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

const nextReward = (rewards: EventReward[], points: number): EventReward | null =>
  rewards.find((reward) => reward.at > points) ?? null;

const rewardId = (value: unknown): string | number | null =>
  typeof value === 'string' || typeof value === 'number' ? value : null;

/** `ceData.<id>.event_stages`: an object keyed by threshold (or an array of `{price}` groups). */
function parseCommunityRewards(eventInfo: JsonObject): EventReward[] {
  const out: EventReward[] = [];
  const add = (atValue: unknown, value: unknown): void => {
    const at = Number(atValue) || 0;
    if (at <= 0) {
      return;
    }
    const list = Array.isArray(value) ? objs(value) : isObj(value) ? [value] : [];
    const texts = list.map((reward) => String(reward.text ?? reward.reward ?? '')).filter(Boolean);
    const withId = list.find((reward) => reward.reward_id !== undefined || reward.id !== undefined);
    out.push({ at, id: rewardId(withId?.reward_id ?? withId?.id), text: texts.join(' · ') });
  };
  const stages = eventInfo.event_stages;
  if (Array.isArray(stages)) {
    for (const value of stages) {
      const stage = obj(value);
      add(stage.price ?? stage.at ?? stage.threshold, stage.rewards ?? stage);
    }
  } else {
    for (const [at, value] of entries(obj(stages))) {
      add(at, value);
    }
  }
  return out.filter((reward) => reward.text).sort((first, second) => first.at - second.at);
}

/** The active seasonal event, preferring the entry that has a personal counter. */
export function parseActiveEvent(game: JsonObject | null | undefined): ActiveEvent | null {
  const candidates = entries(obj(game?.sesData)).filter((entry): entry is [string, JsonObject] => isObj(entry[1]));
  if (candidates.length === 0) {
    return null;
  }
  const chosen = candidates.find(([, value]) => Number.isFinite(Number(obj(value.counter).value))) ?? candidates[0];
  if (!chosen) {
    return null;
  }
  const [key, data] = chosen;
  const counter = obj(data.counter);
  const id = String(data.event_id ?? key).toLowerCase();
  const ceData = obj(game?.ceData);
  const directEvent = obj(ceData[id]);
  const eventInfo =
    Object.keys(directEvent).length > 0
      ? directEvent
      : obj(vals(ceData).find((value) => String(obj(value).event_id ?? '').toLowerCase() === id));
  const rewards = entries(obj(data.rewards))
    .map(([at, value]) => {
      const reward = obj(value);
      return { at: Number(at) || 0, id: rewardId(reward.id), text: String(reward.desc ?? '') };
    })
    .filter((reward) => reward.at > 0)
    .sort((first, second) => first.at - second.at);
  const points = Number(counter.value) || 0;
  const friendsbarInfo = obj(data.friendsbar);
  const friendsbarCooldown = Number(friendsbarInfo.cooldown);
  return {
    id,
    apiKey: key,
    name: String(eventInfo.event_name ?? eventInfo.name ?? prettifyEventKey(key)),
    points,
    counterKey: String(counter.key ?? ''),
    rewards,
    next: nextReward(rewards, points),
    ends: data.meta ? String(obj(data.meta).end ?? '') || null : null,
    friendsbar: Object.keys(friendsbarInfo).length
      ? {
          cooldown: Number.isFinite(friendsbarCooldown) ? friendsbarCooldown : 0,
          label: String(friendsbarInfo.label ?? 'Send event points'),
        }
      : null,
    communityRewards: parseCommunityRewards(eventInfo),
    communityPoints: Number(eventInfo.event_progress) || 0,
  };
}

/** Apply a live SesStatChanged value without rebuilding the whole event. */
export function withEventPoints(event: ActiveEvent, points: number): ActiveEvent {
  return { ...event, points, next: nextReward(event.rewards, points) };
}

/** `friendsbar/search {search_type:'friends'}` → friends and their last event-point activation. */
export function parseEventFriends(json: JsonObject, event: ActiveEvent): EventFriend[] {
  const activations = new Map<number, number>();
  for (const value of objs(json.eventActivations)) {
    if (String(value.event_name ?? '').toLowerCase() !== event.id.toLowerCase()) {
      continue;
    }
    const playerId = Number(value.friend_id);
    const at = Number(value.activation_time);
    if (Number.isFinite(playerId) && Number.isFinite(at) && at > 0) {
      activations.set(playerId, at);
    }
  }
  return objs(json.players)
    .map((player) => {
      const playerId = Number(player.player_id);
      return {
        playerId,
        name: String(player.name ?? '?'),
        level: Number(player.level) || 0,
        activationAt: activations.get(playerId) ?? null,
      };
    })
    .filter((friend) => friend.playerId > 0);
}

/** Whether a friend can receive event points now (never sent, or the cooldown has passed). */
export function eventFriendAvailable(friend: EventFriend, cooldown: number, now: number): boolean {
  return !friend.activationAt || friend.activationAt + cooldown <= now;
}

/** Event generator items: "Generates 1250 flowers for the … event … once every 11.5 hours". */
function eventGenerator(definition: ItemDef | undefined): { amount: number; currency: string } | null {
  if (
    !definition ||
    definition.usetype === 'none' ||
    !/Generates\s+[\d.,]+\s+.+?\s+for the\s+.+?\s+event/i.test(definition.description ?? '')
  ) {
    return null;
  }
  const raw = definition.usebonus[0] ?? '';
  const match = raw.match(/^([\d.,]+)\s*(.*)$/);
  return {
    amount: match ? Number(match[1]?.replace(/[.,]/g, '')) || 0 : 0,
    currency: (match?.[2] ?? '').trim(),
  };
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\b20\d\d\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function belongsToEvent(definition: ItemDef, event: ActiveEvent): boolean {
  const eventName = normalize(event.name);
  const description = normalize(definition.description ?? '');
  if (eventName && description.includes(eventName)) {
    return true;
  }
  return event.id.length > 4 && description.includes(normalize(event.id));
}

/** Event generator items in the bag whose cooldown is over and whose lifetime has not expired. */
export function eventReadyItems(
  inventory: Inventory,
  catalog: ItemCatalog | null,
  event: ActiveEvent | null,
  now: number,
): EventItem[] {
  if (!event) {
    return [];
  }
  const ready: EventItem[] = [];
  for (const bagItem of inventory.items()) {
    const definition = catalog?.get(bagItem.itemId);
    const generator = eventGenerator(definition);
    if (!definition || !generator || !belongsToEvent(definition, event)) {
      continue;
    }
    const lifetime = inventory.itemLifetime.get(bagItem.itemId);
    if (lifetime !== undefined && lifetime <= 0) {
      continue;
    }
    const cooldown = inventory.itemCooldown.get(bagItem.itemId);
    if (cooldown !== undefined && cooldown > now) {
      continue;
    }
    ready.push({
      itemId: bagItem.itemId,
      name: definition.name,
      amount: generator.amount,
      currency: generator.currency,
    });
  }
  return ready;
}
