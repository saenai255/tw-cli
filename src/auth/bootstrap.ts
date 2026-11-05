import { isObj, type JsonObject } from '../util/json.ts';
// Parses the initial state game.php embeds as inline calls, e.g.
//   Game.init({...});  Player.init({"h":"688885",...});  Character.init({"playerId":...});
// (game.php @4198, @90170, @105241). Arguments are JSON object literals; we find the call, then scan
// to the matching closing brace while respecting string literals, and JSON.parse the slice.

/** The parsed argument, or null when the call is missing or its argument is not JSON. */
export function extractInitArg(html: string, call: string): unknown {
  const at = html.indexOf(`${call}(`);
  if (at < 0) {
    return null;
  }
  let index = at + call.length + 1;
  while (index < html.length && /\s/.test(html[index] ?? '')) {
    index++;
  }
  if (html[index] !== '{' && html[index] !== '[') {
    return null;
  }
  const start = index;
  let depth = 0;
  let inStr: string | null = null;
  for (; index < html.length; index++) {
    const ch = html[index] ?? '';
    if (inStr) {
      if (ch === '\\') {
        index++;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface Bootstrap {
  h: string;
  game: JsonObject | null;
  player: JsonObject;
  character: JsonObject | null;
  premium: JsonObject | null;
  /** Bag.init({bag, wear, setItems, itemCooldown, itemLifetime}) */
  bag: JsonObject | null;
  /** west.wof.WofManager.init([{id, type, name, title, free, endDate}]): event wheels (game/events.ts). */
  wheels: unknown[];
}

const arrayOrEmpty = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export class BootstrapError extends Error {}

export function parseBootstrap(html: string): Bootstrap {
  const readInit = (call: string) => {
    const value = extractInitArg(html, call);
    return isObj(value) ? value : null;
  };
  const player = readInit('Player.init');
  const hash = typeof player?.h === 'string' ? player.h : null;
  if (!player || !hash || !/^[0-9a-f]{4,32}$/i.test(hash)) {
    throw new BootstrapError('game.php did not contain Player.init({h:…}); not logged in or the page format changed');
  }
  return {
    h: hash,
    player,
    game: readInit('Game.init'),
    character: readInit('Character.init'),
    premium: readInit('Premium.init'),
    bag: readInit('Bag.init'),
    wheels: arrayOrEmpty(extractInitArg(html, 'WofManager.init')),
  };
}
