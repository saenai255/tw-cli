// Bag + worn items.
// Initial: game.php Bag.init({bag:{<type>:[{count,item_id,inv_id,type}]}, wear:[item ids], setItems, ...}).
// Changes (Bag.handleChanges @661624): [{item_id, count, inv_id, type}] with the NEW total count;
// count 0 removes the item. Requests (Wear @1173660-1174600, Bag @657892):
//   inventory/carry   {item_id, last_inv_id} → {changes, wearSets, workPointBonus, bonus, speed, error, message}
//   inventory/uncarry {last_inv_id, type}     → same
//   inventory/inventory_changed {inv_id}      → {changes|false, wear:{slot:item_id|null}}
//   inventory/show_equip (mode)               → {data:[{equip_manager_id, name, head, neck, …}], max, premium_max, hasPremium, price}
//   inventory/switch_equip {id, last_inv_id}  → {changes, wear:[item ids], setItems, workPointBonus, speed, weapon}
//   inventory/save_equip {name}               → {error?, data:<the new set>}
//   inventory/replace_equip {id}              → {error?} (the set now holds the current wear)
import type { GameClient } from '../http/game-client.ts';
import { arr, entries, isObj, type JsonObject, obj, objs, vals } from '../util/json.ts';
import { baseId, type ItemCatalog, WEAR_SLOTS } from './items.ts';

export interface BagItem {
  itemId: number;
  count: number;
  invId: number;
  type: string;
}

export interface ClothChange {
  /** Raw bag rows, for Inventory.applyChanges. */
  changes: unknown[];
  speed?: number | undefined;
  workPointBonus?: unknown;
  error?: string | undefined;
}

/** A saved equipment set: item id per wear slot (null when the slot is empty). */
export interface EquipSet {
  id: number;
  name: string;
  slots: Record<string, number | null>;
}

export interface EquipSets {
  sets: EquipSet[];
  max: number;
  premiumMax: number;
  hasPremium: boolean;
  price: number;
}

export interface SwitchEquipResult extends ClothChange {
  /** All worn item ids after the switch. */
  wear: number[];
  /** Base ids of the set's items (WearSet.setItems). */
  setItems: number[];
}

const toBagItem = (jsonValue: JsonObject): BagItem => ({
  itemId: Number(jsonValue.item_id),
  count: Number(jsonValue.count) || 0,
  invId: Number(jsonValue.inv_id) || 0,
  type: String(jsonValue.type ?? ''),
});

function parseEquipSet(jsonValue: JsonObject): EquipSet {
  const slots: Record<string, number | null> = {};
  for (const slot of WEAR_SLOTS) {
    const id = Number(jsonValue[slot]);
    slots[slot] = id > 0 ? id : null;
  }
  return {
    id: Number(jsonValue.equip_manager_id) || 0,
    name: String(jsonValue.name ?? 'Set'),
    slots,
  };
}

export class Inventory {
  /** item_id → bag entry */
  bag = new Map<number, BagItem>();
  /** slot → item_id */
  wear = new Map<string, number>();
  /** item_id → epoch seconds when it can be used again (Bag.itemCooldown). */
  itemCooldown = new Map<number, number>();
  /** item_id → remaining lifetime in seconds (Bag.itemLifetime); absent when it does not expire. */
  itemLifetime = new Map<number, number>();
  lastInvId = 0;

  static fromInit(bagInit: JsonObject | null | undefined, catalog?: ItemCatalog): Inventory {
    const inventory = new Inventory();
    for (const list of vals(bagInit?.bag)) {
      for (const jsonValue of objs(list)) {
        inventory.put(toBagItem(jsonValue));
      }
    }
    for (const id of arr(bagInit?.wear).map(Number)) {
      const type = catalog?.get(id)?.type;
      if (type) {
        inventory.wear.set(type, Number(id));
      } else {
        inventory.wear.set(`#${id}`, Number(id)); // type unknown until items load; fixed by retype()
      }
    }
    inventory.setItemMeta(bagInit?.itemCooldown, bagInit?.itemLifetime);
    return inventory;
  }

  /** Replaces the item cooldown / lifetime maps from Bag.init (or a fresh game.php sync). */
  setItemMeta(cooldown: unknown, lifetime: unknown): void {
    this.itemCooldown.clear();
    for (const [id, at] of entries(obj(cooldown))) {
      const timestamp = Number(at);
      if (Number.isFinite(timestamp) && timestamp > 0) {
        this.itemCooldown.set(Number(id), timestamp);
      }
    }
    this.itemLifetime.clear();
    for (const [id, seconds] of entries(obj(lifetime))) {
      const remaining = Number(seconds);
      if (Number.isFinite(remaining)) {
        this.itemLifetime.set(Number(id), remaining);
      }
    }
  }

  /** Puts worn items under their slot once the item catalog is available. */
  retype(catalog: ItemCatalog): void {
    for (const [slot, id] of [...this.wear]) {
      if (!slot.startsWith('#')) {
        continue;
      }
      const type = catalog.get(id)?.type;
      if (type) {
        this.wear.delete(slot);
        this.wear.set(type, id);
      }
    }
  }

  private put(item: BagItem): void {
    this.bag.set(item.itemId, item);
    if (item.invId > this.lastInvId) {
      this.lastInvId = item.invId;
    }
  }

  applyChanges(changes: unknown): void {
    for (const jsonValue of objs(changes)) {
      const candidate = toBagItem(jsonValue);
      if (candidate.count <= 0) {
        this.bag.delete(candidate.itemId);
      } else {
        this.put({
          ...this.bag.get(candidate.itemId),
          ...candidate,
          type: candidate.type || this.bag.get(candidate.itemId)?.type || '',
        });
      }
      if (candidate.invId > this.lastInvId) {
        this.lastInvId = candidate.invId;
      }
    }
  }

  applyWear(wear: unknown): void {
    if (!wear || typeof wear !== 'object') {
      return;
    }
    for (const slot of WEAR_SLOTS) {
      if (!(slot in wear)) {
        continue;
      }
      const id = (wear as Record<string, unknown>)[slot];
      if (id === null || id === undefined || id === 0) {
        this.wear.delete(slot);
      } else {
        this.wear.set(slot, Number(id));
      }
    }
  }

  /** Replaces the worn items with a flat id list (inventory/switch_equip's `wear`). */
  setWearIds(ids: number[], catalog?: ItemCatalog): void {
    this.wear.clear();
    for (const raw of ids) {
      const id = Number(raw);
      if (!id) {
        continue;
      }
      const type = catalog?.get(id)?.type;
      this.wear.set(type ?? `#${id}`, id);
    }
    if (catalog) {
      this.retype(catalog);
    }
  }

  items(): BagItem[] {
    return [...this.bag.values()];
  }

  count(itemId: number): number {
    return this.bag.get(itemId)?.count ?? 0;
  }

  isWorn(itemId: number): boolean {
    for (const id of this.wear.values()) {
      if (id === itemId) {
        return true;
      }
    }
    return false;
  }

  /** Count of an item by base id across upgrade levels (quest requirements use base·1000). */
  countBase(itemId: number): number {
    let countValue = 0;
    for (const it of this.bag.values()) {
      if (baseId(it.itemId) === baseId(itemId)) {
        countValue += it.count;
      }
    }
    return countValue;
  }
}

export class InventoryApi {
  client: GameClient;

  constructor(client: GameClient) {
    this.client = client;
  }

  private cloth(json: JsonObject): ClothChange {
    return {
      changes: arr(json.changes),
      speed: typeof json.speed === 'number' ? json.speed : undefined,
      workPointBonus: json.workPointBonus,
      error: json.error ? String(json.message || json.msg || json.error) : undefined,
    };
  }

  async carry(itemId: number, lastInvId: number): Promise<ClothChange> {
    return this.cloth(await this.client.remoteCall('inventory', 'carry', { item_id: itemId, last_inv_id: lastInvId }));
  }

  async uncarry(type: string, lastInvId: number): Promise<ClothChange> {
    return this.cloth(await this.client.remoteCall('inventory', 'uncarry', { last_inv_id: lastInvId, type }));
  }

  async changedSince(invId: number): Promise<{ changes: unknown; wear: unknown }> {
    const json = await this.client.remoteCall('inventory', 'inventory_changed', { inv_id: invId });
    return { changes: json.changes === false ? [] : json.changes, wear: json.wear };
  }

  /** Saved equipment sets (EquipManager.showPopup). */
  async equipSets(): Promise<EquipSets> {
    const json = await this.client.remoteCallMode('inventory', 'show_equip', {});
    if (json.error) {
      throw new Error(String(json.msg ?? json.error));
    }
    return {
      sets: objs(json.data).map(parseEquipSet),
      max: Number(json.max) || 0,
      premiumMax: Number(json.premium_max) || 0,
      hasPremium: !!json.hasPremium,
      price: Number(json.price) || 0,
    };
  }

  /** Switches to a saved set (EquipManager.switchEquip). */
  async switchEquip(id: number, lastInvId: number): Promise<SwitchEquipResult> {
    const json = await this.client.remoteCall('inventory', 'switch_equip', { id, last_inv_id: lastInvId });
    if (json.error) {
      throw new Error(String(json.msg ?? json.error));
    }
    const result = this.cloth(json);
    return {
      ...result,
      wear: arr(json.wear).map(Number),
      setItems: arr(json.setItems).map(Number),
    };
  }

  /** Saves the current equipment as a new set (EquipManager.save). */
  async saveEquip(name: string): Promise<EquipSet | null> {
    const json = await this.client.remoteCall('inventory', 'save_equip', { name });
    if (json.error) {
      throw new Error(String(json.msg ?? json.error));
    }
    return isObj(json.data) ? parseEquipSet(json.data) : null;
  }

  /** Overwrites a saved set with the current equipment (EquipManager.replaceEquip). */
  async replaceEquip(id: number): Promise<void> {
    const json = await this.client.remoteCall('inventory', 'replace_equip', { id });
    if (json.error) {
      throw new Error(String(json.msg ?? json.error));
    }
  }
}
