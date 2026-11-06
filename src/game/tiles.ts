// Tile detail via map/get_complete_data {tiles: JSON [[tx,ty],...]} (GameMap.Data.Loader @420667),
// cached 60 s like the browser (GameMap.Data dataTTL). We only use the parts that name points of interest:
//   dynamic: [{tx:{ty:[[{x,y,left,top}, data], ...]}}, ...] where data is one of
//     town  {town_id,x,y,name,member,points,rank,...}
//     fort  {fort_id,name,fort_battle_count,battlestartdelta,...}
//     job   {job_id,group_id,x,y,gold,silver}          ← gold / silver jobs
//     crowd {count,x,y}                                 ← players standing there
//   quests: {tx:{ty:[[{...}, {x,y,employer:[{key,name,visible,...}]}]]}} | null
// Response shapes checked against a live reply (dynamic) and the saved sample game-38d090cd2e3a4.php (quests).
import type { GameClient } from '../http/game-client.ts';
import { arr, isObj, type JsonObject, objs, vals } from '../util/json.ts';
import { isUsablePosition, type Position } from './character.ts';
import { TILE, WORLD_H, WORLD_W } from './world.ts';

export interface SpecialJob extends Position {
  jobId: number;
  groupId: number;
  gold: boolean;
  silver: boolean;
  /** When this tile reply last showed the job (persisted for a day by special-jobs.ts). */
  seenAt: number;
}
export interface QuestGiver extends Position {
  names: string[];
  employers: { key: string; name: string }[];
}
export interface Crowd extends Position {
  count: number;
}

const TTL_MS = 60_000;
const MAX_TILES_PER_REQUEST = 25;

export class TileCache {
  private loadedAt = new Map<string, number>();
  specialJobs = new Map<string, SpecialJob>();
  questGivers = new Map<string, QuestGiver>();
  crowds = new Map<string, Crowd>();
  private inflight = false;

  private fresh(tx: number, ty: number): boolean {
    const entryValue = this.loadedAt.get(`${tx},${ty}`);
    return entryValue !== undefined && Date.now() - entryValue < TTL_MS;
  }

  /** Loads stale tiles in a square around `at` (radius in tiles). Returns true if a request was made. */
  async loadAround(client: GameClient, at: Position, radius = 2): Promise<boolean> {
    if (this.inflight) {
      return false;
    }
    const cx = Math.floor(at.x / TILE);
    const cy = Math.floor(at.y / TILE);
    const tiles: [number, number][] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx * TILE >= WORLD_W || ty * TILE >= WORLD_H) {
          continue;
        }
        if (!this.fresh(tx, ty)) {
          tiles.push([tx, ty]);
        }
      }
    }
    if (!tiles.length) {
      return false;
    }
    this.inflight = true;
    try {
      const json = await client.get('map', 'get_complete_data', {
        tiles: JSON.stringify(tiles.slice(0, MAX_TILES_PER_REQUEST)),
      });
      this.ingest(json, tiles.slice(0, MAX_TILES_PER_REQUEST));
      return true;
    } finally {
      this.inflight = false;
    }
  }

  ingest(json: JsonObject, requested: [number, number][]): void {
    const now = Date.now();
    for (const tile of this.forgetRequestedTiles(requested)) {
      this.loadedAt.set(tile, now);
    }
    this.ingestDynamic(json);
    this.ingestQuestGivers(json);
  }

  /** Forget old entries of the requested tiles before re-adding them; returns those tile keys. */
  private forgetRequestedTiles(requested: [number, number][]): Set<string> {
    const tiles = new Set(requested.map(([xCoord, yCoord]) => `${xCoord},${yCoord}`));
    const tileOf = (position: Position) => `${Math.floor(position.x / TILE)},${Math.floor(position.y / TILE)}`;
    for (const entries of [this.specialJobs, this.questGivers, this.crowds] as Map<string, Position>[]) {
      for (const [key, position] of entries) {
        if (tiles.has(tileOf(position))) {
          entries.delete(key);
        }
      }
    }
    return tiles;
  }

  /** Job locations and crowds from the dynamic layer. */
  private ingestDynamic(json: JsonObject): void {
    const layers = Array.isArray(json.dynamic) ? json.dynamic : json.dynamic ? [json.dynamic] : [];
    for (const layer of layers) {
      for (const row of vals(layer)) {
        for (const column of vals(row)) {
          for (const entry of vals(column)) {
            const data = arr(entry)[1];
            if (!isObj(data)) {
              continue;
            }
            const xCoord = Number(data.x);
            const yCoord = Number(data.y);
            const key = `${xCoord},${yCoord}`;
            if (data.job_id !== undefined && (data.gold || data.silver) && isUsablePosition({ x: xCoord, y: yCoord })) {
              this.specialJobs.set(`${key}#${String(data.job_id)}`, {
                x: xCoord,
                y: yCoord,
                jobId: Number(data.job_id),
                groupId: Number(data.group_id),
                gold: !!data.gold,
                silver: !!data.silver,
                seenAt: Date.now(),
              });
            } else if (data.count !== undefined && data.town_id === undefined) {
              this.crowds.set(key, { x: xCoord, y: yCoord, count: Number(data.count) });
            }
          }
        }
      }
    }
  }

  /** Quest givers and the employers standing at them. */
  private ingestQuestGivers(json: JsonObject): void {
    for (const row of vals(json.quests)) {
      for (const column of vals(row)) {
        for (const entry of vals(column)) {
          const data = arr(entry)[1];
          if (!isObj(data)) {
            continue;
          }
          const employers = objs(data.employer)
            .filter((employer) => employer.visible !== false)
            .map((employer) => ({
              key: String(employer.key),
              name: String(employer.name)
                .replace(/&#039;/g, "'")
                .replace(/&amp;/g, '&'),
            }));
          const xCoord = Number(data.x);
          const yCoord = Number(data.y);
          this.questGivers.set(`${xCoord},${yCoord}`, {
            x: xCoord,
            y: yCoord,
            names: employers.map((employer) => employer.name),
            employers,
          });
        }
      }
    }
  }
}
