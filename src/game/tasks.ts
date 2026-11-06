// Task queue, mirroring TaskQueue (tw2game @694568) and Task/TaskFactory (@681020–@686063).
//  add:    task/add     {tasks: {<queuePos>: task.post}}   post = ctor fields + taskType
//          job:  {jobId, x, y, duration, taskType:'job'}
//          walk: {unitId, type, x, y, taskType:'walk'}
//          sleep:{town_id, room, taskType:'sleep'}
//          build:{x, y, building_key, duration, deposit:'town'|'player', taskType:'build'} (town construction)
//          reply: {tasks: {<queuePos>: {task?, error?, msg?}}, energy?, buffs?, protection?}
//  cancel: task/cancel  {tasks: {<queuePos>: {queueId, type}}}
//          reply: {tasks: {<queuePos>: {extra?, error?, msg?}}, queue: [...]}
//  list:   task/get_tasks (mode) → {queue: [...]}
// Queue entries: {queue_id, date_start, date_done (epoch s), type, data|data_obj:{coords, wayData?, ...}}

import type { FormValue } from '../http/form.ts';
import type { GameClient } from '../http/game-client.ts';
import { type JsonObject, obj, objs, vals } from '../util/json.ts';
import { isUsablePosition, type Position } from './character.ts';

export interface TaskWay {
  queueId: number;
  start: number; // epoch s
  end: number;
  to: Position;
}

export interface QueuedTask {
  queueId: number;
  type: string;
  start: number; // epoch s
  end: number;
  coords: Position;
  /** Whether `coords` is a real position; false when the server sent none (the map origin is not a place). */
  coordsKnown: boolean;
  title: string;
  jobId?: number | undefined;
  way?: TaskWay | undefined;
  raw: JsonObject;
}

/** A task's coords, or the (0,0) sentinel when it has none (e.g. some build tasks the browser places at home). */
const coordsOf = (value: unknown): { coords: Position; known: boolean } => {
  const coords = { x: Number(obj(value).x), y: Number(obj(value).y) };
  return isUsablePosition(coords) ? { coords, known: true } : { coords: { x: 0, y: 0 }, known: false };
};

export function parseQueueEntry(jsonValue: JsonObject): QueuedTask {
  const data = obj(jsonValue.data_obj ?? jsonValue.data);
  const coords = coordsOf(data.coords);
  let at = coords.coords;
  let atKnown = coords.known;
  let way: TaskWay | undefined;
  if (data.wayData) {
    const wayDataJson = obj(data.wayData);
    const wd = obj(wayDataJson.data_obj ?? wayDataJson.data);
    const wayCoords = coordsOf(wd.coords);
    way = {
      queueId: Number(wayDataJson.queue_id),
      start: Number(wayDataJson.date_start),
      end: Number(wayDataJson.date_done),
      to: wayCoords.coords,
    };
    // A task without coords is at the end of its walk when the server sent wayData.
    if (!atKnown && wayCoords.known) {
      at = wayCoords.coords;
      atKnown = true;
    }
  }
  return {
    queueId: Number(jsonValue.queue_id),
    type: String(jsonValue.type),
    start: Number(jsonValue.date_start),
    end: Number(jsonValue.date_done),
    coords: at,
    coordsKnown: atKnown,
    title: String(data.title ?? data.town_name ?? data.name ?? jsonValue.type),
    jobId: data.job_id === undefined || data.job_id === null ? undefined : Number(data.job_id),
    way,
    raw: jsonValue,
  };
}

export function parseQueue(list: unknown): QueuedTask[] {
  return objs(list).map(parseQueueEntry);
}

export type TaskPost =
  | { taskType: 'job'; jobId: number; x: number; y: number; duration: number }
  | { taskType: 'walk'; unitId: number; type: string; x?: number; y?: number }
  | { taskType: 'sleep'; town_id: number; room: string }
  | { taskType: 'build'; x: number; y: number; building_key: string; duration: number; deposit: 'town' | 'player' };

/** Same key order as the browser's post objects (ctor fields first, taskType appended). */
export function jobPost(jobId: number, at: Position, duration: number): Record<string, FormValue> {
  return { jobId, x: at.x, y: at.y, duration, taskType: 'job' };
}

export function walkPost(unitId: number | string | null, type: string, at?: Position): Record<string, FormValue> {
  return { unitId, type, x: at?.x, y: at?.y, taskType: 'walk' };
}

export function sleepPost(townId: number, room: string): Record<string, FormValue> {
  return { town_id: townId, room, taskType: 'sleep' };
}

export interface AddResult {
  added: QueuedTask[];
  errors: string[];
  /** The server refused because the whole task queue is full (not this job in particular). */
  full: boolean;
  energy?: number | undefined;
}

/** Server reply when no more assignments fit; it is queue state, not a failure of the job we tried. */
export function isQueueFullMessage(message: string): boolean {
  return /cannot add any more assignments/i.test(message);
}

export class TaskLimitError extends Error {}

export class TaskApi {
  private client: GameClient;

  constructor(client: GameClient) {
    this.client = client;
  }

  async list(): Promise<QueuedTask[]> {
    const json = await this.client.remoteCallMode('task', 'get_tasks');
    if (json.error) {
      throw new Error(String(json.msg ?? 'task/get_tasks failed'));
    }
    return parseQueue(json.queue);
  }

  /**
   * Adds tasks behind the current queue. Positions continue from queueLength, exactly as the
   * browser keys them (post.tasks[queuePos]).
   */
  async add(queueLength: number, posts: Record<string, FormValue>[], limit: number): Promise<AddResult> {
    const room = limit - queueLength;
    if (room <= 0) {
      throw new TaskLimitError(`Task queue is full (${queueLength}/${limit})`);
    }
    const batch = posts.slice(0, room);
    const tasks: Record<string, FormValue> = {};
    batch.forEach((pick, index) => {
      tasks[String(queueLength + index)] = pick;
    });
    const json = await this.client.remoteCall('task', 'add', { tasks });
    const result: AddResult = { added: [], errors: [], full: false };
    for (const jsonValue of vals(json.tasks).map(obj)) {
      if (jsonValue.task) {
        result.added.push(parseQueueEntry(obj(jsonValue.task)));
      }
      if (jsonValue.error) {
        result.errors.push(String(jsonValue.msg ?? jsonValue.error));
      }
    }
    if (json.error && json.msg) {
      result.errors.push(String(json.msg));
    }
    result.full = result.errors.some(isQueueFullMessage);
    if (json.energy !== undefined) {
      result.energy = Number(json.energy);
    }
    return result;
  }

  /** Cancels tasks by queue position. Returns the server's new queue. */
  async cancel(
    queue: QueuedTask[],
    positions: number[],
  ): Promise<{ queue: QueuedTask[]; errors: string[]; energy?: number | undefined; money?: number | undefined }> {
    const tasks: Record<string, FormValue> = {};
    for (const pos of positions) {
      const task = queue[pos];
      if (task?.queueId) {
        tasks[String(pos)] = { queueId: task.queueId, type: task.type };
      }
    }
    const json = await this.client.remoteCall('task', 'cancel', { tasks });
    const errors: string[] = [];
    let energy: number | undefined;
    let money: number | undefined;
    for (const jsonValue of vals(json.tasks).map(obj)) {
      const extra = obj(jsonValue.extra);
      if (jsonValue.error) {
        errors.push(String(jsonValue.msg ?? jsonValue.error));
      }
      if (extra.energy !== undefined) {
        energy = Number(extra.energy);
      }
      if (extra.money !== undefined) {
        money = Number(extra.money);
      }
    }
    return { queue: parseQueue(json.queue), errors, energy, money };
  }
}

/** Seconds of walking still ahead for a task (its wayData leg), from `now`. */
export function walkLeft(task: QueuedTask, now: number): number {
  if (!task.way) {
    return 0;
  }
  return Math.max(0, task.way.end - Math.max(now, task.way.start));
}

/** Seconds of the task itself (excluding its walk) still ahead, from `now`. */
export function workLeft(task: QueuedTask, now: number): number {
  return Math.max(0, task.end - Math.max(now, task.start));
}

export interface QueueSummary {
  /** Epoch s when the last task is done. */
  doneAt: number;
  /** Seconds until then. */
  left: number;
  /** Seconds of that which is walking (wayData legs plus walk tasks). */
  walk: number;
}

export function queueSummary(queue: QueuedTask[], now: number): QueueSummary | null {
  if (!queue.length) {
    return null;
  }
  const doneAt = Math.max(...queue.map((task) => task.end));
  const walk = queue.reduce(
    (accumulator, current) =>
      accumulator + walkLeft(current, now) + (current.type === 'walk' ? workLeft(current, now) : 0),
    0,
  );
  return { doneAt, left: Math.max(0, doneAt - now), walk };
}
