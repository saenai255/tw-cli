// Live updates: the browser's chat service is an HTTP long-poll, not socket.io (socket.io is only
// loaded for the MPI translation helper). Chat.Router (tw2game @1059388):
//   POST <world>/gameservice/chat/   body = encodeURIComponent(JSON.stringify({messageid, clid, stamp,
//        actioned, batch:[{op:'nop', to:null, stamp}]}))   (jQuery default form content type)
//   ← {timenow, batch:[{id, t, payload}], error?}
// The server holds the request until there are events; the client immediately sends the next nop
// (at most one request per second, 30 s pause after a network error).
// The browser also pushes `var_dec`/`style_dec` requests, but only when new window globals or style
// sheets appear after the page loaded (userscripts). A plain client never sends them, so neither do we.
// `actioned` is the time of the user's last click/keypress (we pass the last TUI keypress).
// Events used here (Response.* @1045596-1054463):
//   Status {self, clients, rooms, sessionHash}  first reply; self = our own client
//   UserUpdate {id, x, y, level, experience, money, deposit, energy, energy_date, energy_regen,
//               health, health_date, health_regen, ...}  for our id → Character.set*
//   QuestDataChanged → reload quest log; ReportChanged / ReadState → unread markers;
//   NuggetsChanged {nuggets}; TellReceived {from:{name}, message}; CharDeathStateChanged.
//   SesStatChanged {<stat>: value} → seasonal event counter ('ses:<stat>'); CommEventChanged {event_id, event_stage}.
//   error "invalid sid" / "sid invalidated by login" → session gone.
// Chat rooms (Chat.Resource.* @1027002, Response.* @1045596): Status.rooms[{roomdescription:{id, room
//   (town|general|maneuver|fortbattle), title, topic, townid, general_id}, members:[client id]}], Status.clients
//   [{id, westid, name, level, ...}]; ClientJoined {rid, client}; ClientLeft {rid, cid}; Text {cid, to, message};
//   TellReceived {from:client, message}; TellConfirmed {to:client, message}; TellFailed.
// Sending (Chat.Request.Send / Tell @1040177): the same POST with batch [{op:'send', to:<room id | player name>,
//   stamp, message[, tell:true]}]; the browser allows a second request while the long-poll is open.
import { EventEmitter } from 'node:events';
import { type GameClient, send } from '../http/game-client.ts';
import type { HostPolicy } from '../http/throttle.ts';
import { arr, isObj, type JsonObject, obj, objs } from '../util/json.ts';

export interface SelfUpdate {
  x?: number | undefined;
  y?: number | undefined;
  level?: number | undefined;
  experience?: number | undefined;
  money?: number | undefined;
  deposit?: number | undefined;
  /** energyAt / healthAt: seconds relative to now when the value was measured (energy_date, usually ≤ 0). */
  energy?: number | undefined;
  energyAt?: number | undefined;
  health?: number | undefined;
  healthAt?: number | undefined;
  townId?: number | undefined;
}

export interface ChatEvent {
  id: string;
  t: number;
  payload: JsonObject;
}

/** A chat client, with what the town roster shows (Client.update @1029207). */
export interface ChatClient {
  id: string;
  playerId: number;
  name: string;
  level: number;
  townId: number;
  /** 0 none · 1 citizen · 2 councillor · 3 town founder (mayor). */
  townRights: number;
  /** Epoch ms of the player's last action (5 min idle threshold, Chat.Resource.Client.updateStatus). */
  actioned: number;
}

export interface ChatRoom {
  id: string;
  kind: string;
  title: string;
  topic: string;
  members: Set<string>;
  townId?: number;
}
export interface ChatLine {
  at: number;
  from: string;
  text: string;
  own: boolean;
}

/** Town role names as the browser's RoomTown.getPlayerInfo shows them (3 is the founder/mayor). */
export const TOWN_ROLES = ['Guest', 'Citizen', 'Councillor', 'Mayor'];

const PRESENCE_IDLE_MS = 5 * 60_000;
const CHAT_ERROR_PAUSE_MS = 30_000;
const CHAT_SEND_TIMEOUT_MS = 30_000;

/** Online within 5 minutes of the last action, as Chat.Resource.Client.updateStatus. */
export function chatPresence(actioned: number | undefined, now = Date.now()): 'online' | 'idle' | 'unknown' {
  if (!actioned) {
    return 'unknown';
  }
  return now - actioned > PRESENCE_IDLE_MS ? 'idle' : 'online';
}

const ROOM_KIND_TITLE: Record<string, string> = {
  town: 'Town',
  general: 'Saloon',
  maneuver: 'Maneuver',
  fortbattle: 'Fort battle',
};
export const HISTORY_LIMIT = 200;

function stripTags(source: unknown): string {
  return String(source ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

export const CHAT_POLICY: HostPolicy = {
  lane: 'chat',
  concurrency: 1,
  minIntervalMs: 1000, // Chat.Router requestDelay
  jitterMs: 0,
  maxRetries: 0,
  baseBackoffMs: 0,
  maxBackoffMs: 0,
  breakerThreshold: 1_000_000, // handled here: 30 s pause per error like the browser
  breakerCooldownMs: 0,
  timeoutMs: 120_000,
};

/** Chat.Router clientConnectionId: shuffled a-z + time, 18 chars, + last 4 digits of the time. */
export function makeClientId(now = Date.now(), rand = Math.random): string {
  const chars = `abcdefghijklmnopqrstuvwxyz${now}`.split('');
  for (let index = chars.length - 1; index > 0; index--) {
    const innerIndex = Math.floor(rand() * (index + 1));
    const current = chars[index] ?? '';
    chars[index] = chars[innerIndex] ?? '';
    chars[innerIndex] = current;
  }
  return chars.join('').slice(5, 23) + String(now).slice(-4);
}

export function encodeChatRequest(data: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(data));
}

/** The reason a chat error ends the session, or null when it is an ordinary error. */
const sessionInvalidReason = (message: string): string | null => {
  if (/invalid sid|sid invalidated by login/.test(message)) {
    return message;
  }
  if (/admin login/.test(message)) {
    return 'Administrator login - chat deactivated';
  }
  return null;
};

function selfFrom(data: JsonObject): SelfUpdate {
  const numberOrUndefined = (value: unknown) =>
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value !== '' && !Number.isNaN(Number(value))
        ? Number(value)
        : undefined;
  return {
    x: numberOrUndefined(data.x),
    y: numberOrUndefined(data.y),
    level: numberOrUndefined(data.level),
    experience: numberOrUndefined(data.experience),
    money: numberOrUndefined(data.money),
    deposit: numberOrUndefined(data.deposit),
    energy: numberOrUndefined(data.energy),
    energyAt: numberOrUndefined(data.energy_date),
    health: numberOrUndefined(data.health),
    healthAt: numberOrUndefined(data.health_date),
    townId: numberOrUndefined(data.townId),
  };
}

/** What ChatPoller emits; 'event' fires for every event, before the specific one. */
export interface ChatPollerEvents {
  self: [SelfUpdate];
  quests: [];
  reports: [JsonObject];
  read: [JsonObject];
  nuggets: [number];
  tell: [{ from: string; message: string }];
  text: [{ room: string; cid: string; message: string }];
  chat: [string, ChatLine];
  rooms: [];
  tellFailed: [];
  revived: [JsonObject];
  /** Seasonal event stats, e.g. {dayofdead_collected: 50113}. */
  ses: [Record<string, number>];
  communityEvent: [{ id: string; stage: number }];
  event: [ChatEvent];
  invalid: [string];
  error: [Error];
}

export class ChatPoller extends EventEmitter<ChatPollerEvents> {
  client: GameClient;
  myId: string | null = null;
  actioned: number | null = null;
  private running = false;
  private abort: AbortController | null = null;
  private messageId = 0;
  private clid = makeClientId();
  private policy: HostPolicy;
  private errorPauseMs: number;
  /** Chat rooms we are in, client data, and per-room history ("tell:<name>" for whispers). */
  rooms = new Map<string, ChatRoom>();
  clients = new Map<string, ChatClient>();
  history = new Map<string, ChatLine[]>();
  unreadRooms = new Set<string>();

  constructor(client: GameClient, opts: { policy?: HostPolicy; errorPauseMs?: number } = {}) {
    super();
    this.client = client;
    this.policy = opts.policy ?? CHAT_POLICY;
    this.errorPauseMs = opts.errorPauseMs ?? CHAT_ERROR_PAUSE_MS;
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  /** One request → events handled. Returns false when the session is gone. */
  async pollOnce(): Promise<boolean> {
    this.abort = new AbortController();
    return this.exchange([{ op: 'nop', to: null, stamp: Date.now() }], this.abort.signal, this.policy);
  }

  /** Says something in a room (Chat.Request.Send). */
  say(to: string, message: string): Promise<void> {
    return this.send({ op: 'send', to, stamp: Date.now(), message });
  }

  /** Whispers to a player (Chat.Request.Tell). */
  whisper(to: string, message: string): Promise<void> {
    return this.send({ op: 'send', to, stamp: Date.now(), message, tell: true });
  }

  private async send(request: Record<string, unknown>): Promise<void> {
    if (!String(request.message ?? '').trim()) {
      return;
    }
    // A second request beside the pending long-poll, like Chat.Router (openCnt ≤ 2); not on the poll lane.
    const ok = await this.exchange([request], undefined, {
      ...this.policy,
      lane: 'chat-send',
      timeoutMs: CHAT_SEND_TIMEOUT_MS,
    });
    if (!ok) {
      throw new Error('chat session is gone');
    }
  }

  private async exchange(
    batchOut: Record<string, unknown>[],
    signal: AbortSignal | undefined,
    policy: HostPolicy,
  ): Promise<boolean> {
    const data = {
      messageid: ++this.messageId,
      clid: this.clid,
      stamp: Date.now(),
      actioned: this.actioned,
      batch: batchOut,
    };
    const client = this.client;
    const res = await send(
      client.jar,
      client.identity,
      `${client.worldUrl}/gameservice/chat/`,
      {
        method: 'POST',
        body: encodeChatRequest(data),
        ajax: true,
        referer: `${client.worldUrl}/game.php`,
        origin: client.worldUrl,
        signal,
      },
      policy,
    );
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`chat: non-JSON reply (${res.status})`);
    }
    const json = obj(parsed);
    if (json.error) {
      const error = String(json.error);
      const invalidReason = sessionInvalidReason(error);
      if (invalidReason) {
        this.emit('invalid', invalidReason);
        return false;
      }
      throw new Error(`chat: ${error}`);
    }
    const batch: ChatEvent[] = objs(json.batch).map((event) => ({
      id: String(event.id),
      t: Number(event.t),
      payload: obj(event.payload),
    }));
    batch.sort((first, second) => first.t - second.t);
    for (const event of batch) {
      this.handle(event);
    }
    return true;
  }

  roomTitle(id: string): string {
    if (id.startsWith('tell:')) {
      return `✉ ${id.slice(5)}`;
    }
    const entry = this.rooms.get(id);
    return entry ? entry.title : id;
  }

  private addLine(room: string, line: ChatLine): void {
    const list = this.history.get(room) ?? [];
    list.push(line);
    if (list.length > HISTORY_LIMIT) {
      list.splice(0, list.length - HISTORY_LIMIT);
    }
    this.history.set(room, list);
    if (!line.own) {
      this.unreadRooms.add(room);
    }
    this.emit('chat', room, line);
  }

  private acquireRoom(jsonValue: JsonObject): ChatRoom {
    const id = String(jsonValue.id);
    const kind = String(jsonValue.room ?? '');
    const title =
      stripTags(jsonValue.title) ||
      (kind === 'general' ? `Saloon ${String(jsonValue.general_id ?? '')}`.trim() : (ROOM_KIND_TITLE[kind] ?? id));
    const room = this.rooms.get(id) ?? { id, kind, title, topic: '', members: new Set<string>() };
    room.title = title;
    room.topic = stripTags(jsonValue.topic);
    if (jsonValue.townid !== undefined && jsonValue.townid !== null) {
      room.townId = Number(jsonValue.townid);
    }
    this.rooms.set(id, room);
    return room;
  }

  /** Creates or updates a client from Status / ClientJoined / UserUpdate data (missing fields keep old values). */
  private acquireClient(value: unknown): ChatClient | null {
    if (!isObj(value) || value.id === undefined) {
      return null;
    }
    const data = value;
    const id = String(data.id);
    const previous = this.clients.get(id);
    const numberOrUndefined = (candidate: unknown): number | undefined =>
      candidate === null || candidate === undefined || candidate === ''
        ? undefined
        : Number.isFinite(Number(candidate))
          ? Number(candidate)
          : undefined;
    const client: ChatClient = {
      id,
      playerId: numberOrUndefined(data.westid ?? data.playerId) ?? previous?.playerId ?? 0,
      name: String(data.name ?? data.pname ?? previous?.name ?? '?'),
      level: numberOrUndefined(data.level) ?? previous?.level ?? 0,
      townId: numberOrUndefined(data.townId ?? data.town_id) ?? previous?.townId ?? 0,
      townRights: numberOrUndefined(data.town_rights ?? data.townRights) ?? previous?.townRights ?? 0,
      actioned: numberOrUndefined(data.actioned) ?? previous?.actioned ?? 0,
    };
    this.clients.set(id, client);
    return client;
  }

  clientName(id: string): string {
    return this.clients.get(id)?.name ?? '?';
  }

  handle(event: ChatEvent): void {
    this.emit('event', event);
    const payload = event.payload;
    switch (event.id) {
      case 'Status':
        if (isObj(payload.self)) {
          this.myId = String(payload.self.id);
          this.acquireClient(payload.self);
          this.emit('self', selfFrom(payload.self));
        }
        for (const client of arr(payload.clients)) {
          this.acquireClient(client);
        }
        if (Array.isArray(payload.rooms)) {
          const seen = new Set<string>();
          for (const roomData of objs(payload.rooms)) {
            if (!isObj(roomData.roomdescription)) {
              continue;
            }
            const room = this.acquireRoom(roomData.roomdescription);
            room.members = new Set(arr(roomData.members).map(String));
            seen.add(room.id);
          }
          for (const id of [...this.rooms.keys()]) {
            if (!seen.has(id)) {
              this.rooms.delete(id);
            }
          }
          this.emit('rooms');
        }
        break;
      case 'ClientJoined': {
        const room = this.rooms.get(String(payload.rid));
        this.acquireClient(payload.client);
        const joined = obj(payload.client);
        if (room && joined.id !== undefined) {
          room.members.add(String(joined.id));
        }
        this.emit('rooms');
        break;
      }
      case 'ClientLeft':
        this.rooms.get(String(payload.rid))?.members.delete(String(payload.cid));
        this.emit('rooms');
        break;
      case 'TellConfirmed': {
        const to = this.acquireClient(payload.to)?.name ?? '?';
        this.addLine(`tell:${to}`, {
          at: event.t,
          from: this.clients.get(this.myId ?? '')?.name ?? 'me',
          text: stripTags(payload.message),
          own: true,
        });
        break;
      }
      case 'TellFailed':
        this.emit('tellFailed');
        break;
      case 'UserUpdate':
        this.acquireClient(payload);
        if (this.myId !== null && String(payload.id) === this.myId) {
          this.emit('self', selfFrom(payload));
        } else if (payload.id !== undefined) {
          this.emit('rooms');
        }
        break;
      case 'QuestDataChanged':
        this.emit('quests');
        break;
      case 'ReportChanged':
        this.emit('reports', payload);
        break;
      case 'ReadState':
        this.emit('read', payload);
        break;
      case 'NuggetsChanged':
        this.emit('nuggets', Number(payload.nuggets));
        break;
      case 'TellReceived': {
        const from = this.acquireClient(payload.from)?.name ?? '?';
        this.addLine(`tell:${from}`, { at: event.t, from, text: stripTags(payload.message), own: false });
        this.emit('tell', {
          from: String(obj(payload.from).name ?? '?'),
          message: String(payload.message ?? ''),
        });
        break;
      }
      case 'Text': {
        const clientId = String(payload.cid ?? '');
        const room = String(payload.to ?? '');
        this.addLine(room, {
          at: event.t,
          from: this.clientName(clientId),
          text: stripTags(payload.message),
          own: clientId === this.myId,
        });
        this.emit('text', { room, cid: clientId, message: String(payload.message ?? '') });
        break;
      }
      case 'CharDeathStateChanged':
        this.emit('revived', payload);
        break;
      case 'SesStatChanged':
        this.emit(
          'ses',
          Object.fromEntries(Object.entries(payload).map(([stat, value]) => [stat, Number(value) || 0])),
        );
        break;
      case 'CommEventChanged':
        this.emit('communityEvent', { id: String(payload.event_id ?? ''), stage: Number(payload.event_stage) || 0 });
        break;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.pollOnce())) {
          this.running = false;
          break;
        }
      } catch (err) {
        if (!this.running) {
          break;
        }
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        await new Promise((transform) => setTimeout(transform, this.errorPauseMs));
      }
    }
  }
}
