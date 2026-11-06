// Character state from Character.init (game.php) plus the client's own regen ticker
// (Character.tick4Character @723978) and max-health formula (calcMaxHealth @723529).

import { isObj, type JsonObject, nums, obj } from '../util/json.ts';
import type { ServerClock } from './clock.ts';

export interface Position {
  x: number;
  y: number;
}

/**
 * Whether a map position is real. `pos`/task coords can arrive as `{x:0,y:0}` when the server has none yet
 * (no position in the session, an idle character, a task without coords); the map origin is not a place a
 * character stands, so (0,0) means "unknown" here too.
 */
export function isUsablePosition(position: Position | null | undefined): position is Position {
  const x = Number(position?.x);
  const y = Number(position?.y);
  return Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0);
}

/**
 * Total XP at which `level` starts (Character.calcLowerExp @717300): floor((Σk² for k≤level + 10·(level+1) − 21) · 3)
 * plus 1000·(level − 120)^2.9 above level 120; capped at the world's max level.
 */
export function levelStartXp(level: number, maxLevel = 250): number {
  const value = Math.min(level, maxLevel);
  return Math.floor(
    ((value * (value + 1) * (2 * value + 1)) / 6 + (value + 1) * 10 - 21) * 3 +
      (value > 120 ? 1000 * (value - 120) ** 2.9 : 0),
  );
}

export interface LevelProgress {
  /** XP earned within the current level (Character.getExperience4Level). */
  have: number;
  /** XP the level needs in all (getMaxExperience4Level); 0 at the max level. */
  need: number;
  /** have / need, 0..1 (1 at the max level). */
  ratio: number;
  maxed: boolean;
}

export function levelProgress(level: number, experience: number, maxLevel = 250): LevelProgress {
  const lo = levelStartXp(level, maxLevel);
  const hi = levelStartXp(level + 1, maxLevel);
  const have = Math.max(0, experience - lo);
  if (hi <= lo) {
    return { have, need: 0, ratio: 1, maxed: true };
  }
  return { have, need: hi - lo, ratio: Math.min(1, have / (hi - lo)), maxed: false };
}

export class CharacterState {
  playerId = 0;
  name = '';
  level = 0;
  charClass = '';
  charSex = '';
  duelLevel = 0;
  /** Character.itemLevelRequirementDecrease: {all, <slot>} levels off item requirements. */
  itemLevelDecrease: Record<string, number> = {};
  experience = 0;
  /** Game.init.maxLevel (250 on en32). */
  maxLevel = 250;
  cash = 0;
  deposit = 0;
  nuggets = 0;
  position: Position = { x: 0, y: 0 };
  /** Whether `position` is a real map position; false until the server, a live update or a task provides one. */
  positionKnown = false;
  homeTown: { id: number; x: number; y: number } | null = null;
  /** Character.speed (charSpeed): multiplies travel time. */
  speed = 1;
  maxEnergy = 100;
  maxHealth = 100;
  healthRegen = 0;
  energyRegen = 0;
  taskLimit = { normal: 4, premium: 9 };
  /** Max HP gained per level (Character.lpPerPoint). */
  lpPerPoint = 0;
  skills: Record<string, number> = {};
  skillBonus: Record<string, number> = {};
  private baseEnergy = 0;
  private energyAt = 0; // server seconds
  private baseHealth = 0;
  private healthAt = 0;

  private clock: ServerClock;

  get progress(): LevelProgress {
    return levelProgress(this.level, this.experience, this.maxLevel);
  }

  constructor(clock: ServerClock) {
    this.clock = clock;
  }

  static fromInit(data: JsonObject, clock: ServerClock): CharacterState {
    const character = new CharacterState(clock);
    character.playerId = Number(data.playerId);
    character.name = String(data.name ?? '');
    character.level = Number(data.level);
    character.charClass = String(obj(data.charClass).type ?? '');
    character.charSex = String(data.charSex ?? '');
    character.duelLevel = Number(data.duelLevel) || 0;
    character.itemLevelDecrease = nums(data.itemLevelRequirementDecrease);
    character.experience = Number(data.experience);
    character.cash = Number(data.cash);
    character.deposit = Number(data.deposit);
    character.nuggets = Number(data.nuggets);
    const pos = obj(data.pos);
    character.setPosition({ x: Number(pos.x), y: Number(pos.y) });
    const town = isObj(data.town) ? data.town : null;
    character.homeTown = town
      ? { id: Number(town.id), x: Number(obj(town.coords).x), y: Number(obj(town.coords).y) }
      : null;
    character.speed = Number(data.charSpeed ?? 1);
    character.maxEnergy = Number(data.maxEnergy);
    character.healthRegen = Number(data.healthRegenFactor ?? 0);
    character.energyRegen = Number(data.energyRegenFactor ?? 0);
    if (isObj(data.taskLimit)) {
      character.taskLimit = {
        normal: Number(data.taskLimit.normal) || 4,
        premium: Number(data.taskLimit.premium) || 9,
      };
    }
    character.skills = nums(obj(data.skillData).skills);
    character.skillBonus = nums(obj(data.skillData).skillBonus);
    const lp = Number(data.lpPerPoint ?? 0);
    character.lpPerPoint = lp;
    const lpBonus = Number(data.lpPerPointBonus ?? 0);
    const healthPoints = (character.skills.health ?? 0) + (character.skillBonus.health ?? 0);
    character.maxHealth = Math.trunc(100 + (character.level - 1) * lp + healthPoints * (lp + lpBonus));
    character.setHealth(Number(data.health));
    character.setEnergy(Number(data.energy));
    return character;
  }

  /** Sets a real map position; false (and no change) when the value is missing or the (0,0) sentinel. */
  setPosition(position: Position | null | undefined): boolean {
    if (!isUsablePosition(position)) {
      return false;
    }
    this.position = { x: Number(position.x), y: Number(position.y) };
    this.positionKnown = true;
    return true;
  }

  /** `at`: server time (s) the value was measured (energy_date from live updates); default now. */
  setEnergy(value: number, at?: number): void {
    this.baseEnergy = Math.floor(value);
    this.energyAt = at && at <= this.clock.now() ? at : this.clock.now();
  }

  setHealth(height: number, at?: number): void {
    this.baseHealth = Math.min(Math.floor(height), this.maxHealth);
    this.healthAt = at && at <= this.clock.now() ? at : this.clock.now();
  }

  /** The last server values (no regen): changes only when the server tells us something new. */
  get serverValues(): { energy: number; energyAt: number; health: number; healthAt: number } {
    return { energy: this.baseEnergy, energyAt: this.energyAt, health: this.baseHealth, healthAt: this.healthAt };
  }

  /** Current energy including regeneration since the last server value. */
  get energy(): number {
    const diff = this.clock.now() - this.energyAt;
    return Math.min(this.maxEnergy, Math.floor(this.baseEnergy + (this.maxEnergy * this.energyRegen * diff) / 3600));
  }

  get health(): number {
    const diff = this.clock.now() - this.healthAt;
    return Math.min(this.maxHealth, Math.floor(this.baseHealth + (this.maxHealth * this.healthRegen * diff) / 3600));
  }
}
