// Full-screen TUI (ink, without JSX so Node can run the TypeScript directly).
// Layout: status header · screen nav bar · screen (home by default; jobs: list + details | task queue) · log · key help.

import { Box, render, Text, useApp, useInput, useWindowSize } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { defaultRoom } from '../game/hotel.ts';
import { DURATION_KEYS, type DurationKey, motivationFactor } from '../game/jobs.ts';
import { poisNear } from '../game/poi.ts';
import { type GameState, JOB_SORTS, type JobOption, type JobSort, type StartupStep } from '../game/state.ts';
import { defined } from '../util/defined.ts';
import { AutopilotScreen } from './autopilot.ts';
import { CharacterScreen } from './character.ts';
import { ChatScreen } from './chat.ts';
import { DebugScreen } from './debug.ts';
import { DuelsScreen } from './duels.ts';
import { bar, formatDuration, money, scrollWindow, truncate } from './format.ts';
import { HomeScreen } from './home.ts';
import { ICON } from './icons.ts';
import { MailScreen } from './mail.ts';
import {
  clampView,
  entriesAt,
  findNearest,
  LayersOverlay,
  MAP_LAYERS,
  MapScreen,
  type MapView,
  mapGridSize,
  ZOOMS,
} from './map.ts';
import { GOTO, HelpOverlay, HotelOverlay, type Mode, PoiOverlay, SCREEN_MODES } from './overlays.ts';
import { QuestsScreen } from './quests.ts';
import { QueuePane } from './queue.ts';
import { TownScreen } from './town.ts';
import { TradeScreen } from './trade.ts';

const createElement = React.createElement;
const QUEUE_POLL_MS = 60_000;
/** danger is only in job/job and motivation changes as jobs repeat; refresh the selected job. */
const JOB_DETAIL_POLL_MS = 60_000;
/** Full character re-read: other players' duels change health/money with no live push. */
const SYNC_MS = 3 * 60_000;

type Focus = 'jobs' | 'queue';
const LIVE_COLOR = { off: 'gray', connecting: 'yellow', on: 'green', error: 'red' } as const;

function useGameState(state: GameState): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onChange = () => setVersion((value) => value + 1);
    state.on('change', onChange);
    return () => {
      state.off('change', onChange);
    };
  }, [state]);
  return version;
}

function Header({ state }: { state: GameState }) {
  const character = state.character;
  const now = state.clock.now();
  const automation = state.hasAutomation
    ? `automation ${formatDuration(state.automationUntil - now)}`
    : 'no automation';
  const finishableQuests = state.quests.filter((quest) => quest.finishable).length;
  const event = state.event;
  const readyItems = event ? state.eventReadyItems() : [];
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
    createElement(
      Box,
      { justifyContent: 'space-between' },
      createElement(
        Text,
        { bold: true, color: 'yellow', wrap: 'truncate' },
        `${character.name}  lvl ${character.level} ${character.charClass}`,
      ),
      createElement(
        Text,
        { dimColor: true, wrap: 'truncate' },
        `${state.worldName} · ${automation} · `,
        createElement(Text, { color: LIVE_COLOR[state.liveStatus], dimColor: false }, `● live ${state.liveStatus}`),
        state.hasLoginBonus ? createElement(Text, { color: 'yellow' }, ' · daily bonus pending') : '',
        state.unread.reports ? createElement(Text, { color: 'yellow' }, ` · ${ICON.mail} new report (g r)`) : '',
        state.unread.messages ? createElement(Text, { color: 'yellow' }, ` · ${ICON.mail} new telegram (g r)`) : '',
        state.live?.unreadRooms.size
          ? createElement(Text, { color: 'cyan' }, ` · chat ${state.live.unreadRooms.size} (g c)`)
          : '',
        finishableQuests
          ? createElement(Text, { color: 'green' }, ` · ${ICON.quest} ${finishableQuests} quest(s) to finish`)
          : '',
        state.autoRoute
          ? createElement(Text, { color: 'magenta' }, ` · auto-route ${state.autoRoute.runs.length} left`)
          : '',
        state.autopilot.config.running ? createElement(Text, { color: 'green' }, ' · autopilot ●') : '',
        state.busy ? ' · working…' : '',
      ),
    ),
    createElement(Text, null, ' '),
    createElement(
      Text,
      { wrap: 'truncate' },
      createElement(Text, { color: 'red' }, 'HP '),
      `${bar(character.health, character.maxHealth, 10)} ${character.health}/${character.maxHealth}   `,
      createElement(Text, { color: 'cyan' }, 'EN '),
      `${bar(character.energy, character.maxEnergy, 10)} ${character.energy}/${character.maxEnergy}   `,
      createElement(Text, { color: 'green' }, 'XP '),
      xpText(character),
      createElement(Text, { color: 'green' }, money(character.cash)),
      ` bank ${money(character.deposit)}   `,
      createElement(Text, { dimColor: true }, `pos ${character.position.x},${character.position.y}`),
      state.lastSync
        ? createElement(
            Text,
            { dimColor: true },
            ` · synced ${formatDuration(Math.floor((Date.now() - state.lastSync) / 1000))} ago`,
          )
        : '',
    ),
    event ? createElement(Text, null, ' ') : null,
    event
      ? createElement(
          Text,
          { wrap: 'truncate' },
          createElement(Text, { color: 'magenta', bold: true }, event.name),
          '  ',
          bar(event.points, event.next?.at ?? Math.max(1, event.points), 10),
          ' ',
          `${event.points.toLocaleString('en-US')}${
            event.next
              ? ` / ${event.next.at.toLocaleString('en-US')} · ${(event.next.at - event.points).toLocaleString('en-US')} to next`
              : ' · all rewards reached'
          }`,
          readyItems.length
            ? createElement(
                Text,
                { color: 'green' },
                ` · ${readyItems.map((item) => `${item.name}${item.amount ? ` +${item.amount}` : ''}`).join(', ')} ready`,
              )
            : '',
        )
      : null,
  );
}

/** XP within the level: bar, have/need and percent (the web's XP bar, Character.getExperience4Level). */
function xpText(character: GameState['character']): string {
  const progress = character.progress;
  if (progress.maxed) {
    return `${character.experience} (max level)   `;
  }
  return `${bar(progress.have, progress.need, 10)} ${progress.have}/${progress.need} ${Math.floor(progress.ratio * 100)}%   `;
}

const SORT_LABEL: Record<JobSort, string> = { name: 'name', xp: 'XP', money: '$', luck: 'luck', distance: 'distance' };

/** The footer's key hints for the current screen, in priority order. */
function helpFor(context: {
  leader: boolean;
  filtering: boolean;
  searching: boolean;
  mode: Mode;
  mapPanel: boolean;
  hasMapHighlight: boolean;
  onScreen: boolean;
}): string {
  if (context.leader) {
    return `go to: a letter above · ${GOTO.filter((goTo) => !goTo.mode)
      .map((goTo) => `${goTo.key} ${goTo.label}`)
      .join(' · ')} · Esc cancel`;
  }
  if (context.filtering) {
    return 'type to filter · Enter keep · Esc clear';
  }
  if (context.searching) {
    return 'type a job or town name · Enter jump to nearest · Esc cancel';
  }
  if (context.mode === 'map') {
    return context.mapPanel
      ? '↑↓ select · 1/2/3 start job · w walk · o quests · s hotel · Esc back · ? help'
      : `arrows pan · +/- zoom · . me · / find · v layers · Enter select${context.hasMapHighlight ? ' · x clear !' : ''}`;
  }
  if (context.mode === 'char') {
    return '← → tab · Tab pane · l/h detail · Enter wear/use/take off · U use · +/- skills · Esc back · ? help';
  }
  if (context.mode === 'quests') {
    return 'Tab log/givers · l/h detail · Enter finish/accept · x cancel · w walk · Esc back · ? help';
  }
  if (context.mode === 'town') {
    return '↑↓ building · Enter construction · u refresh · Esc back · ? help';
  }
  if (context.mode === 'home') {
    return 'Enter chat · ←/→ room · c cancel current · +/- minimap · g go to · ? help';
  }
  if (context.onScreen) {
    return 'g go to · Esc back · ? help';
  }
  return 'Tab pane · / filter · S sort · a all · 1/2/3 start · c cancel · Esc back';
}

/** Columns after the name: XP and $ of the longest duration (when wide enough), luck when sorted by it, LP, travel. */
function jobCells(state: GameState, option: JobOption, columns: { wide: boolean; sortedByLuck: boolean }): string {
  const values = state.jobValues(option);
  const jobInfo = values.long ?? values.middle ?? values.short;
  const travel = option.way === null ? '—' : formatDuration(option.way);
  const xp = option.pendingSpecial ? '…' : jobInfo ? `${jobInfo.experience}xp` : '';
  const cash = option.pendingSpecial ? '…' : jobInfo ? money(jobInfo.money) : '';
  return [
    columns.wide ? xp.padStart(6) : null,
    columns.wide ? cash.padStart(7) : null,
    columns.sortedByLuck ? money(option.job.luckValue[1]).padStart(7) : null,
    String(option.job.laborPoints).padStart(5),
    travel.padStart(7),
  ]
    .filter((column) => column !== null)
    .join(' ');
}

function JobsPane(props: {
  state: GameState;
  options: JobOption[];
  selected: number;
  focused: boolean;
  height: number;
  width: number;
  filter: string;
  filtering: boolean;
  sort: JobSort;
  showAll: boolean;
}) {
  const { state, options, selected, focused, height, width, filter, filtering, sort, showAll } = props;
  const listHeight = Math.max(3, height - 5);
  const [start, end] = scrollWindow(selected, options.length, listHeight);
  const luck = sort === 'luck';
  // Inner width − marker − LP and travel (with spaces) − luck − xp and $.
  const fixed = 4 + 2 + 14 + (luck ? 8 : 0);
  const wide = width - fixed - 15 >= 14;
  const otherName = Math.max(8, width - fixed - (wide ? 15 : 0));
  const quest = state.mapHighlight?.jobIds;
  const title = filtering ? `Jobs  /${filter}▏` : filter ? `Jobs  (filter: ${filter})` : 'Jobs';
  const head = `  ${'job'.padEnd(otherName)} ${[wide ? 'xp'.padStart(6) : null, wide ? '$'.padStart(7) : null, luck ? 'luck'.padStart(7) : null, 'LP'.padStart(5), 'travel'.padStart(7)].filter(Boolean).join(' ')}`;
  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: focused ? 'cyan' : 'gray',
      width,
      height,
      paddingX: 1,
    },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `${title}  ${options.length ? `${selected + 1}/${options.length}` : ''}`,
    ),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      `sort: ${SORT_LABEL[sort]} (S) · ${showAll ? 'all jobs' : 'enough LP only'} (a) · xp/$ for the longest run${quest?.size ? ` · ! ${state.mapHighlight?.label ?? ''}` : ''}`,
    ),
    createElement(Text, { dimColor: true, wrap: 'truncate' }, head),
    ...options.slice(start, end).map((optionsValue, index) => {
      const idx = start + index;
      const sel = idx === selected;
      const doable = optionsValue.job.jobPoints >= optionsValue.job.workPoints;
      const mark = optionsValue.special
        ? createElement(
            Text,
            { color: optionsValue.special === 'gold' ? 'yellowBright' : 'whiteBright', bold: true },
            '* ',
          )
        : quest?.has(optionsValue.job.id)
          ? createElement(Text, { color: 'magentaBright', bold: true }, '! ')
          : '  ';
      return createElement(
        Text,
        defined({
          key: `${optionsValue.job.id}:${optionsValue.at?.x ?? 0},${optionsValue.at?.y ?? 0}`,
          inverse: sel && focused,
          color: doable ? undefined : 'gray',
          wrap: 'truncate',
        }),
        mark,
        `${truncate(optionsValue.job.name, otherName).padEnd(otherName)} ${jobCells(state, optionsValue, { wide, sortedByLuck: luck })}`,
      );
    }),
    options.length === 0 ? createElement(Text, { dimColor: true }, emptyJobsMessage(filter, showAll)) : null,
  );
}

function emptyJobsMessage(filter: string, showAll: boolean): string {
  return filter ? `No job matches the filter${showAll ? '' : ' (a shows jobs without enough LP)'}.` : 'Loading jobs…';
}

function JobDetail({ option, state }: { option: JobOption | undefined; state: GameState }) {
  if (!option) {
    return createElement(
      Box,
      { borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      createElement(Text, { dimColor: true }, 'No job selected'),
    );
  }
  const { job, at, way } = option;
  const values = state.jobValues(option);
  const rewardTier = motivationFactor(job.motivation);
  const best = values.long ?? values.middle ?? values.short;
  const danger = job.danger === null ? '—' : `${job.danger}%`;
  const durRows = DURATION_KEYS.map((entryKey, index) => {
    const jobInfo = values[entryKey];
    if (!jobInfo) {
      return null;
    }
    return createElement(
      Text,
      { key: entryKey, wrap: 'truncate' },
      createElement(Text, { color: 'yellow' }, `[${index + 1}] `),
      `${formatDuration(jobInfo.duration).padStart(7)} ${String(jobInfo.energy).padStart(3)}en ${money(jobInfo.money).padStart(6)} ${String(jobInfo.experience).padStart(4)}xp`,
      jobInfo.energy
        ? createElement(Text, { dimColor: true }, `  ${(jobInfo.experience / jobInfo.energy).toFixed(1)} xp/en`)
        : '',
    );
  });
  const quest = state.mapHighlight?.jobIds.has(job.id) ? state.mapHighlight.label : '';
  const luckChance = best && best.luck > 0 ? ` · ${(best.luck * 100).toFixed(1)}% chance` : '';
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexShrink: 0 },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `${job.name}  (lvl ${job.level})${option.special ? `  · ${option.special === 'gold' ? 'GOLD' : 'SILVER'} JOB` : ''}`,
    ),
    createElement(
      Text,
      { wrap: 'truncate' },
      `${job.laborPoints} LP · motiv ${Math.round(job.motivation * 100)}% · rewards ${Math.round(rewardTier * 100)}% · danger ${danger}`,
    ),
    option.pendingSpecial
      ? createElement(Text, { dimColor: true, wrap: 'truncate' }, `Loading ${option.special} values…`)
      : null,
    option.special
      ? createElement(
          Text,
          { color: option.special === 'gold' ? 'yellowBright' : 'whiteBright', wrap: 'truncate' },
          `${option.special === 'gold' ? '+100' : '+50'}% XP, $ and product drops`,
        )
      : null,
    createElement(
      Text,
      { wrap: 'truncate' },
      createElement(Text, { color: 'yellow' }, 'Luck '),
      job.luckValue[1] > 0 ? `${money(job.luckValue[0])}–${money(job.luckValue[1])}${luckChance}` : '—',
    ),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      at ? `at ${at.x},${at.y} · travel ${formatDuration(way ?? 0)}` : 'No location known',
    ),
    ...durRows,
    createElement(
      Text,
      { color: 'magenta', wrap: 'truncate' },
      `Drops: ${
        state
          .jobProducts(job, values)
          .map((pick) => `${pick.name}${pick.percent !== null ? ` ${pick.percent}%` : ''}`)
          .join(' · ') || '—'
      }`,
    ),
    quest ? createElement(Text, { color: 'magentaBright', wrap: 'truncate' }, `! needed for ${quest}`) : null,
    state.queue.length >= state.taskLimit
      ? createElement(Text, { color: 'red', wrap: 'truncate' }, `Queue full (${state.queue.length}/${state.taskLimit})`)
      : null,
  );
}

function LogPane({ state, lines }: { state: GameState; lines: number }) {
  const entries = state.log.slice(-lines);
  return createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    ...entries.map((entry, index) =>
      createElement(
        Text,
        defined({
          key: index,
          color: entry.level === 'error' ? 'red' : undefined,
          dimColor: entry.level === 'info',
          wrap: 'truncate',
        }),
        `${entry.at.toLocaleTimeString()}  ${entry.msg}`,
      ),
    ),
  );
}

export function App({
  state,
  size,
  onAccount,
}: {
  state: GameState;
  size?: { columns: number; rows: number };
  onAccount?: () => void;
}) {
  useGameState(state);
  const { exit } = useApp();
  const win = useWindowSize();
  const { columns, rows } = size ?? win;
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>('home');
  /** Screens Esc goes back through (a screen appears at most once, so going back never loops). */
  const history = useRef<Mode[]>([]);
  /** g was pressed: the next key picks a screen or action from GOTO. */
  const [leader, setLeader] = useState(false);
  const [overlay, setOverlay] = useState<null | 'help' | 'poi' | 'hotel' | 'layers'>(null);
  const [layerSel, setLayerSel] = useState(0);
  const [hotelSel, setHotelSel] = useState(0);
  const [questsOnGivers, setQuestsOnGivers] = useState(false);
  const capture = useRef(false);
  const [focus, setFocus] = useState<Focus>('jobs');
  const [jobSel, setJobSel] = useState(0);
  const [queueSel, setQueueSel] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [jobSort, setJobSort] = useState<JobSort>('name');
  const [showAllJobs, setShowAllJobs] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [view, setView] = useState<MapView>(() => ({ ...state.character.position, zoom: 128 }));
  const [mapPanel, setMapPanel] = useState(false);
  const [mapSel, setMapSel] = useState(0);
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [poiSel, setPoiSel] = useState(0);
  const [poiFilter, setPoiFilter] = useState('');

  // 1 s ticker: countdowns, regen, local task completion (like TaskQueueUi.tick); poll queue.
  useEffect(() => {
    let lastPoll = Date.now();
    let lastSync = Date.now();
    let lastTick = Date.now();
    let pausedUntil = 0;
    const timer = setInterval(() => {
      // Back from sleep: the Root's WakeDetector rebuilds everything within ~2 s; don't act on the
      // stale session/queue meanwhile (an auto-route step could queue against an old queue).
      const now = Date.now();
      if (now - lastTick > 30_000) {
        pausedUntil = now + 5_000;
      }
      lastTick = now;
      if (now < pausedUntil) {
        return;
      }
      const finished = state.tick();
      if (Date.now() - Math.max(lastSync, state.lastSync) > SYNC_MS) {
        lastSync = lastPoll = Date.now();
        void state.syncCharacter();
      } else if (finished || Date.now() - lastPoll > QUEUE_POLL_MS) {
        lastPoll = Date.now();
        void state.refreshQueue();
      } else if (state.autoRoute && !state.autopilot.config.running) {
        void state.autoRouteStep();
      }
      void state.runner.step(); // replans on change (also while paused); acts only when running
      setTick((time) => time + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [state]);

  // Map: once the cursor rests for a second, load tile details around it (as the browser does
  // for the visible area) when zoomed in far enough for them to matter.
  useEffect(() => {
    if (mode !== 'map' || view.zoom > 256) {
      return;
    }
    const target = setTimeout(() => void state.loadTilesAround(view), 1000);
    return () => clearTimeout(target);
  }, [state, mode, view.x, view.y, view.zoom]);

  const width = columns || 100;
  const height = rows || 30;
  // Home and jobs show twice the log (finished jobs, drops, item uses, autopilot actions).
  const logLines = (height >= 32 ? 5 : 3) * ((mode === 'main' || mode === 'home') && !overlay ? 2 : 1);
  // Header: two data lines with blank separators, plus an event line while one is active.
  const bodyH = Math.max(10, height - (state.event ? 7 : 5) - 1 - logLines - 1);
  const grid = mapGridSize(width, bodyH);

  const options = useMemo(
    () => state.jobOptions(filter, { sort: jobSort, showAll: showAllJobs }),
    [
      state,
      state.jobs,
      state.jobsVersion,
      state.specialVersion,
      state.world,
      state.items,
      state.queue.length,
      filter,
      jobSort,
      showAllJobs,
    ],
  );
  const jobIdx = Math.min(jobSel, Math.max(0, options.length - 1));
  const queueIdx = Math.min(queueSel, Math.max(0, state.queue.length - 1));

  // The job list (work/index) has no danger and stale motivation. Fetch the selected job's
  // job/job detail when the selection changes, when the queue changes, and once a minute.
  useEffect(() => {
    const selected = options[jobIdx];
    if (mode !== 'main' || !selected?.at) {
      return;
    }
    const { job, at } = selected;
    const timer = setTimeout(() => void state.loadJobDetail(job, at), 300);
    const poll = setInterval(() => void state.loadJobDetail(job, at), JOB_DETAIL_POLL_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [
    state,
    mode,
    options[jobIdx]?.job.id,
    options[jobIdx]?.at?.x,
    options[jobIdx]?.at?.y,
    state.jobs,
    state.queue.length,
  ]);

  const entries = mode === 'map' ? entriesAt(state, view, grid.cols, grid.rows) : [];
  const mapIdx = Math.min(mapSel, Math.max(0, entries.length - 1));
  const pois = overlay === 'poi' ? poisNear(state, view, poiFilter) : [];
  const poiIdx = Math.min(poiSel, Math.max(0, pois.length - 1));

  const go = (match: Mode) => {
    capture.current = false;
    setMapPanel(false);
    if (match === mode) {
      return;
    }
    const index = history.current.indexOf(match);
    if (index >= 0) {
      history.current.length = index;
    } else {
      history.current.push(mode);
    }
    setMode(match);
  };
  const back = () => {
    capture.current = false;
    setMapPanel(false);
    setMode(history.current.pop() ?? 'home');
  };
  const jumpTo = (at: { x: number; y: number }) => {
    setView((value) => clampView({ ...value, x: at.x, y: at.y, zoom: Math.min(value.zoom, 128) }));
    go('map');
    setMapSel(0);
  };

  const openHotel = (townId: number | undefined) => {
    if (!townId) {
      return state.error('No town to sleep in (you have no home town; select a town on the map and press s).');
    }
    state.hotel = null;
    setHotelSel(0);
    setOverlay('hotel');
    void state.openHotel(townId).then((hotel) => {
      if (!hotel) {
        return setOverlay(null);
      }
      const roomInfo = defaultRoom(hotel);
      setHotelSel(Math.max(0, roomInfo ? hotel.rooms.indexOf(roomInfo) : 0));
    });
  };

  const onScreen = SCREEN_MODES.includes(mode);
  useInput((input, key) => {
    state.touch();
    if (state.startup && !state.startup.done) {
      if (key.escape) {
        state.skipStartup();
      }
      if (input === 'q') {
        exit();
      }
      return;
    }
    // Text entry modes first, so typed characters are not shortcuts.
    if (overlay === 'hotel') {
      const rooms = state.hotel?.rooms ?? [];
      if (key.escape) {
        return setOverlay(null);
      }
      if (key.upArrow || input === 'k') {
        return setHotelSel((index) => Math.max(0, index - 1));
      }
      if (key.downArrow || input === 'j') {
        return setHotelSel((index) => Math.min(rooms.length - 1, index + 1));
      }
      if (key.return && state.hotel) {
        const room = rooms[hotelSel];
        if (!room) {
          return;
        }
        if (!room.available) {
          return state.error(`${room.name} is not available in this hotel.`);
        }
        setOverlay(null);
        return void state.sleep(state.hotel, room);
      }
      return;
    }
    if (overlay === 'layers') {
      if (key.escape || input === 'v') {
        return setOverlay(null);
      }
      if (key.upArrow || input === 'k') {
        return setLayerSel((index) => Math.max(0, index - 1));
      }
      if (key.downArrow || input === 'j') {
        return setLayerSel((index) => Math.min(MAP_LAYERS.length - 1, index + 1));
      }
      const line = MAP_LAYERS[layerSel];
      if (!line) {
        return;
      }
      if (input === ' ' || key.return) {
        return state.setMapLayer(line.key, state.mapLayers[line.key] === false);
      }
      if (input === 'a' || input === 'n') {
        for (const xCoord of MAP_LAYERS) {
          state.setMapLayer(xCoord.key, input === 'a');
        }
      }
      return;
    }
    if (onScreen && capture.current && overlay !== 'help') {
      return;
    }
    if (overlay === 'poi') {
      if (key.escape) {
        return setOverlay(null);
      }
      if (key.return) {
        const pick = pois[poiIdx];
        setOverlay(null);
        if (pick) {
          jumpTo(pick);
        }
        return;
      }
      if (key.upArrow) {
        return setPoiSel(Math.max(0, poiIdx - 1));
      }
      if (key.downArrow) {
        return setPoiSel(Math.min(pois.length - 1, poiIdx + 1));
      }
      if (key.pageUp) {
        return setPoiSel(Math.max(0, poiIdx - 10));
      }
      if (key.pageDown) {
        return setPoiSel(Math.min(pois.length - 1, poiIdx + 10));
      }
      if (key.backspace || key.delete) {
        return setPoiFilter((text) => text.slice(0, -1));
      }
      if (input && !key.ctrl && !key.meta) {
        setPoiFilter((text) => text + input);
        setPoiSel(0);
      }
      return;
    }
    if (overlay === 'help') {
      return setOverlay(null);
    }
    if (filtering) {
      if (key.return || key.escape) {
        setFiltering(false);
      }
      if (key.escape) {
        setFilter('');
      } else if (key.backspace || key.delete) {
        setFilter((text) => text.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && !key.return) {
        setFilter((text) => text + input);
      }
      setJobSel(0);
      return;
    }
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setSearch('');
      } else if (key.return) {
        setSearching(false);
        const hit = findNearest(state, search, view);
        if (hit) {
          jumpTo(hit.at);
          state.info(`Found ${hit.label} at ${hit.at.x},${hit.at.y}`);
        } else {
          state.error(`Nothing on the map matches "${search}"`);
        }
      } else if (key.backspace || key.delete) {
        setSearch((text) => text.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setSearch((text) => text + input);
      }
      return;
    }
    if (confirmCancel) {
      if (input === 'y') {
        void state.cancel(queueIdx);
      }
      setConfirmCancel(false);
      return;
    }

    if (leader) {
      setLeader(false);
      const found = GOTO.find((xCoord) => xCoord.key === input);
      if (found?.mode === 'quests') {
        setQuestsOnGivers(false);
      }
      if (found?.mode) {
        return go(found.mode);
      }
      if (found?.key === 's') {
        return openHotel(state.character.homeTown?.id);
      }
      if (found?.key === 'p') {
        setPoiFilter('');
        setPoiSel(0);
        return setOverlay('poi');
      }
      if (found?.key === 'L') {
        return state.live?.active ? state.stopLive() : state.startLive();
      }
      if (found?.key === 'R') {
        return void state.reload();
      }
      if (found?.key === 'A' && onAccount) {
        return onAccount();
      }
      return; // Esc or an unknown key cancels
    }

    // Global shortcuts: everything else is under g, so screens keep the letters.
    if (input === '?') {
      return setOverlay('help');
    }
    if (input === 'q') {
      return exit();
    }
    if (input === 'g') {
      return setLeader(true);
    }
    if (input === 'm') {
      return go('map');
    }
    if (input === 'u') {
      if (mode === 'char') {
        return void state
          .refreshInventory()
          .then(() => state.refreshSkills())
          .then(() => state.loadEquipSets());
      }
      if (mode === 'quests') {
        return void state.loadQuests();
      }
      if (mode === 'mail') {
        return void state
          .loadReports(state.reports?.page ?? 1)
          .then(() => state.loadTelegrams(state.telegrams?.page ?? 1));
      }
      if (mode === 'duels') {
        return void state.loadDuels();
      }
      if (mode === 'trade') {
        return void state.loadMarketMine().then(() => state.openMobileTrader());
      }
      if (mode === 'town') {
        return void state.loadTownHall();
      }
      return void state.refreshQueue();
    }
    if (onScreen) {
      return; // the screen handles the rest
    }
    const duration = ({ '1': 'short', '2': 'middle', '3': 'long' } as Record<string, DurationKey>)[input];

    if (mode === 'map') {
      if (mapPanel) {
        if (key.escape) {
          return setMapPanel(false);
        }
        if (key.upArrow || input === 'k') {
          return setMapSel(Math.max(0, mapIdx - 1));
        }
        if (key.downArrow || input === 'j') {
          return setMapSel(Math.min(entries.length - 1, mapIdx + 1));
        }
        const entry = entries[mapIdx];
        if (duration && entry?.kind === 'job') {
          return void state.startJob(entry.option, duration);
        }
        if (input === 'w' && entry?.kind === 'town') {
          return void state.walkToTown(entry.town);
        }
        if (input === 'w' && entry?.kind === 'fort') {
          return void state.walkToFort(entry.fort);
        }
        if (input === 'w' && entry?.kind === 'quest') {
          return void state.walkToQuestGiver(entry.key, entry.name, entry.at);
        }
        if (input === 's') {
          return openHotel(entry?.kind === 'town' && entry.town.name ? entry.town.id : state.character.homeTown?.id);
        }
        if (input === 'o' && entry?.kind === 'quest') {
          return void state.openEmployer(entry.key, entry.at).then((ok) => {
            if (!ok) {
              return;
            }
            setQuestsOnGivers(true);
            go('quests');
          });
        }
        return;
      }
      if (key.escape) {
        return back();
      }
      const big = key.shift || key.pageUp || key.pageDown ? 10 : 1;
      const pan = (dc: number, dr: number) =>
        setView((value) =>
          clampView({ ...value, x: value.x + dc * big * value.zoom, y: value.y + dr * big * value.zoom * 2 }),
        );
      if (key.leftArrow || input === 'h' || input === 'H') {
        return pan(-1, 0);
      }
      if (key.rightArrow || input === 'l' || input === 'L') {
        return pan(1, 0);
      }
      if (key.upArrow || key.pageUp || input === 'k' || input === 'K') {
        return pan(0, -1);
      }
      if (key.downArrow || key.pageDown || input === 'j' || input === 'J') {
        return pan(0, 1);
      }
      if (input === '+' || input === '=') {
        return setView((value) => ({
          ...value,
          zoom: ZOOMS[Math.max(0, ZOOMS.indexOf(value.zoom) - 1)] ?? value.zoom,
        }));
      }
      if (input === '-' || input === '_') {
        return setView((value) => ({
          ...value,
          zoom: ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(value.zoom) + 1)] ?? value.zoom,
        }));
      }
      if (input === '.' || input === 'c') {
        return setView((value) => ({ ...value, ...state.character.position }));
      }
      if (input === 'e') {
        return setView((value) => ({ ...value, ...state.queueEndPosition }));
      }
      if (input === 'v') {
        return setOverlay('layers');
      }
      if (input === '/') {
        setSearch('');
        return setSearching(true);
      }
      if (key.return && entries.length) {
        setMapSel(0);
        return setMapPanel(true);
      }
      if (input === 'x' && state.mapHighlight) {
        state.mapHighlight = null;
        return state.changed();
      }
      return;
    }

    if (key.escape) {
      return back();
    }
    if (key.tab) {
      return setFocus((value) => (value === 'jobs' ? 'queue' : 'jobs'));
    }
    const move = (value: number) => {
      if (focus === 'jobs') {
        setJobSel(Math.max(0, Math.min(options.length - 1, jobIdx + value)));
      } else {
        setQueueSel(Math.max(0, Math.min(state.queue.length - 1, queueIdx + value)));
      }
    };
    if (key.upArrow || input === 'k') {
      return move(-1);
    }
    if (key.downArrow || input === 'j') {
      return move(1);
    }
    if (key.pageUp) {
      return move(-10);
    }
    if (key.pageDown) {
      return move(10);
    }
    if (focus === 'jobs') {
      if (input === '/') {
        return setFiltering(true);
      }
      if (input === 'S' || input === 'O') {
        setJobSel(0);
        return setJobSort((cur) => JOB_SORTS[(JOB_SORTS.indexOf(cur) + 1) % JOB_SORTS.length] ?? cur);
      }
      if (input === 'a') {
        setJobSel(0);
        return setShowAllJobs((flag) => !flag);
      }
      const option = options[jobIdx];
      if (duration && option) {
        return void state.startJob(option, duration);
      }
    } else if ((input === 'c' || key.delete) && state.queue[queueIdx]) {
      setConfirmCancel(true);
    }
  });

  const leftW = Math.max(30, Math.floor(width * 0.5));
  const rightW = Math.max(24, width - leftW);
  // JobDetail: 2 border + 4 info lines + 3 durations (+1 when the queue is full, +1 for a quest job).
  const highlighted = options[jobIdx];
  const detailH =
    10 +
    (state.queue.length >= state.taskLimit ? 1 : 0) +
    (highlighted && state.mapHighlight?.jobIds.has(highlighted.job.id) ? 1 : 0);
  const help = helpFor({
    leader,
    filtering,
    searching,
    mode,
    mapPanel,
    hasMapHighlight: !!state.mapHighlight,
    onScreen,
  });

  let body: React.ReactElement | null;
  if (overlay === 'help') {
    body = createElement(HelpOverlay, { mode, width, height: bodyH });
  } else if (overlay === 'layers') {
    body = createElement(
      Box,
      { height: bodyH },
      createElement(MapScreen, {
        state,
        view,
        width: width - Math.min(52, width),
        height: bodyH,
        entries: [],
        selected: 0,
        panelFocused: false,
        search: '',
        searching: false,
      }),
      createElement(LayersOverlay, { state, selected: layerSel, width, height: bodyH }),
    );
  } else if (overlay === 'poi') {
    body = createElement(PoiOverlay, { state, pois, selected: poiIdx, filter: poiFilter, width, height: bodyH });
  } else if (overlay === 'hotel') {
    body = createElement(HotelOverlay, { state, hotel: state.hotel, selected: hotelSel, width, height: bodyH });
  } else if (onScreen) {
    body = null;
  } else if (mode === 'map') {
    body = createElement(MapScreen, {
      state,
      view,
      width,
      height: bodyH,
      entries,
      selected: mapIdx,
      panelFocused: mapPanel,
      search,
      searching,
    });
  } else {
    body = createElement(
      Box,
      { height: bodyH },
      createElement(JobsPane, {
        state,
        options,
        selected: jobIdx,
        focused: focus === 'jobs',
        height: bodyH,
        width: leftW,
        filter,
        filtering,
        sort: jobSort,
        showAll: showAllJobs,
      }),
      createElement(
        Box,
        { flexDirection: 'column', width: rightW },
        createElement(JobDetail, { option: options[jobIdx], state }),
        createElement(QueuePane, {
          state,
          selected: queueIdx,
          focused: focus === 'queue',
          width: rightW,
          confirm: confirmCancel,
          maxRows: Math.max(1, bodyH - detailH - 3),
        }),
      ),
    );
  }

  // Character/quest screens stay mounted under overlays so planned points or selections survive '?'.
  let screen = null;
  if (onScreen) {
    const props = {
      state,
      width,
      height: bodyH,
      active: !overlay,
      onCapture: (flag: boolean) => (capture.current = flag),
      onExit: back,
    };
    const el =
      mode === 'home'
        ? createElement(HomeScreen, props)
        : mode === 'char'
          ? createElement(CharacterScreen, props)
          : mode === 'quests'
            ? createElement(QuestsScreen, { ...props, startOnGivers: questsOnGivers, onShowOnMap: jumpTo })
            : mode === 'mail'
              ? createElement(MailScreen, props)
              : mode === 'trade'
                ? createElement(TradeScreen, props)
                : mode === 'duels'
                  ? createElement(DuelsScreen, props)
                  : mode === 'autopilot'
                    ? createElement(AutopilotScreen, props)
                    : mode === 'debug'
                      ? createElement(DebugScreen, props)
                      : mode === 'town'
                        ? createElement(TownScreen, props)
                        : createElement(ChatScreen, props);
    screen = createElement(Box, { display: overlay ? 'none' : 'flex' }, el);
  }

  if (state.startup && !state.startup.done) {
    return createElement(LoadingScreen, { state, width, height });
  }

  return createElement(
    Box,
    { flexDirection: 'column', width, height },
    createElement(Header, { state }),
    createElement(NavBar, { mode, overlay, leader, width }),
    body,
    screen,
    createElement(LogPane, { state, lines: logLines }),
    createElement(Text, { dimColor: true, wrap: 'truncate' }, ` ${help}`),
  );
}

/** The g menu's screens (and sleep / places), each with its second key; the open screen is inverted. */
function NavBar({
  mode,
  overlay,
  leader,
  width,
}: {
  mode: Mode;
  overlay: string | null;
  leader: boolean;
  width: number;
}) {
  const items = GOTO.filter((group) => group.mode || group.overlay).map((group) => ({
    ...group,
    active: overlay ? group.overlay === overlay : group.mode === mode,
  }));
  return createElement(
    Box,
    { width, paddingX: 1 },
    createElement(
      Text,
      { wrap: 'truncate' },
      createElement(Text, { bold: true, inverse: leader, color: 'yellow' }, leader ? ' go to › ' : 'g›'),
      ...items.flatMap((count, index) => [
        createElement(Text, { key: `s${index}` }, '  '),
        createElement(
          Text,
          defined({ key: count.label, inverse: count.active, color: count.active ? 'cyan' : undefined }),
          createElement(Text, defined({ bold: true, color: count.active ? undefined : 'yellow' }), `${count.key} `),
          createElement(Text, { dimColor: !count.active && !leader }, count.label),
        ),
      ]),
      createElement(Text, { dimColor: true }, '   '),
      createElement(Text, { bold: true, color: 'yellow', inverse: overlay === 'help' }, '?'),
      createElement(Text, { dimColor: true }, ' help'),
    ),
  );
}

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** First start: what is being loaded, until the major requests are done (Esc skips, q quits). */
function LoadingScreen({ state, width, height }: { state: GameState; width: number; height: number }) {
  const character = state.character;
  return createElement(LoadingFrame, {
    width,
    height,
    subtitle: `${character.name ?? ''}${state.worldName ? ` · ${state.worldName}` : ''}${character.level ? ` · level ${character.level}` : ''}`,
    steps: state.startup?.steps ?? [],
    latest: state.log.filter((line) => line.level === 'info').slice(-1)[0]?.msg,
    errors: state.log
      .filter((line) => line.level === 'error')
      .slice(-3)
      .map((entry) => entry.msg),
    keys: 'Esc skip · q quit',
  });
}

/** The loading screen's box: title, startup steps with spinner and timings, last message, errors. Root uses it while connecting. */
export function LoadingFrame({
  width,
  height,
  subtitle,
  steps,
  latest,
  errors = [],
  keys,
}: {
  width: number;
  height: number;
  subtitle?: string | undefined;
  steps: StartupStep[];
  latest?: string | undefined;
  errors?: string[] | undefined;
  keys: string;
}) {
  const frame = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length];
  return createElement(
    Box,
    { width, height, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
    createElement(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: 'yellow',
        paddingX: 2,
        paddingY: 1,
        width: Math.min(60, width - 2),
      },
      createElement(Text, { bold: true, color: 'yellow' }, 'The West'),
      createElement(Text, { dimColor: true, wrap: 'truncate' }, subtitle ?? ''),
      createElement(Text, null, ' '),
      ...steps.map((source, index) =>
        createElement(
          Text,
          {
            key: index,
            wrap: 'truncate',
            color: source.status === 'error' ? 'red' : source.status === 'done' ? 'green' : 'cyan',
          },
          `${source.status === 'running' ? frame : source.status === 'done' ? '✔' : '✘'} ${source.label}`,
          createElement(
            Text,
            { dimColor: true },
            source.endedAt
              ? `  ${((source.endedAt - source.startedAt) / 1000).toFixed(1)} s`
              : source.status === 'running'
                ? `  ${Math.floor((Date.now() - source.startedAt) / 1000)} s`
                : '',
          ),
        ),
      ),
      createElement(Text, null, ' '),
      latest ? createElement(Text, { dimColor: true, wrap: 'truncate' }, latest) : null,
      ...errors.map((text, index) => createElement(Text, { key: `e${index}`, color: 'red', wrap: 'truncate' }, text)),
      createElement(Text, { dimColor: true }, keys),
    ),
  );
}

export async function runTui(state: GameState): Promise<void> {
  const app = render(createElement(App, { state }), { alternateScreen: true, exitOnCtrlC: true });
  void state.start();
  await app.waitUntilExit();
}
