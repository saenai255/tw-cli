// Seasonal event data from Game.init (`sesData` counter/rewards + `ceData` event name/end) and the
// cooldown-driven event generator items (Flower pot etc., usetype 'use').
import { entries, isObj, type JsonObject, obj, vals } from '../util/json.ts';
import type { Inventory } from './inventory.ts';
import type { ItemCatalog, ItemDef } from './items.ts';

export interface EventReward {
  at: number;
  id: string | number | null;
  text: string;
}

export interface ActiveEvent {
  id: string;
  name: string;
  /** Personal counter value (`sesData.<event>.counter.value`). */
  points: number;
  /** Counter key, e.g. "ses:dayofdead_collected", for live SesStatChanged updates. */
  counterKey: string;
  rewards: EventReward[];
  next: EventReward | null;
  /** The game's formatted end date, kept as text (server timezone). */
  ends: string | null;
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
  return {
    id,
    name: String(eventInfo.event_name ?? eventInfo.name ?? prettifyEventKey(key)),
    points,
    counterKey: String(counter.key ?? ''),
    rewards,
    next: nextReward(rewards, points),
    ends: data.meta ? String(obj(data.meta).end ?? '') || null : null,
  };
}

/** Apply a live SesStatChanged value without rebuilding the whole event. */
export function withEventPoints(event: ActiveEvent, points: number): ActiveEvent {
  return { ...event, points, next: nextReward(event.rewards, points) };
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
