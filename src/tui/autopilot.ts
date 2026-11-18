// Autopilot screen (g a): priority ranking, module toggles and their settings on the left; what the
// autopilot is doing and the projected queue (timeline) on the right. Settings save on every change.

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import {
  type AutopilotConfig,
  type AutopilotRules,
  type Goal,
  JOB_DURATIONS,
  type JobDuration,
  type ModuleKey,
  type PlannedTask,
} from '../game/autopilot-config.ts';
import { BLACKSMITH_JOBS, farmProduct } from '../game/farm.ts';
import type { GameState, JobOption } from '../game/state.ts';
import type { ProjectedStep, Timeline } from '../game/timeline.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { formatDuration, money, scrollWindow, shortDuration, truncate } from './format.ts';
import { ICON, stepIcon } from './icons.ts';

const createElement = React.createElement;
const SECONDS_PER_HOUR = 3_600;

/** Modules that already act; the others are shown but do nothing yet. */
export const BUILT_MODULES = new Set<ModuleKey>([
  'jobs',
  'farm',
  'energySleep',
  'hpSleep',
  'bank',
  'consumables',
  'quests',
  'npcDuels',
]);

const GOAL_LABEL: Record<Goal, string> = {
  quests: 'Quests completed',
  xp: 'Experience',
  money: 'Money (cash pay)',
  luck: 'Lucky finds (chance × max)',
};

type Row =
  | { kind: 'head'; text: string }
  | { kind: 'goal'; rank: number }
  | { kind: 'scope' }
  | { kind: 'farmJobs' }
  | { kind: 'blacklist' }
  | {
      kind: 'toggle';
      label: string;
      indent?: boolean;
      module?: ModuleKey;
      get: (configValue: AutopilotConfig) => boolean;
      set: (configValue: AutopilotConfig, flag: boolean) => void;
    }
  | {
      kind: 'number';
      label: string;
      get: (configValue: AutopilotConfig) => number;
      set: (configValue: AutopilotConfig, value: number) => void;
      step: number;
      min: number;
      max: number;
      format: (value: number) => string;
    }
  | {
      kind: 'choice';
      label: string;
      options: readonly JobDuration[];
      labels: readonly string[];
      get: (configValue: AutopilotConfig) => JobDuration;
      set: (configValue: AutopilotConfig, value: JobDuration) => void;
    };

const percent = (value: number) => `${Math.round(value * 100)}%`;
const minutes = (value: number) => formatDuration(value);
const moduleToggle = (module: ModuleKey, label: string): Row => ({
  kind: 'toggle',
  label,
  module,
  get: (configValue) => configValue.modules[module],
  set: (configValue, flag) => (configValue.modules[module] = flag),
});
/** A boolean `field` of the config section `section` picks (the field name is checked against it). */
const subToggle = <Field extends PropertyKey>(
  section: (configValue: AutopilotConfig) => Record<NoInfer<Field>, boolean>,
  field: Field,
  label: string,
): Row => ({
  kind: 'toggle',
  label,
  indent: true,
  get: (configValue) => section(configValue)[field],
  set: (configValue, flag) => (section(configValue)[field] = flag),
});
/** A number `field` of the config section `section` picks (`(c) => c` for top-level settings). */
const numberSetting = <Field extends PropertyKey>(
  section: (configValue: AutopilotConfig) => Record<NoInfer<Field>, number>,
  field: Field,
  label: string,
  step: number,
  min: number,
  max: number,
  format: (value: number) => string,
): Row => ({
  kind: 'number',
  label,
  step,
  min,
  max,
  format,
  get: (configValue) => section(configValue)[field],
  set: (configValue, value) => (section(configValue)[field] = value),
});

export const ROWS: [Row, ...Row[]] = [
  { kind: 'head', text: 'Priority (J K reorder)' },
  { kind: 'goal', rank: 0 },
  { kind: 'goal', rank: 1 },
  { kind: 'goal', rank: 2 },
  { kind: 'goal', rank: 3 },
  { kind: 'head', text: 'Modules (Space toggles · ← → change values)' },
  {
    kind: 'toggle',
    label: 'Score jobs per hour (off: per energy)',
    get: (configValue) => configValue.per === 'time',
    set: (configValue, flag) => (configValue.per = flag ? 'time' : 'energy'),
  },
  moduleToggle('jobs', 'Queue jobs'),
  {
    kind: 'choice',
    label: 'job duration',
    options: JOB_DURATIONS,
    labels: ['auto (planner picks)', '15 s', '10 min', '1 h'],
    get: (configValue) => configValue.jobs.duration,
    set: (configValue, value) => (configValue.jobs.duration = value),
  },
  subToggle((configValue) => configValue.jobs, 'special', 'use discovered silver & gold jobs'),
  numberSetting(
    (configValue) => configValue.jobs,
    'moveMargin',
    'switch spot only when better by',
    0.05,
    0,
    0.5,
    percent,
  ),
  { kind: 'blacklist' },
  moduleToggle('farm', 'Farm selected jobs (round-robin)'),
  { kind: 'farmJobs' },
  numberSetting((configValue) => configValue.farm, 'floor', 'stop farming below motivation', 0.05, 0, 1, percent),
  subToggle((configValue) => configValue.farm, 'items', 'use motivation items at the floor'),
  moduleToggle('energySleep', 'Sleep when out of energy'),
  subToggle((configValue) => configValue.wake, 'levelUp', 'wake: enough to level up'),
  subToggle((configValue) => configValue.wake, 'stretch', 'wake: enough for the next stretch'),
  subToggle((configValue) => configValue.wake, 'hpSafe', 'wake: HP safe'),
  subToggle((configValue) => configValue.wake, 'full', 'wake: full'),
  numberSetting(
    (configValue) => configValue,
    'ownTownWithin',
    'own-town hotel / bank within',
    900,
    0,
    6 * SECONDS_PER_HOUR,
    minutes,
  ),
  moduleToggle('hpSleep', 'Sleep or heal when HP is low'),
  numberSetting((configValue) => configValue.hp, 'sleepBelow', 'below', 0.05, 0.05, 0.95, percent),
  numberSetting((configValue) => configValue.hp, 'wakeAbove', 'get up at', 0.05, 0.1, 1, percent),
  moduleToggle('consumables', 'Use consumables'),
  subToggle((configValue) => configValue.consumables, 'energy', 'energy'),
  numberSetting(
    (configValue) => configValue.consumables,
    'levelUpWait',
    'wait for a level-up up to',
    900,
    0,
    6 * SECONDS_PER_HOUR,
    minutes,
  ),
  subToggle((configValue) => configValue.consumables, 'health', 'health'),
  subToggle((configValue) => configValue.consumables, 'motivation', 'motivation'),
  numberSetting((configValue) => configValue.consumables, 'reserve', 'keep in reserve', 1, 0, 20, String),
  moduleToggle('bank', 'Bank cash'),
  numberSetting((configValue) => configValue.bank, 'above', 'when cash over', 500, 500, 100_000, money),
  numberSetting((configValue) => configValue.bank, 'maxDetour', 'max detour', 300, 0, 4 * SECONDS_PER_HOUR, minutes),
  { kind: 'scope' },
  moduleToggle('quests', 'Do quests'),
  subToggle((configValue) => configValue.quests, 'repeatable', 'repeatable quests'),
  subToggle((configValue) => configValue.quests, 'unfinishable', 'also quests it cannot finish'),
  subToggle((configValue) => configValue.quests, 'buy', 'buy items no job drops (shops, mobile trader)'),
  numberSetting((configValue) => configValue.quests, 'buyLimit', 'buy limit per quest', 500, 0, 1_000_000, money),
  subToggle((configValue) => configValue.quests, 'market', 'also the market (instant buy, picked up there)'),
  numberSetting((configValue) => configValue.quests, 'marketLimit', 'market limit per quest', 500, 0, 1_000_000, money),
  numberSetting(
    (configValue) => configValue.quests,
    'buyTrip',
    'furthest walk to a shop / market town',
    900,
    0,
    6 * SECONDS_PER_HOUR,
    minutes,
  ),
  numberSetting((configValue) => configValue.quests, 'walkValue', 'a minute of walking is worth', 5, 0, 10_000, money),
  moduleToggle('npcDuels', 'NPC duels (never players)'),
  subToggle((configValue) => configValue.duels, 'forXp', 'also for XP when worth it'),
  numberSetting(
    (configValue) => configValue.duels,
    'levelMargin',
    'NPC level vs duel level',
    1,
    -20,
    10,
    (value) => (value > 0 ? `+${value}` : String(value)),
  ),
  { kind: 'head', text: 'Replanning & limits' },
  numberSetting(
    (configValue) => configValue,
    'slotCost',
    'cost per queue slot (TUI not always open)',
    300,
    0,
    4 * SECONDS_PER_HOUR,
    minutes,
  ),
  numberSetting((configValue) => configValue.cancel, 'margin', 'cancel tasks when plan better by', 0.05, 0, 1, percent),
  numberSetting(
    (configValue) => configValue.cancel,
    'horizon',
    'plan ahead / compare over',
    SECONDS_PER_HOUR,
    SECONDS_PER_HOUR,
    48 * SECONDS_PER_HOUR,
    minutes,
  ),
  numberSetting(
    (configValue) => configValue.cancel,
    'cooldown',
    'between cancels',
    300,
    0,
    4 * SECONDS_PER_HOUR,
    minutes,
  ),
  numberSetting((configValue) => configValue.spend, 'daily', 'daily spend cap', 100, 0, 1_000_000, money),
  moduleToggle('dryRun', 'Dry run (plan only, send nothing)'),
];

const selectable = (result: Row | undefined) => !!result && result.kind !== 'head';

export function AutopilotScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [selected, setSelected] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState<'farm' | 'blacklist' | null>(null);
  const [pickFilter, setPickFilter] = useState('');
  const [pickFiltering, setPickFiltering] = useState(false);
  const [pickSelected, setPickSelected] = useState(0);
  const config = state.autopilot.config;
  const index = selectable(ROWS[selected]) ? selected : 1;
  const current = ROWS[index] ?? ROWS[0];
  const move = (direction: 1 | -1) => {
    for (let innerIndex = index + direction; innerIndex >= 0 && innerIndex < ROWS.length; innerIndex += direction) {
      if (selectable(ROWS[innerIndex])) {
        return setSelected(innerIndex);
      }
    }
  };
  const edit = (fn: (configValue: AutopilotConfig) => void) =>
    state.updateAutopilot((autopilotFile) => fn(autopilotFile.config));
  const editRules = (fn: (rules: AutopilotRules) => void) =>
    state.updateAutopilot((autopilotFile) => fn(autopilotFile.rules));
  // The picker is one line per job even when a discovered special adds a second location for it.
  const pickOptions = useMemo(() => {
    if (!picker) {
      return [];
    }
    const seen = new Set<number>();
    return state.jobOptions(pickFilter, { sort: 'name', showAll: true }).filter((option) => {
      if (seen.has(option.job.id)) {
        return false;
      }
      seen.add(option.job.id);
      return true;
    });
  }, [
    state,
    picker,
    pickFilter,
    state.jobsVersion,
    state.specialVersion,
    state.items,
    state.queue.length,
    state.queueEnd?.x,
    state.queueEnd?.y,
  ]);
  const pickIndex = Math.max(0, Math.min(pickSelected, pickOptions.length - 1));
  const toggleFarmJob = (jobId: number) =>
    edit((configValue) => {
      const at = configValue.farm.jobs.indexOf(jobId);
      if (at >= 0) {
        configValue.farm.jobs.splice(at, 1);
      } else {
        configValue.farm.jobs.push(jobId);
      }
    });
  const toggleExcludedJob = (jobId: number) =>
    editRules((rules) => {
      const at = rules.excludedJobs.indexOf(jobId);
      if (at >= 0) {
        rules.excludedJobs.splice(at, 1);
      } else {
        rules.excludedJobs.push(jobId);
      }
    });
  const moveFarmJob = (jobId: number, direction: 1 | -1) =>
    edit((configValue) => {
      const at = configValue.farm.jobs.indexOf(jobId);
      const to = at + direction;
      if (at < 0 || to < 0 || to >= configValue.farm.jobs.length) {
        return;
      }
      const [moved] = configValue.farm.jobs.splice(at, 1);
      if (moved !== undefined) {
        configValue.farm.jobs.splice(to, 0, moved);
      }
    });
  const loadBlacksmithPreset = () => {
    edit((configValue) => {
      configValue.farm.jobs = [...BLACKSMITH_JOBS];
      configValue.modules.farm = true;
    });
    state.info(`Blacksmith farm preset loaded: ${BLACKSMITH_JOBS.length} jobs.`);
  };
  useEffect(() => {
    if (!picker) {
      return;
    }
    onCapture(true);
    return () => onCapture(false);
  }, [picker, onCapture]);

  useInput(
    (input, key) => {
      if (picker) {
        if (pickFiltering) {
          if (key.return || key.escape) {
            setPickFiltering(false);
            if (key.escape) {
              setPickFilter('');
            }
            setPickSelected(0);
          } else if (key.backspace || key.delete) {
            setPickFilter((text) => text.slice(0, -1));
            setPickSelected(0);
          } else if (input && !key.ctrl && !key.meta && !key.return) {
            setPickFilter((text) => text + input);
            setPickSelected(0);
          }
          return;
        }
        if (key.escape) {
          return setPicker(null);
        }
        if (input === '/') {
          return setPickFiltering(true);
        }
        if (key.upArrow || input === 'k') {
          return setPickSelected(Math.max(0, pickIndex - 1));
        }
        if (key.downArrow || input === 'j') {
          return setPickSelected(Math.max(0, Math.min(pickOptions.length - 1, pickIndex + 1)));
        }
        if (key.pageUp) {
          return setPickSelected(Math.max(0, pickIndex - 10));
        }
        if (key.pageDown) {
          return setPickSelected(Math.max(0, Math.min(pickOptions.length - 1, pickIndex + 10)));
        }
        const option = pickOptions[pickIndex];
        if (option && (input === ' ' || key.return)) {
          return picker === 'farm' ? toggleFarmJob(option.job.id) : toggleExcludedJob(option.job.id);
        }
        if (picker === 'farm' && input === 'P') {
          return loadBlacksmithPreset();
        }
        if (picker === 'farm' && option && (input === 'J' || input === 'K')) {
          return moveFarmJob(option.job.id, input === 'J' ? 1 : -1);
        }
        return;
      }
      if (input === 'Q') {
        return setExpanded(true);
      }
      if (key.escape) {
        return onExit();
      }
      if (key.upArrow || input === 'k') {
        return move(-1);
      }
      if (key.downArrow || input === 'j') {
        return move(1);
      }
      if (input === 'R') {
        edit((configValue) => (configValue.running = !configValue.running));
        return state.info(config.running ? 'Autopilot running.' : 'Autopilot paused.');
      }
      if (input === 'X') {
        state.updateAutopilot((autopilotFile) => {
          autopilotFile.config.running = false;
          autopilotFile.plan = null;
        });
        state.runner.plan = null;
        return state.info('Autopilot stopped: planned tasks cleared (rules kept).');
      }
      if (current.kind === 'goal' && (input === 'J' || input === 'K')) {
        const to = current.rank + (input === 'J' ? 1 : -1);
        if (to < 0 || to >= config.priority.length) {
          return;
        }
        edit((configValue) => {
          const from = configValue.priority[current.rank];
          const toValue = configValue.priority[to];
          if (from === undefined || toValue === undefined) {
            return;
          }
          configValue.priority[current.rank] = toValue;
          configValue.priority[to] = from;
        });
        return setSelected(index + (to - current.rank));
      }
      if (current.kind === 'scope' && (input === ' ' || key.return)) {
        return state.updateAutopilot((autopilotFile) => (autopilotFile.rules.onlyQuests = []));
      }
      if (current.kind === 'farmJobs' && (input === ' ' || key.return)) {
        setPicker('farm');
        setPickFilter('');
        setPickFiltering(false);
        setPickSelected(0);
        return;
      }
      if (current.kind === 'blacklist' && (input === ' ' || key.return)) {
        setPicker('blacklist');
        setPickFilter('');
        setPickFiltering(false);
        setPickSelected(0);
        return;
      }
      if (current.kind === 'toggle' && (input === ' ' || key.return)) {
        return edit((configValue) => current.set(configValue, !current.get(configValue)));
      }
      if (current.kind === 'number' && (key.leftArrow || key.rightArrow || input === '+' || input === '-')) {
        const value = key.rightArrow || input === '+' ? current.step : -current.step;
        return edit((configValue) =>
          current.set(
            configValue,
            Math.round(Math.min(current.max, Math.max(current.min, current.get(configValue) + value)) * 1000) / 1000,
          ),
        );
      }
      if (current.kind === 'choice' && (key.leftArrow || key.rightArrow || input === '+' || input === '-')) {
        const direction = key.rightArrow || input === '+' ? 1 : -1;
        const from = current.options.indexOf(current.get(config));
        const value = current.options[(from + direction + current.options.length) % current.options.length];
        if (value) {
          return edit((configValue) => current.set(configValue, value));
        }
      }
    },
    { isActive: active && !expanded },
  );

  if (picker) {
    return createElement(JobPicker, {
      state,
      width,
      height,
      options: pickOptions,
      selected: pickIndex,
      filter: pickFilter,
      filtering: pickFiltering,
      mode: picker,
      chosen: picker === 'farm' ? config.farm.jobs : state.autopilot.rules.excludedJobs,
    });
  }

  if (expanded) {
    return createElement(QueueView, { state, width, height, active, onCapture, onClose: () => setExpanded(false) });
  }

  const leftW = Math.max(34, Math.floor(width * 0.45));
  const rightW = width - leftW;
  const [start, end] = scrollWindow(index, ROWS.length, Math.max(2, height - 3));
  const left = createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      'Autopilot ',
      config.running
        ? createElement(Text, { color: 'green' }, '● running')
        : createElement(Text, { color: 'yellow' }, '‖ paused'),
    ),
    ...ROWS.slice(start, end).map((result, innerIndex) => {
      const countValue = start + innerIndex;
      const inv = countValue === index;
      if (result.kind === 'head') {
        return createElement(Text, { key: countValue, bold: true, color: 'yellow', wrap: 'truncate' }, result.text);
      }
      if (result.kind === 'scope') {
        const count = state.autopilot.rules.onlyQuests.length;
        return createElement(
          Text,
          { key: countValue, inverse: inv, wrap: 'truncate' },
          `     Quests goal: ${count ? `only the route's ${count} quest(s) (Space: all)` : 'all open quests'}`,
        );
      }
      if (result.kind === 'farmJobs') {
        const jobs = config.farm.jobs;
        const names = jobs
          .slice(0, 4)
          .map((jobId) => farmProduct(jobId)?.name ?? state.jobs.find((job) => job.id === jobId)?.name ?? `#${jobId}`)
          .join(', ');
        return createElement(
          Text,
          { key: countValue, inverse: inv, wrap: 'truncate' },
          `     farm jobs: ${jobs.length ? `${jobs.length} selected (${names}${jobs.length > 4 ? '…' : ''})` : 'none'} · Space to choose`,
        );
      }
      if (result.kind === 'blacklist') {
        const jobs = state.autopilot.rules.excludedJobs;
        const names = jobs
          .slice(0, 4)
          .map((jobId) => state.jobs.find((job) => job.id === jobId)?.name ?? `#${jobId}`)
          .join(', ');
        return createElement(
          Text,
          { key: countValue, inverse: inv, wrap: 'truncate' },
          `     job blacklist: ${jobs.length ? `${jobs.length} excluded (${names}${jobs.length > 4 ? '…' : ''})` : 'none'} · Space to choose`,
        );
      }
      if (result.kind === 'goal') {
        const priority = config.priority[result.rank];
        return createElement(
          Text,
          { key: countValue, inverse: inv, wrap: 'truncate' },
          ` ${result.rank + 1} ${priority ? GOAL_LABEL[priority] : ''}`,
        );
      }
      if (result.kind === 'number') {
        return createElement(
          Text,
          { key: countValue, inverse: inv, wrap: 'truncate' },
          `     ${result.label}: ${result.format(result.get(config))}`,
        );
      }
      if (result.kind === 'choice') {
        const value = result.get(config);
        const at = Math.max(0, result.options.indexOf(value));
        return createElement(
          Text,
          { key: countValue, inverse: inv, wrap: 'truncate' },
          `     ${result.label}: ${result.labels[at] ?? value}`,
        );
      }
      const soon =
        result.module && result.module !== 'dryRun' && !BUILT_MODULES.has(result.module)
          ? createElement(Text, { dimColor: true }, ' (not built yet)')
          : '';
      return createElement(
        Text,
        { key: countValue, inverse: inv, wrap: 'truncate' },
        `${result.indent ? '     ' : ' '}[${result.get(config) ? 'x' : ' '}] ${result.label}`,
        soon,
      );
    }),
  );
  return createElement(Box, { width, height }, left, createElement(PlanPane, { state, width: rightW, height }));
}

/** Full-screen job picker: farm order or the blacklist, one row per job, product names for filtering. */
function JobPicker(props: {
  state: GameState;
  width: number;
  height: number;
  options: JobOption[];
  selected: number;
  filter: string;
  filtering: boolean;
  mode: 'farm' | 'blacklist';
  chosen: number[];
}) {
  const { state, width, height, options, selected, filter, filtering, mode, chosen } = props;
  const [start, end] = scrollWindow(selected, options.length, Math.max(3, height - 4));
  const title = mode === 'farm' ? 'Farm jobs' : 'Job blacklist';
  const heading = filtering ? `${title}  /${filter}▏` : filter ? `${title}  (filter: ${filter})` : title;
  const count = mode === 'farm' ? `${chosen.length} selected` : `${chosen.length} excluded`;
  const blacklisted = new Set(state.autopilot.rules.excludedJobs);
  const productWidth = Math.max(12, Math.floor(width * 0.35));
  const nameWidth = Math.max(8, width - productWidth - 20);
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width, height, paddingX: 1 },
    createElement(Text, { bold: true, wrap: 'truncate' }, `${heading}  ${count}`),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      mode === 'farm'
        ? 'Space select · J K reorder · P blacksmith preset · / filter · Esc back'
        : 'Space exclude / include · / filter · Esc back',
    ),
    ...options.slice(start, end).map((option, offset) => {
      const optionIndex = start + offset;
      const selectedRow = optionIndex === selected;
      const isBlacklisted = blacklisted.has(option.job.id);
      const order = mode === 'farm' ? chosen.indexOf(option.job.id) : -1;
      const marked = mode === 'farm' ? order >= 0 : isBlacklisted;
      const products = state
        .jobProducts(option.job, state.jobValues(option))
        .map((product) => product.name)
        .join(', ');
      const doable = option.job.jobPoints >= option.job.workPoints;
      return createElement(
        Text,
        defined({
          key: `${option.job.id}:${option.at?.x ?? 0},${option.at?.y ?? 0}`,
          inverse: selectedRow,
          color: marked ? (mode === 'farm' ? 'green' : 'red') : doable ? undefined : 'gray',
          wrap: 'truncate',
        }),
        `${mode === 'farm' ? (order >= 0 ? `[${order + 1}]` : '[ ]') : isBlacklisted ? '[x]' : '[ ]'} `,
        truncate(option.job.name, nameWidth).padEnd(nameWidth),
        ` ${truncate(products || '—', productWidth).padEnd(productWidth)}`,
        ` LP ${option.job.laborPoints}`.padStart(7),
        ` lvl ${option.job.level}`.padStart(7),
        option.special ? ` · ${option.special}` : '',
        mode === 'farm' && isBlacklisted ? ' · blacklisted' : '',
      );
    }),
    options.length === 0
      ? createElement(Text, { dimColor: true }, state.jobs.length ? 'No job matches the filter.' : 'Loading jobs…')
      : null,
  );
}

/** One line of the plan pane: a step, back-to-back runs of one job merged, or a wait for energy. */
export interface PlanRow {
  icon: string;
  title: string;
  why?: string | undefined;
  fixed: boolean;
  wait?: boolean;
  levelUp: boolean;
  /** Same key on consecutive rows: merged into one ("×3"). */
  key?: string | undefined;
  count: number;
  step?: ProjectedStep;
  xp: number;
  money: number;
  energyBefore: number;
  energy: number;
  end: number;
}

/** The timeline as plan rows: waits for energy become rows, repeated runs of a job merge. */
export function planRows(timeline: Timeline, tasks: PlannedTask[]): PlanRow[] {
  const fixedN = timeline.steps.length - tasks.length;
  const rows: PlanRow[] = [];
  timeline.steps.forEach((taskInfo, innerIndex) => {
    const fixed = innerIndex < fixedN;
    const task = fixed ? undefined : tasks[innerIndex - fixedN];
    const st = taskInfo.step;
    if (taskInfo.waited >= 60) {
      rows.push({
        icon: ICON.wait,
        title: `wait ${shortDuration(taskInfo.waited)} for energy`,
        fixed,
        wait: true,
        levelUp: false,
        count: 1,
        xp: 0,
        money: 0,
        energyBefore: 0,
        energy: 0,
        end: taskInfo.start,
      });
    }
    const key = st.kind === 'job' ? `${fixed}:${st.jobId}:${st.duration}` : undefined;
    const last = rows[rows.length - 1];
    if (key && last?.key === key && taskInfo.travel < 60 && taskInfo.waited < 60) {
      last.count++;
      last.xp += st.kind === 'job' ? st.xp : 0;
      last.money += st.kind === 'job' ? st.money : 0;
      last.energy = taskInfo.energy;
      last.levelUp ||= taskInfo.levelUp;
      last.end = taskInfo.end;
      return;
    }
    rows.push({
      icon: stepIcon(st, task?.action),
      title: st.title,
      why: task?.why,
      fixed,
      levelUp: taskInfo.levelUp,
      key,
      count: 1,
      step: taskInfo,
      xp: st.kind === 'job' ? st.xp : 0,
      money: st.kind === 'job' ? st.money : 0,
      energyBefore: taskInfo.energyBefore,
      energy: taskInfo.energy,
      end: taskInfo.end,
    });
  });
  return rows;
}

const ICON_COLOR: Record<string, string> = {
  [ICON.job]: 'green',
  [ICON.walk]: 'cyan',
  [ICON.sleep]: 'blue',
  [ICON.bank]: 'yellow',
  [ICON.item]: 'magenta',
  [ICON.duel]: 'red',
};
const GOAL_SHORT: Record<Goal, string> = {
  quests: 'Quests',
  xp: 'XP',
  money: 'Money',
  luck: 'Luck',
};

/** Title and right-hand column of a plan row. */
function rowText(result: PlanRow, now: number): { title: string; info: string } {
  const taskInfo = result.step;
  if (!taskInfo) {
    return { title: result.title, info: '' };
  }
  const st = taskInfo.step;
  const walk = taskInfo.travel >= 60 && st.kind !== 'walk' ? `${ICON.walk}${shortDuration(taskInfo.travel)} ` : '';
  const en = `E ${Math.floor(result.energyBefore)}→${Math.floor(result.energy)}`;
  const eta = result.fixed ? ` · ${result.end - now <= 0 ? 'done' : `${shortDuration(result.end - now)} left`}` : '';
  switch (st.kind) {
    case 'job': {
      const len = shortDuration(st.duration);
      const title = result.count > 1 ? `${st.title} ×${result.count} (${len} each)` : `${st.title} (${len})`;
      return { title, info: `${walk}+${result.xp}xp ${money(result.money)}${result.fixed ? eta : ` ${en}`}` };
    }
    case 'sleep':
      return {
        title: st.title,
        info: `${walk}${shortDuration(taskInfo.end - taskInfo.start)}${st.cost ? ` ${money(st.cost)}` : ''}${result.fixed ? eta : ` ${en}`}`,
      };
    case 'walk':
      return { title: st.title, info: `${shortDuration(taskInfo.end - taskInfo.depart)} walk${eta}` };
    case 'action': {
      const parts = [
        st.cash ? money(Math.abs(st.cash)) : '',
        st.energy ? `+${Math.round(st.energy)}E` : '',
        st.health ? `+${Math.round(st.health)}HP` : '',
      ].filter(Boolean);
      return { title: st.title, info: `${walk}${parts.join(' ')}${eta}` };
    }
  }
}

/**
 * The plan for an end user: status, goals, what the plan earns, then the queue and the planned steps, each
 * with why the autopilot picked it. Repeated runs merge; waits for energy are their own rows.
 */
function PlanPane({ state, width, height }: { state: GameState; width: number; height: number }) {
  const plan = state.runner.plan;
  const timeline = plan?.timeline ?? state.timeline();
  const config = state.autopilot.config;
  const now = state.clock.now();
  const character = state.character;
  const status = !state.queueEnd
    ? createElement(Text, { color: 'yellow' }, 'waiting for the character position…')
    : !plan
      ? createElement(Text, { dimColor: true }, 'planning…')
      : config.running
        ? config.modules.dryRun
          ? createElement(Text, { color: 'yellow' }, '● dry run · plans only, sends nothing')
          : createElement(Text, { color: 'green' }, '● running')
        : createElement(Text, { color: 'yellow' }, '‖ paused · this is what it would do');
  const only = state.autopilot.rules.onlyQuests.length;
  const goals = config.priority
    .map((group) => (group === 'quests' && only ? `Quests (${only} on route)` : GOAL_SHORT[group]))
    .join(' › ');
  const lvl = timeline.steps.find((taskInfo) => taskInfo.levelUp);
  // Job pay only: gained.money also counts deposits as money gone.
  const earned = timeline.steps.reduce(
    (accumulator, currentValue) => accumulator + (currentValue.step.kind === 'job' ? currentValue.step.money : 0),
    0,
  );
  const head: React.ReactNode[] = [
    createElement(Text, { key: 'st', bold: true, wrap: 'truncate' }, 'Plan  ', status),
    createElement(
      Text,
      { key: 'g', wrap: 'truncate' },
      createElement(Text, { dimColor: true }, 'Goals  '),
      goals,
      createElement(Text, { dimColor: true }, ` · best per ${config.per === 'energy' ? 'energy' : 'hour'}`),
    ),
    createElement(
      Text,
      { key: 'tot', wrap: 'truncate' },
      createElement(Text, { dimColor: true }, 'Gains  '),
      timeline.steps.length
        ? `${shortDuration(Math.max(0, timeline.end - now))} · +${Math.round(timeline.gained.xp).toLocaleString('en-US')} XP · +${money(earned)}`
        : 'nothing planned',
      lvl
        ? createElement(
            Text,
            { color: 'yellow' },
            ` · ${ICON.level} level ${lvl.level} in ${shortDuration(Math.max(0, lvl.end - now))}`,
          )
        : '',
    ),
    createElement(
      Text,
      { key: 'now', wrap: 'truncate' },
      createElement(Text, { dimColor: true }, 'Now    '),
      `E ${character.energy}/${character.maxEnergy} · HP ${character.health}/${character.maxHealth} · ${money(character.cash)} · spent ${money(state.autopilot.spent.amount)}/${money(config.spend.daily)}`,
    ),
    createElement(Text, { key: 'sp' }, ' '),
  ];
  const rows = planRows(timeline, plan?.tasks ?? []);
  const texts = rows.map((result) => rowText(result, now));
  const infoW = Math.min(Math.floor(width / 2), Math.max(0, ...texts.map((target) => target.info.length)));
  const titleW = Math.max(8, width - 4 - 8 - infoW);
  // Border, key line and the "+N more" line stay free.
  const room = Math.max(1, height - 4 - head.length);
  const body: React.ReactNode[] = [];
  let countValue = 0;
  let section: boolean | null = null;
  let shown = 0;
  let lastWhy: string | undefined;
  for (const [innerIndex, result] of rows.entries()) {
    // A reason shared with the row above (walk + deposit) is shown once.
    const why = result.why && result.why !== lastWhy ? result.why : undefined;
    const need = (section !== result.fixed ? 1 : 0) + 1 + (why ? 1 : 0);
    if (body.length + need > room) {
      break;
    }
    if (section !== result.fixed) {
      section = result.fixed;
      body.push(
        createElement(
          Text,
          { key: `h${innerIndex}`, bold: true, color: 'cyan' },
          result.fixed ? 'In the queue' : 'Planned',
        ),
      );
    }
    const target = texts[innerIndex];
    if (!target) {
      continue;
    }
    const mark = result.fixed
      ? innerIndex === 0
        ? '▶ '
        : '  '
      : result.wait
        ? '  '
        : String(++countValue).padStart(2);
    body.push(
      createElement(
        Text,
        defined({ key: `r${innerIndex}`, wrap: 'truncate', dimColor: result.wait }),
        createElement(
          Text,
          defined({ color: result.fixed && innerIndex === 0 ? 'green' : undefined, dimColor: !result.fixed }),
          mark,
        ),
        ' ',
        createElement(Text, defined({ color: ICON_COLOR[result.icon] }), result.icon),
        ' ',
        createElement(
          Text,
          { bold: !result.fixed && countValue === 1 && !result.wait },
          truncate(target.title, titleW),
        ),
        ' ',
        createElement(Text, { dimColor: true }, target.info.slice(0, infoW).padStart(infoW)),
        result.levelUp ? createElement(Text, { color: 'yellow' }, ` ${ICON.level}`) : '',
      ),
    );
    if (why) {
      body.push(
        createElement(Text, { key: `w${innerIndex}`, dimColor: true, italic: true, wrap: 'truncate' }, `      ${why}`),
      );
    }
    if (!result.wait) {
      lastWhy = result.why;
    }
    shown++;
  }
  if (shown < rows.length) {
    body.push(createElement(Text, { key: 'more', dimColor: true }, `  +${rows.length - shown} more · Q full queue`));
  }
  if (!rows.length) {
    body.push(createElement(Text, { key: 'idle', dimColor: true }, 'Idle'));
  }
  if (plan && !plan.tasks.length) {
    body.push(createElement(Text, { key: 'none', color: 'yellow', wrap: 'wrap' }, plan.why));
  }
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, height, paddingX: 1 },
    ...head,
    ...body,
    createElement(Box, { flexGrow: 1 }),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      'Space toggle / choose · ← → value · J K rank · Q queue · R run/pause · X stop · Esc back',
    ),
  );
}

/**
 * Full queue (Q): server tasks then planned ones, with ETA, energy/HP after, XP, $. The plan is recomputed from
 * inputs, so edits are rules: d excludes a planned job (or removes an inserted row), s / b insert a sleep / bank
 * stop at a row's time, J K move an inserted row, c cancels a server task.
 */
function QueueView({
  state,
  width,
  height,
  active,
  onCapture,
  onClose,
}: {
  state: GameState;
  width: number;
  height: number;
  active: boolean;
  onCapture: (flag: boolean) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [confirm, setConfirm] = useState<number | null>(null);
  // Own all keys while open: global shortcuts (s sleep, u refresh, …) would take the queue view's.
  useEffect(() => {
    onCapture(true);
    return () => onCapture(false);
  }, []);
  const plan = state.runner.plan;
  const timeline = plan?.timeline ?? state.timeline();
  const fixedN = timeline.steps.length - (plan?.tasks.length ?? 0);
  const index = Math.min(selected, Math.max(0, timeline.steps.length - 1));
  const row = timeline.steps[index];
  const task = index >= fixedN ? plan?.tasks[index - fixedN] : undefined;
  const rules = state.autopilot.rules;
  const now = state.clock.now();
  const insertAt = (key?: string) => {
    const match = key?.match(/^insert:(sleep|bank):(\d+(?:\.\d+)?)$/);
    return match ? { kind: match[1] as 'sleep' | 'bank', at: Number(match[2]) } : null;
  };

  useInput(
    (input, key) => {
      if (confirm !== null) {
        setConfirm(null);
        if (input === 'y') {
          void state.cancel(confirm);
        }
        return;
      }
      if (key.escape || input === 'Q') {
        return onClose();
      }
      if (key.upArrow || input === 'k') {
        return setSelected(Math.max(0, index - 1));
      }
      if (key.downArrow || input === 'j') {
        return setSelected(Math.min(timeline.steps.length - 1, index + 1));
      }
      if (!row) {
        return;
      }
      if (input === 'c' && index < fixedN) {
        return setConfirm(index);
      }
      const ins = insertAt(task?.key);
      if (input === 'd' && ins) {
        return state.updateAutopilot(
          (autopilotFile) =>
            (autopilotFile.rules.inserts = autopilotFile.rules.inserts.filter(
              (xCoord) => !(xCoord.kind === ins.kind && xCoord.at === ins.at),
            )),
        );
      }
      if (input === 'd' && task?.step.kind === 'job') {
        const jobId = task.step.jobId;
        state.updateAutopilot(
          (autopilotFile) =>
            (autopilotFile.rules.excludedJobs = [...new Set([...autopilotFile.rules.excludedJobs, jobId])]),
        );
        return state.info(`Autopilot: ${task.step.title} blacklisted (edit it on g a; u here clears the blacklist).`);
      }
      if (input === 'u' && rules.excludedJobs.length) {
        state.updateAutopilot((autopilotFile) => (autopilotFile.rules.excludedJobs = []));
        return state.info('Autopilot: job blacklist cleared.');
      }
      if (input === 's' || input === 'b') {
        const at = Math.max(now, row.depart);
        return state.updateAutopilot((autopilotFile) =>
          autopilotFile.rules.inserts.push({ at, kind: input === 's' ? 'sleep' : 'bank' }),
        );
      }
      if ((input === 'J' || input === 'K') && ins) {
        const other = timeline.steps[index + (input === 'J' ? 1 : -1)];
        if (!other) {
          return;
        }
        const at = input === 'J' ? other.end : Math.max(now, other.depart - 1);
        state.updateAutopilot(
          (autopilotFile) =>
            (autopilotFile.rules.inserts = autopilotFile.rules.inserts.map((xCoord) =>
              xCoord.kind === ins.kind && xCoord.at === ins.at ? { ...xCoord, at } : xCoord,
            )),
        );
        return setSelected(index + (input === 'J' ? 1 : -1));
      }
    },
    { isActive: active },
  );

  const otherName = Math.max(10, width - 62);
  const [start, end] = scrollWindow(index, timeline.steps.length, Math.max(2, height - 5));
  const head = `${'    '}${'Task'.padEnd(otherName - 2)} ${'ETA'.padStart(8)} ${'travel'.padStart(7)} ${'EN'.padStart(4)} ${'HP'.padStart(5)} ${'XP'.padStart(6)} ${'$'.padStart(6)}  by`;
  const lines = timeline.steps.slice(start, end).map((st, innerIndex) => {
    const absoluteIndex = start + innerIndex;
    const taskInfo = absoluteIndex >= fixedN ? plan?.tasks[absoluteIndex - fixedN] : undefined;
    const xp = st.step.kind === 'job' ? `+${st.step.xp}` : st.levelUp ? '★' : '';
    const cash =
      st.step.kind === 'job'
        ? `+${st.step.money}`
        : st.step.kind === 'action' && st.step.cash
          ? String(Math.round(st.step.cash))
          : '';
    const by = absoluteIndex < fixedN ? 'queued' : insertAt(taskInfo?.key) ? 'you' : (taskInfo?.module ?? '');
    return createElement(
      Text,
      defined({
        key: absoluteIndex,
        inverse: absoluteIndex === index,
        dimColor: absoluteIndex >= fixedN && absoluteIndex !== index,
        color: st.levelUp ? 'yellow' : undefined,
        wrap: 'truncate',
      }),
      `${absoluteIndex < fixedN ? '▪' : '·'} ${stepIcon(st.step, taskInfo?.action)} ${truncate(st.step.title, otherName - 2).padEnd(otherName - 2)} ${formatDuration(Math.max(0, st.end - now)).padStart(8)} ${(st.travel ? formatDuration(st.travel) : '').padStart(7)} ${String(Math.floor(st.energy)).padStart(4)} ${String(Math.floor(st.health)).padStart(5)} ${xp.padStart(6)} ${cash.padStart(6)}  ${by}${st.levelUp ? ' ★ level up' : ''}`,
    );
  });
  const keys =
    confirm !== null
      ? createElement(
          Text,
          { color: 'yellow', wrap: 'truncate' },
          `Cancel "${timeline.steps[confirm]?.step.title}" on the server? y / n`,
        )
      : createElement(
          Text,
          { dimColor: true, wrap: 'truncate' },
          `c cancel (queued) · d blacklist job / remove insert · s b insert sleep / bank here · J K move insert · ${rules.excludedJobs.length ? `u clear ${rules.excludedJobs.length} blacklisted · ` : ''}Esc back`,
        );
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width, height, paddingX: 1 },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `Queue & plan · ${fixedN} queued · ${timeline.steps.length - fixedN} planned · ends in ${formatDuration(Math.max(0, timeline.end - now))} · +${Math.round(timeline.gained.xp)} XP · ${money(Math.round(timeline.gained.money))}`,
    ),
    createElement(Text, { dimColor: true, wrap: 'truncate' }, head),
    ...lines,
    createElement(Box, { flexGrow: 1 }),
    task?.why ? createElement(Text, { dimColor: true, wrap: 'truncate' }, `why: ${task.why}`) : null,
    keys,
  );
}
