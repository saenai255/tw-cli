// Overlays that sit on top of a screen: the go-to key menu, help, the hotel room picker, map layers and
// points of interest. They share the App's key handling through Mode and SCREEN_MODES.
import { Box, Text } from 'ink';
import React from 'react';
import type { Hotel } from '../game/hotel.ts';
import { POI_STYLE, type Poi } from '../game/poi.ts';
import type { GameState } from '../game/state.ts';
import { defined } from '../util/defined.ts';
import { formatDuration, money, truncate } from './format.ts';

const createElement = React.createElement;

export type Mode =
  | 'home'
  | 'main'
  | 'map'
  | 'char'
  | 'quests'
  | 'mail'
  | 'trade'
  | 'duels'
  | 'chat'
  | 'autopilot'
  | 'debug'
  | 'town';
/** Full screens that handle their own keys (global shortcuts still work unless they capture input). */
export const SCREEN_MODES: Mode[] = [
  'home',
  'char',
  'quests',
  'mail',
  'trade',
  'duels',
  'chat',
  'autopilot',
  'debug',
  'town',
];

/** g then a key: screens, overlays and rare actions (the nav bar shows the screens). */
export const GOTO: { key: string; label: string; help: string; mode?: Mode; overlay?: string }[] = [
  { key: 'h', label: 'home', mode: 'home', help: 'home: current job, rates, reports, chat' },
  { key: 'j', label: 'jobs', mode: 'main', help: 'jobs & queue' },
  { key: 'm', label: 'map', mode: 'map', help: 'map (also just m)' },
  { key: 'i', label: 'character', mode: 'char', help: 'character: inventory, equipment sets & skills' },
  { key: 't', label: 'town', mode: 'town', help: 'town: city hall, building levels & construction' },
  { key: 'q', label: 'quests', mode: 'quests', help: 'quests: log & quest givers' },
  { key: 'r', label: 'mail', mode: 'mail', help: 'mail: reports & telegrams' },
  { key: 'b', label: 'trade', mode: 'trade', help: 'trade: bank, shops, market, buy orders' },
  { key: 'd', label: 'duels', mode: 'duels', help: 'duels: NPCs & players' },
  { key: 'c', label: 'chat', mode: 'chat', help: 'full chat: rooms & whispers (needs live updates)' },
  { key: 'a', label: 'autopilot', mode: 'autopilot', help: 'autopilot: priorities, modules, projected queue' },
  {
    key: 'x',
    label: 'debug',
    mode: 'debug',
    help: 'debug: everything logged, planner input / output, live autopilot view',
  },
  { key: 's', label: 'sleep', overlay: 'hotel', help: 'sleep: hotel of your town (map: s on a selected town)' },
  { key: 'p', label: 'places', overlay: 'poi', help: 'points of interest (jump on map)' },
  { key: 'L', label: 'live on/off', help: 'live updates on / off' },
  { key: 'R', label: 'reload', help: 'reload game state (like F5)' },
  { key: 'A', label: 'account', help: 'account: fingerprint & login setup' },
];

const SHORTCUTS: Record<Mode | 'global', [string, string][]> = {
  global: [
    ['?', 'show / hide this help'],
    ['Esc', 'back: overlay, panel, then the previous screen'],
    ['m', 'map'],
    ['u', 'refresh (queue / inventory / quests)'],
    ['q', 'quit'],
    ...GOTO.map((group): [string, string] => [`g ${group.key}`, group.help]),
  ],
  home: [
    ['Enter', 'write in chat (Enter sends, Esc cancels)'],
    ['← →  h l', 'chat room'],
    ['c  Del', 'cancel the current task (confirm y)'],
    ['+  -', 'zoom the minimap'],
  ],
  main: [
    ['Tab', 'jobs ⇄ task queue'],
    ['↑ ↓  j k', 'move · PgUp/PgDn ×10'],
    ['/', 'filter jobs by name or product they drop'],
    ['S', 'sort jobs: name · XP · $ · luck ($ of best find) · distance'],
    ['a', 'show jobs without enough labor points'],
    ['1 2 3', 'start job: short / medium / long'],
    ['c  Del', 'cancel selected task (confirm y)'],
  ],
  map: [
    ['← ↑ → ↓  h j k l', 'pan · Shift / PgUp PgDn ×10'],
    ['+  -', 'zoom in / out'],
    ['.  c', 'centre on you · e on queue end'],
    ['/', 'find job or town, jump to nearest'],
    ['Enter', 'select things under the cursor'],
    ['1 2 3', '(selected job) start here'],
    ['w', '(town, fort, quest giver) walk there'],
    ['o', '(quest giver) show its quests'],
    ['x', 'clear quest job markers (!)'],
    ['v', 'map layers: choose what is drawn'],
    ['s', '(town) sleep in its hotel'],
    ['Esc', 'close the selection · back'],
  ],
  char: [
    ['← →', 'Inventory ⇄ Sets ⇄ Skills'],
    ['Tab', '(inventory) equipped ⇄ bag'],
    ['↑ ↓  j k', 'move · PgUp/PgDn ×10'],
    ['l  h', '(inventory) into the item detail (j k scroll) · back to the list'],
    ['Enter  e', '(bag) wear or use the selected item'],
    ['U', '(bag) use item: drinks, buffs, bags…'],
    ['Enter  x', '(equipped) take off'],
    ['Enter', '(sets) switch equipment set (y)'],
    ['S  R', '(sets) save current wear · replace selected set (y)'],
    ['/  t y', 'search bag · cycle item type'],
    ['+  -', '(skills) plan a point'],
    ['Enter', '(skills) save planned points (y)'],
    ['Esc', 'discard plan / back'],
  ],
  town: [
    ['↑ ↓  j k', 'choose a building · PgUp/PgDn ×10'],
    ['Enter', 'load construction detail and start a job'],
    ['u', 'refresh building levels'],
    ['Esc', 'back'],
  ],
  quests: [
    ['Tab', 'quest log ⇄ quest givers'],
    ['↑ ↓  j k', 'move (detail: scroll)'],
    ['l  h', 'into the detail / route · back to the list'],
    ['Enter', 'finish (log) · open / accept (givers)'],
    ['a', 'accept quest'],
    ['x', 'cancel quest (confirm y)'],
    ['w', 'walk to the quest giver'],
    ['v', 'mark jobs that drop needed items on the map'],
    ['R', 'route planner: best jobs for quest items'],
    ['a  x', 'route: autopilot for these quests (at the y/n prompt, g a to manage) · x stop old auto-route'],
    ['  1 2 3', 'route for this quest / its chain / all quests'],
    ['  e', 'optimize per energy ⇄ per time'],
    ['  Enter', 'queue the route (as many as fit, confirm y)'],
    ['  v', 'show route jobs on the map'],
    ['Esc', 'back'],
  ],
  mail: [
    ['Tab  ← →', 'reports ⇄ telegrams'],
    ['↑ ↓  j k', 'move (detail: scroll)'],
    ['Enter  l', 'read (focuses the message; h or Esc back to the list)'],
    ['< >', 'previous / next page'],
    ['f', '(reports) cycle category'],
    ['R', '(telegrams) reply'],
    ['n', 'write a new telegram'],
    ['d', 'delete (confirm y)'],
    ['Esc', 'close / back'],
  ],
  trade: [
    ['← →', 'bank · shops · market · my market'],
    ['Enter', 'deposit · buy · buy now / sell now · pick up'],
    ['Tab', '(shops, market) sell from your bag'],
    ['/', '(market) search: name, for sale / buy orders, category, level, usable, consumable'],
    ['t', '(market) switch between goods for sale and buy orders'],
    ['b', '(market) bid, or ask a price on a buy order'],
    ['n', '(market) place a buy order (item, amount, prices, days)'],
    ['w', "(market) walk to the offer's town"],
    ['< >', '(market) previous / next page'],
    ['x', '(my market) withdraw a running offer / buy order'],
    ['P', '(my market) pick up everything finished in this town'],
    ['Esc', 'back'],
  ],
  autopilot: [
    ['↑ ↓  j k', 'move'],
    ['Space  Enter', 'toggle a module or setting'],
    ['← →  + -', 'change a value'],
    ['J K', '(priority) move the goal down / up'],
    ['R', 'run / pause the autopilot'],
    ['X', 'stop: pause and clear the planned tasks (rules stay)'],
    ['Esc', 'back'],
  ],
  duels: [
    ['↑ ↓  j k', 'move'],
    ['Enter', 'NPC: fight now · player: queue a duel (confirm y)'],
    ['u', 'refresh'],
    ['Esc', 'back'],
  ],
  debug: [
    ['Tab', 'log ⇄ now (live: energy, HP, towns, bag, quests + distances)'],
    ['↑ ↓  j k', 'move (the newest is followed at the bottom) · PgUp/PgDn ×page'],
    ['e', 'follow the newest entry'],
    ['l  h', 'into the entry data (j k scroll) · back to the list'],
    ['f', 'category: all · log · state · request · autopilot · sim · quest'],
    ['/', 'filter by title (Enter keep, Esc clear)'],
    ['x', "clear the screen's list (files stay)"],
    ['Esc', 'back'],
  ],
  chat: [
    ['↑ ↓  j k', 'room / whisper conversation'],
    ['Enter', 'write a message (Enter sends, Esc cancels)'],
    ['t', 'whisper to a player'],
    ['Esc', 'back'],
  ],
};

const MODE_TITLE: Record<Mode, string> = {
  home: 'Home',
  main: 'Jobs & queue',
  map: 'Map',
  char: 'Character',
  quests: 'Quests',
  mail: 'Mail',
  trade: 'Trade',
  duels: 'Duels',
  chat: 'Chat',
  autopilot: 'Autopilot',
  debug: 'Debug',
  town: 'Town',
};

const LEGEND: [string, string, string][] = [
  ['@', 'green', 'you'],
  ['1-9', 'cyan', 'queued tasks'],
  ['H', 'cyan', 'home town'],
  ['T', 'white', 'town'],
  ['t', 'gray', 'empty town site'],
  ['F', 'red', 'fort'],
  ['?', 'magenta', 'quest giver'],
  ['*', 'yellowBright', 'gold/silver job'],
  ['j', 'yellow', 'job you can do (gray: not yet)'],
  ['!', 'magentaBright', 'job for the selected quest'],
  ['$', 'green', 'market'],
  ['&', 'magentaBright', 'travelling fair'],
  ['f', 'blue', 'friends'],
  ['p', 'blueBright', 'players'],
  ['┊┄', 'gray', 'county border'],
];

export function HelpOverlay({ mode, width, height }: { mode: Mode; width: number; height: number }) {
  const row =
    (prefix: string) =>
    ([key, date]: [string, string], index: number) =>
      createElement(
        Text,
        { key: `${prefix}${index}`, wrap: 'truncate' },
        createElement(Text, { color: 'yellow' }, key.padEnd(12)),
        date,
      );
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'double', borderColor: 'yellow', paddingX: 2, width, height },
    createElement(
      Text,
      { bold: true, color: 'yellow' },
      `Keyboard shortcuts · ${MODE_TITLE[mode].toLowerCase()}   (any key closes)`,
    ),
    createElement(Text, null, ' '),
    createElement(
      Box,
      { gap: 4 },
      createElement(
        Box,
        { flexDirection: 'column' },
        createElement(Text, { bold: true }, MODE_TITLE[mode]),
        ...SHORTCUTS[mode].map(row('m')),
      ),
      createElement(
        Box,
        { flexDirection: 'column' },
        createElement(Text, { bold: true }, 'Everywhere'),
        ...SHORTCUTS.global.map(row('g')),
      ),
      mode === 'map'
        ? createElement(
            Box,
            { flexDirection: 'column' },
            createElement(Text, { bold: true }, 'Map legend'),
            ...LEGEND.map(([ch, color, date], index) =>
              createElement(
                Text,
                { key: index, wrap: 'truncate' },
                createElement(Text, { color, bold: true }, ch.padEnd(5)),
                date,
              ),
            ),
          )
        : null,
    ),
  );
}

export function PoiOverlay(props: {
  state: GameState;
  pois: (Poi & { dist: number })[];
  selected: number;
  filter: string;
  width: number;
  height: number;
}) {
  const { state, pois, selected, filter, width, height } = props;
  const listRows = Math.max(3, height - 3);
  const start = Math.max(0, Math.min(selected - Math.floor(listRows / 2), pois.length - listRows));
  const travelPerPx = state.travelSpeed * state.character.speed;
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'double', borderColor: 'cyan', paddingX: 1, width, height },
    createElement(
      Text,
      { bold: true, color: 'cyan', wrap: 'truncate' },
      `Points of interest · ${pois.length}  ·  type to filter: ${filter}▏  ·  Enter jump · Esc close`,
    ),
    ...pois.slice(start, start + listRows).map((pick, index) => {
      const idx = start + index;
      const st = POI_STYLE[pick.kind];
      return createElement(
        Text,
        { key: idx, inverse: idx === selected, wrap: 'truncate' },
        createElement(Text, { color: st.color, bold: true }, ` ${st.ch} `),
        `${truncate(pick.label, Math.max(10, width - 40))} `,
        createElement(
          Text,
          { dimColor: true },
          `${st.name.padEnd(14)} ${formatDuration(pick.dist * travelPerPx).padStart(8)}`,
        ),
      );
    }),
    pois.length === 0 ? createElement(Text, { dimColor: true }, 'Nothing matches.') : null,
  );
}

export function HotelOverlay({
  state,
  hotel,
  selected,
  width,
  height,
}: {
  state: GameState;
  hotel: Hotel | null;
  selected: number;
  width: number;
  height: number;
}) {
  if (!hotel) {
    return createElement(
      Box,
      { borderStyle: 'double', borderColor: 'blue', paddingX: 2, width, height },
      createElement(Text, { color: 'yellow' }, 'Loading hotel…'),
    );
  }
  const character = state.character;
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'double', borderColor: 'blue', paddingX: 2, width, height },
    createElement(
      Text,
      { bold: true, color: 'blue' },
      `Hotel · ${hotel.townName} (level ${hotel.level})${hotel.own ? ' · your town' : ''}`,
    ),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      `Distance ${hotel.waytime || '—'} · Duration 8 hours${hotel.attackable ? ` · can be attacked until ${hotel.attackable}` : ''}`,
    ),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      `Now: energy ${character.energy}/${character.maxEnergy} · health ${character.health}/${character.maxHealth}`,
    ),
    createElement(Text, null, ' '),
    ...hotel.rooms.map((room, index) =>
      createElement(
        Text,
        defined({
          key: room.key,
          inverse: index === selected,
          color: room.available ? undefined : 'gray',
          wrap: 'truncate',
        }),
        `${'★'.repeat(room.level).padEnd(5)} ${truncate(room.name, 22)} ${`+${room.energy} energy`.padStart(11)} ${`+${room.health} HP`.padStart(9)}  `,
        createElement(Text, { color: room.free ? 'green' : 'yellow' }, room.free ? 'free' : money(room.costs)),
        room.available ? '' : '  (not available)',
      ),
    ),
    createElement(Text, null, ' '),
    createElement(Text, { dimColor: true }, 'Enter sleep here (queued like a job) · Esc close'),
  );
}
