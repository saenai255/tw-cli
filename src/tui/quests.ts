// Quests screen: quest log (accepted quests) and quest givers (saloon + a giver opened from the map).

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { groupByChain, type Quest, type QuestChain } from '../game/quests.ts';
import type { RouteObjective, RoutePlan } from '../game/route.ts';
import type { GameState } from '../game/state.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { formatDuration, formatTravel, money, scrollWindow, shortDuration, truncate } from './format.ts';

const createElement = React.createElement;

type List = 'log' | 'givers';
type Confirm =
  | { kind: 'finish'; quest: Quest; choice: number }
  | { kind: 'cancel'; quest: Quest }
  | { kind: 'route'; plan: RoutePlan }
  | null;
type RouteScope = 'quest' | 'chain' | 'all';
const SCOPE_LABEL: Record<RouteScope, string> = { quest: 'this quest', chain: 'this chain', all: 'all quests' };
const DURATION_LABEL = { short: '15 s', middle: '10 min', long: '1 h' } as const;

/** Compact estimate for a list row: "~2h10", "~2h10+?" when some need can't come from jobs, "" when nothing to do. */
export function estimateTag(plan: RoutePlan | undefined): string {
  if (!plan || (!plan.stops.length && !plan.unmet.length)) {
    return '';
  }
  if (!plan.stops.length) {
    return '?';
  }
  return `~${shortDuration(plan.totals.seconds)}${plan.unmet.length ? '+?' : ''}`;
}

interface Row {
  kind: 'quest';
  quest: Quest;
  tag?: string;
}
interface ChainRow {
  kind: 'chain';
  chain: QuestChain;
  indent: boolean;
}
interface GiverRow {
  kind: 'giver';
  key: string;
  name: string;
  at: { x: number; y: number } | null;
}

function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) {
        continue;
      }
      if (`${line} ${word}`.trim().length > width) {
        if (line) {
          out.push(line);
        }
        line = word;
      } else {
        line = `${line} ${word}`.trim();
      }
    }
    out.push(line);
  }
  return out;
}

export function QuestsScreen({
  state,
  width,
  height,
  onCapture,
  onExit,
  startOnGivers,
  onShowOnMap,
  active = true,
}: ScreenProps & { startOnGivers?: boolean; onShowOnMap?: (at: { x: number; y: number }) => void }) {
  const [list, setList] = useState<List>(startOnGivers ? 'givers' : 'log');
  const [sel, setSel] = useState(0);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [scroll, setScroll] = useState(0);
  /** l: j k scroll the quest text instead of moving in the list. */
  const [detail, setDetail] = useState(false);
  const [route, setRoute] = useState<{ scope: RouteScope; objective: RouteObjective } | null>(null);

  useEffect(() => {
    void (async () => {
      await state.loadItems();
      if (!state.saloon.length) {
        await state.loadSaloon();
      }
    })();
  }, [state]);
  useEffect(() => {
    onCapture(!!confirm);
  }, [confirm]);

  type AnyRow = GiverRow | Row | ChainRow;
  const chained = (quests: Quest[], indent: boolean, tag?: (currentQuest: Quest) => string): AnyRow[] =>
    groupByChain(quests).flatMap((chain) => [
      { kind: 'chain', chain, indent } as ChainRow,
      ...chain.quests.map((chainQuest) => ({ kind: 'quest', quest: chainQuest, tag: tag?.(chainQuest) }) as Row),
    ]);
  const logRows = chained(state.quests, false);
  const giverRows: AnyRow[] = [];
  const emp = state.employer;
  if (emp) {
    giverRows.push({
      kind: 'giver',
      key: emp.key,
      name: `▾ ${emp.name}`,
      at: emp.x !== null && emp.y !== null ? { x: emp.x, y: emp.y } : null,
    });
    giverRows.push(
      ...chained(emp.open, true, (currentQuest) =>
        currentQuest.accepted ? 'accepted' : currentQuest.acceptable ? 'new' : 'locked',
      ),
    );
  }
  for (const source of state.saloon) {
    if (source.key !== emp?.key) {
      giverRows.push({ kind: 'giver', key: source.key, name: `${source.name} (saloon)`, at: null });
    }
  }
  const rows: AnyRow[] = list === 'log' ? logRows : giverRows;
  // Chain headers are labels: the cursor always lands on a quest or giver row.
  const selectable = (index: number) => rows[index] !== undefined && rows[index]?.kind !== 'chain';
  const nearestSelectable = (index: number, dir: 1 | -1): number => {
    for (let innerIndex = index; innerIndex >= 0 && innerIndex < rows.length; innerIndex += dir) {
      if (selectable(innerIndex)) {
        return innerIndex;
      }
    }
    for (let candidateIndex = index; candidateIndex >= 0 && candidateIndex < rows.length; candidateIndex -= dir) {
      if (selectable(candidateIndex)) {
        return candidateIndex;
      }
    }
    return 0;
  };
  const idx = nearestSelectable(Math.min(sel, Math.max(0, rows.length - 1)), 1);
  const cur = rows[idx];
  const quest = cur?.kind === 'quest' ? cur.quest : undefined;
  const routeQuests = route ? state.routeQuests(route.scope, quest?.accepted ? quest : undefined) : [];
  const plan = route ? state.planQuestRoute(routeQuests, route.objective) : null;
  // Time estimates per quest and per chain: the same plan the route planner would make (per energy).
  const estimates = useMemo(() => {
    const byQuest = new Map<number, RoutePlan>();
    const byChain = new Map<string, RoutePlan>();
    if (!state.jobs.length) {
      return { byQuest, byChain };
    }
    const all = [...state.quests, ...(state.employer?.open ?? [])];
    for (const currentQuest of all) {
      if (!currentQuest.finishable && !byQuest.has(currentQuest.id)) {
        byQuest.set(currentQuest.id, state.planQuestRoute([currentQuest]));
      }
    }
    for (const candidate of groupByChain(state.quests)) {
      byChain.set(
        `${candidate.groupId}:${candidate.title}`,
        state.planQuestRoute(candidate.quests.filter((currentQuest) => !currentQuest.finishable)),
      );
    }
    return { byQuest, byChain };
  }, [state, state.quests, state.employer, state.jobs, state.inventory.bag.size, state.queue.length]);

  useInput(
    (input, key) => {
      if (confirm) {
        // Reward choice (quest.rewardOptions): ← → or the option number, then y.
        if (confirm.kind === 'finish' && confirm.quest.rewardOptions.length > 1) {
          const count = confirm.quest.rewardOptions.length;
          if (key.leftArrow || input === 'h') {
            return setConfirm({ ...confirm, choice: (confirm.choice + count - 1) % count });
          }
          if (key.rightArrow || input === 'l' || key.tab) {
            return setConfirm({ ...confirm, choice: (confirm.choice + 1) % count });
          }
          const value = Number(input);
          if (Number.isInteger(value) && value >= 1 && value <= count) {
            return setConfirm({ ...confirm, choice: value - 1 });
          }
        }
        setConfirm(null);
        if (confirm.kind === 'route' && input === 'a') {
          return state.startAutopilotForQuests(
            routeQuests.map((currentQuest) => currentQuest.id),
            route ? SCOPE_LABEL[route.scope] : 'route',
          );
        }
        if (input !== 'y') {
          return;
        }
        if (confirm.kind === 'route') {
          void state.queueRoute(confirm.plan);
        } else if (confirm.kind === 'finish') {
          void state.finishQuest(confirm.quest, confirm.quest.rewardOptions[confirm.choice]?.id);
        } else {
          void state.cancelQuest(confirm.quest);
        }
        return;
      }
      if (route) {
        if (key.escape || input === 'R') {
          return setRoute(null);
        }
        if (input === '1') {
          return setRoute({ ...route, scope: 'quest' });
        }
        if (input === '2') {
          return setRoute({ ...route, scope: 'chain' });
        }
        if (input === '3') {
          return setRoute({ ...route, scope: 'all' });
        }
        if (input === 'e') {
          return setRoute({ ...route, objective: route.objective === 'energy' ? 'time' : 'energy' });
        }
        const rstep = key.pageUp || key.pageDown ? 10 : 1;
        if (key.upArrow || input === 'k' || key.pageUp) {
          return setScroll((value) => Math.max(0, value - rstep));
        }
        if (key.downArrow || input === 'j' || key.pageDown) {
          return setScroll((value) => value + rstep);
        }
        if (input === 'x' && state.autoRoute) {
          return state.stopAutoRoute();
        }
        if (!plan?.stops.length) {
          return;
        }
        if (key.return) {
          return setConfirm({ kind: 'route', plan });
        }
        if (input === 'v') {
          const at = state.highlightRoute(plan, `route: ${SCOPE_LABEL[route.scope]}`);
          if (at) {
            state.info(`Route jobs marked with ! on the map (${plan.stops.length} stops).`);
            onShowOnMap?.(at);
          }
        }
        return;
      }
      if (detail && (key.escape || input === 'h')) {
        return setDetail(false);
      }
      if (key.escape) {
        return onExit();
      }
      if (input === 'l' && cur) {
        return setDetail(true);
      }
      if (input === 'R') {
        if (!state.quests.length) {
          return state.error('No accepted quests to plan for.');
        }
        setScroll(0);
        return setRoute({ scope: quest?.accepted && !quest.finishable ? 'quest' : 'all', objective: 'energy' });
      }
      if (key.tab) {
        setSel(0);
        setScroll(0);
        setDetail(false);
        return setList((lineValue) => (lineValue === 'log' ? 'givers' : 'log'));
      }
      const step = key.pageUp || key.pageDown ? 10 : 1;
      if (detail) {
        if (key.upArrow || input === 'k' || key.pageUp) {
          return setScroll((value) => Math.max(0, value - step));
        }
        if (key.downArrow || input === 'j' || key.pageDown) {
          return setScroll((value) => value + step);
        }
      }
      if (key.upArrow || input === 'k' || key.pageUp) {
        setScroll(0);
        return setSel(nearestSelectable(Math.max(0, idx - step), -1));
      }
      if (key.downArrow || input === 'j' || key.pageDown) {
        setScroll(0);
        return setSel(nearestSelectable(Math.min(rows.length - 1, idx + step), 1));
      }
      if (cur?.kind === 'giver' && key.return) {
        return void state.openEmployer(cur.key, cur.at).then(() => setSel(0));
      }
      if (cur?.kind === 'giver' && input === 'w' && cur.at) {
        return void state.walkToQuestGiver(cur.key, cur.name, cur.at);
      }
      if (!quest) {
        return;
      }
      if (input === 'a') {
        if (quest.accepted) {
          return state.error('Already accepted.');
        }
        return void state.acceptQuest(quest);
      }
      if (key.return || input === 'f') {
        if (!quest.accepted && list === 'givers') {
          return void state.acceptQuest(quest);
        }
        if (!quest.finishable) {
          return state.error(
            'Not finished yet: ' +
              quest.requirements
                .filter((requirement) => !requirement.solved)
                .map((requirement) => requirement.info)
                .join('; '),
          );
        }
        return setConfirm({ kind: 'finish', quest, choice: 0 });
      }
      if (input === 'x' && quest.accepted) {
        return setConfirm({ kind: 'cancel', quest });
      }
      if (input === 'v') {
        const at = state.highlightQuest(quest);
        if (!at) {
          return state.error('No job on the map provides what this quest still needs.');
        }
        state.info(`Marked ${state.mapHighlight?.jobIds.size} job(s) for "${quest.title}" with ! on the map.`);
        return onShowOnMap?.(at);
      }
      if (input === 'w' && quest.employerAt) {
        return void state.walkToQuestGiver(quest.employer, quest.employerName, quest.employerAt);
      }
    },
    { isActive: active },
  );

  const leftW = Math.max(30, Math.floor(width * 0.42));
  const rightW = width - leftW;
  const listRows = Math.max(2, height - 3);
  const [start, end] = scrollWindow(idx, rows.length, listRows);
  const tabs = (['log', 'givers'] as List[]).map((lineValue) =>
    createElement(
      Text,
      defined({
        key: lineValue,
        inverse: list === lineValue,
        bold: list === lineValue,
        color: list === lineValue ? 'cyan' : undefined,
      }),
      lineValue === 'log' ? ` Quest log ${state.quests.length}/${state.questCapacity || '?'} ` : ' Quest givers ',
    ),
  );
  const left = createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: detail || route ? 'gray' : 'cyan',
      width: leftW,
      height,
      paddingX: 1,
    },
    createElement(Text, { wrap: 'truncate' }, ...tabs, createElement(Text, { dimColor: true }, ' Tab')),
    ...rows.slice(start, end).map((result, index) => {
      const count = start + index;
      if (result.kind === 'chain') {
        const candidate = result.chain;
        return createElement(
          Text,
          { key: `c${count}`, bold: true, color: 'yellow', wrap: 'truncate' },
          truncate(`${result.indent ? '  ' : ''}${candidate.title}`, leftW - 14),
          createElement(Text, { dimColor: true, bold: false }, ` ${candidate.quests.length}`),
          candidate.finishable ? createElement(Text, { color: 'green' }, ` ✔${candidate.finishable}`) : '',
          result.indent
            ? ''
            : createElement(
                Text,
                { color: 'cyan', bold: false },
                ` ${estimateTag(estimates.byChain.get(`${candidate.groupId}:${candidate.title}`))}`,
              ),
        );
      }
      if (result.kind === 'giver') {
        return createElement(
          Text,
          {
            key: `g${result.key}`,
            inverse: count === idx,
            color: 'magenta',
            bold: result.name.startsWith('▾'),
            wrap: 'truncate',
          },
          truncate(result.name, leftW - 4),
        );
      }
      const currentQuest = result.quest;
      const mark = currentQuest.finishable ? '✔' : currentQuest.accepted ? '·' : result.tag === 'new' ? '!' : ' ';
      const est = currentQuest.finishable ? '' : estimateTag(estimates.byQuest.get(currentQuest.id));
      const titleW = leftW - 10 - (est ? est.length + 1 : 0);
      return createElement(
        Text,
        defined({
          key: currentQuest.id,
          inverse: count === idx,
          wrap: 'truncate',
          color: currentQuest.finishable ? 'green' : result.tag === 'locked' ? 'gray' : undefined,
        }),
        `${list === 'givers' ? '    ' : '  '}${mark} ${truncate(currentQuest.soloTitle || currentQuest.title, titleW).padEnd(titleW)}`,
        est ? createElement(Text, { color: 'cyan' }, ` ${est}`) : '',
      );
    }),
    rows.length === 0
      ? createElement(
          Text,
          { dimColor: true },
          list === 'log' ? 'No accepted quests.' : 'Loading saloon… (or open a quest giver from the map: o)',
        )
      : null,
  );

  let detailLines: React.ReactNode[] = [];
  let maxTop = 0;
  if (route && plan) {
    [detailLines, maxTop] = routeLines({
      state,
      plan,
      route,
      questCount: routeQuests.length,
      width: rightW - 4,
      room: height - 3,
      scroll,
    });
  } else if (quest) {
    const dw = Math.max(10, rightW - 4);
    const info: React.ReactNode[] = [
      createElement(Text, { key: 't', bold: true, wrap: 'truncate' }, quest.soloTitle || quest.title),
      createElement(Text, { key: 'g', color: 'yellow', wrap: 'truncate' }, quest.group),
      createElement(
        Text,
        { key: 'e', dimColor: true, wrap: 'truncate' },
        `${quest.employerName || quest.employer}${quest.employerAt ? ` · at ${quest.employerAt.x},${quest.employerAt.y} · ${formatTravel(state.travelTo(quest.employerAt))}` : ''}`,
      ),
      ...(quest.limited ? [createElement(Text, { key: 'l', color: 'yellow', wrap: 'truncate' }, quest.limited)] : []),
      ...estimateLines(estimates.byQuest.get(quest.id), quest.finishable),
      createElement(Text, { key: 'rq', bold: true }, 'Requirements'),
      ...quest.requirements.flatMap((requirement, index) => {
        const row = createElement(
          Text,
          { key: `r${index}`, color: requirement.solved ? 'green' : 'red', wrap: 'truncate' },
          `${requirement.solved ? '✔' : '✘'} ${requirement.info}`,
        );
        if (requirement.solved) {
          return [row];
        }
        // Where to get it: jobs that drop the item (or the job itself), nearest first.
        const src = state
          .requirementSources(requirement)
          .sort((first, second) => (first.way ?? Infinity) - (second.way ?? Infinity));
        const have = requirement.itemId !== undefined ? state.inventory.countBase(requirement.itemId) : 0;
        const extra = [];
        if (have) {
          extra.push(
            createElement(Text, { key: `h${index}`, dimColor: true, wrap: 'truncate' }, `    in bag: ${have}`),
          );
        }
        for (const source of src.slice(0, 3)) {
          const ok = source.job.jobPoints >= source.job.workPoints;
          extra.push(
            createElement(
              Text,
              { key: `s${index}-${source.job.id}`, color: ok ? 'magentaBright' : 'gray', wrap: 'truncate' },
              `    ↳ ${source.job.name}${source.chance !== null ? ` ${Math.round(source.chance * 100)}%` : ''} · ${source.job.laborPoints} LP${source.way !== null ? ` · ${formatDuration(source.way)}` : ''}${ok ? '' : ' (not enough LP)'}`,
            ),
          );
        }
        if (src.length > 3) {
          extra.push(
            createElement(
              Text,
              { key: `m${index}`, dimColor: true },
              `    +${src.length - 3} more jobs (v shows all on the map)`,
            ),
          );
        }
        return [row, ...extra];
      }),
      createElement(Text, { key: 'rw', bold: true }, 'Rewards'),
      createElement(
        Text,
        { key: 'rws', wrap: 'truncate' },
        quest.rewards.map((result) => result.text).join(' · ') || '—',
      ),
      ...(quest.rewardOptions.length
        ? [
            createElement(
              Text,
              { key: 'ro', dimColor: true, wrap: 'truncate' },
              `Choice: ${quest.rewardOptions.map((options, index) => `${index + 1}) ${options.text}`).join(' / ')} (pick when finishing)`,
            ),
          ]
        : []),
      createElement(Text, { key: 'sp' }, ' '),
    ];
    const text = wrapLines([quest.description, quest.hint && `Hint: ${quest.hint}`].filter(Boolean).join('\n\n'), dw);
    const room = Math.max(0, height - 3 - info.length);
    maxTop = Math.max(0, text.length - room);
    const value = Math.min(scroll, maxTop);
    detailLines = [
      ...info,
      ...text
        .slice(value, value + room)
        .map((textValue, index) => createElement(Text, { key: `d${index}`, dimColor: true }, textValue || ' ')),
    ];
  } else if (cur?.kind === 'giver') {
    detailLines = [
      createElement(Text, { key: 'n', bold: true, color: 'magenta' }, cur.name.replace(/^▾ /, '')),
      createElement(
        Text,
        { key: 'h', dimColor: true },
        cur.at ? `at ${cur.at.x},${cur.at.y} · travel ${formatTravel(state.travelTo(cur.at))}` : 'In the saloon',
      ),
      createElement(Text, { key: 'k' }, 'Enter: show quests · w: walk there'),
    ];
  }
  useEffect(() => {
    if (scroll > maxTop) {
      setScroll(maxTop);
    }
  });
  const keys = confirm
    ? confirm.kind === 'finish' && confirm.quest.rewardOptions.length > 1
      ? createElement(
          Box,
          { flexDirection: 'column' },
          createElement(
            Text,
            { color: 'yellow', wrap: 'truncate' },
            `Finish "${confirm.quest.title}"? Choose a reward (← → or 1-${confirm.quest.rewardOptions.length}), then y:`,
          ),
          ...confirm.quest.rewardOptions.map((options, index) =>
            createElement(
              Text,
              defined({
                key: options.id,
                inverse: index === confirm.choice,
                color: index === confirm.choice ? 'green' : undefined,
                wrap: 'truncate',
              }),
              ` ${index + 1}) ${options.text}`,
            ),
          ),
        )
      : createElement(
          Text,
          { color: 'yellow', wrap: 'truncate' },
          confirm.kind === 'route'
            ? `Queue ${Math.min(confirm.plan.fitRuns, Math.max(0, state.taskLimit - state.queue.length))} of ${confirm.plan.totals.runs} route jobs? y yes · a autopilot: quests first until these are done (g a) · n no`
            : `${confirm.kind === 'finish' ? 'Finish' : 'Cancel'} "${confirm.quest.title}"${confirm.kind === 'finish' && confirm.quest.rewardOptions.length === 1 ? ` (reward: ${confirm.quest.rewardOptions[0]?.text})` : ''}? y / n`,
        )
    : route
      ? createElement(
          Text,
          { dimColor: true, wrap: 'truncate' },
          `${state.autoRoute ? `auto: ${state.autoRoute.runs.length} left, x stop · ` : ''}1 quest · 2 chain · 3 all · e energy/time · Enter queue · v map · j k scroll · Esc`,
        )
      : createElement(
          Text,
          { dimColor: true, wrap: 'truncate' },
          quest
            ? `${quest.accepted ? `${quest.finishable ? 'Enter finish · ' : ''}x cancel quest · R route` : 'a/Enter accept'} · v jobs on map${quest.employerAt ? ' · w walk to giver' : ''} · ${detail ? 'j k scroll · h list' : 'l text'}`
            : 'Enter open · R route · Esc back',
        );
  const right = createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: detail || route ? 'cyan' : 'gray',
      width: rightW,
      height,
      paddingX: 1,
    },
    ...detailLines,
    createElement(Box, { flexGrow: 1 }),
    keys,
  );
  return createElement(Box, { width, height }, left, right);
}

/** Right panel for the route planner, and how far it scrolls. */
function routeLines({
  state,
  plan,
  route,
  questCount,
  width,
  room,
  scroll,
}: {
  state: GameState;
  plan: RoutePlan;
  route: { scope: RouteScope; objective: RouteObjective };
  questCount: number;
  width: number;
  room: number;
  scroll: number;
}): [React.ReactNode[], number] {
  const out: React.ReactNode[] = [];
  const add = (text: string, props: Record<string, unknown> = {}) =>
    out.push(createElement(Text, { key: out.length, wrap: 'truncate', ...props }, truncate(text, width)));
  const head: React.ReactNode[] = [];
  head.push(
    createElement(
      Text,
      { key: 'h', bold: true, wrap: 'truncate' },
      `Route · ${SCOPE_LABEL[route.scope]} (${questCount} quest${questCount === 1 ? '' : 's'}) · best per ${route.objective}`,
    ),
  );
  const target = plan.totals;
  head.push(
    createElement(
      Text,
      { key: 't', color: 'cyan', wrap: 'truncate' },
      `${target.runs} jobs · ${target.energy} energy · ${formatDuration(target.seconds)} (${formatDuration(target.travel)} travel) · ${target.xp} XP · ${money(target.money)}`,
    ),
  );
  if (plan.energyShort > 0) {
    head.push(
      createElement(
        Text,
        { key: 'en', color: 'yellow', wrap: 'truncate' },
        `Energy: have ${state.character.energy}, ${plan.energyShort} short · ${plan.fitRuns} of ${target.runs} jobs can be queued now`,
      ),
    );
  }
  const label = (entryKey: string) => plan.needs.find((need) => need.key === entryKey)?.label ?? entryKey;
  const unitOf = (entryKey: string) => plan.needs.find((need) => need.key === entryKey)?.unit;
  const fmtGain = (entryKey: string, value: number) =>
    unitOf(entryKey) === 'seconds'
      ? `${formatDuration(value)} ${label(entryKey)}`
      : unitOf(entryKey) === 'runs'
        ? `${value}× ${label(entryKey)}`
        : `~${Math.round(value * 10) / 10} ${label(entryKey)}`;
  add('Needs', { bold: true });
  for (const need of plan.needs) {
    add(
      `  ${need.unit === 'seconds' ? formatDuration(need.amount) : need.amount}${need.unit === 'items' ? '×' : need.unit === 'runs' ? ' runs' : ''} ${need.label} — ${need.quests.join(', ')}`,
      { dimColor: true },
    );
  }
  if (!plan.needs.length) {
    add('  nothing — all requirements met or not job-related', { dimColor: true });
  }
  if (plan.stops.length) {
    add('Stops', { bold: true });
  }
  plan.stops.forEach((source, index) => {
    add(
      `${String(index + 1).padStart(2)}. ${source.job.name} · ${source.runs}× ${DURATION_LABEL[source.duration]} @ ${source.at.x},${source.at.y}`,
      { color: 'magentaBright' },
    );
    add(
      `    ${source.travel ? `walk ${formatDuration(source.travel)} · ` : ''}${source.energy} energy · ${source.xp} XP · ${money(source.money)}`,
      { dimColor: true },
    );
    add(
      `    → ${Object.entries(source.gains)
        .map(([entryKey, value]) => fmtGain(entryKey, value))
        .join(', ')}`,
      { color: 'green' },
    );
  });
  for (const value of plan.unmet) {
    add(`✘ ${value.need.label}: ${value.why}`, { color: 'red' });
  }
  for (const [entryKey, currentValue] of Object.entries(plan.leftover)) {
    add(`… ${label(entryKey)}: ~${Math.round(currentValue * 10) / 10} still open after the run limit`, {
      color: 'yellow',
    });
  }
  if (plan.stops.length) {
    add('Drop amounts are expected values (job window %); re-plan after the jobs finish.', { dimColor: true });
  }
  const body = Math.max(0, room - head.length);
  const maxTop = Math.max(0, out.length - body);
  const top = Math.min(scroll, maxTop);
  return [[...head, ...out.slice(top, top + body)], maxTop];
}

/** Quest detail: "≈ 2h 10m · 24 energy · 3 jobs (12m walking)", with what the estimate can't cover. */
function estimateLines(plan: RoutePlan | undefined, finishable: boolean): React.ReactNode[] {
  if (finishable || !plan || (!plan.stops.length && !plan.unmet.length)) {
    return [];
  }
  const target = plan.totals;
  const out: React.ReactNode[] = [];
  if (plan.stops.length) {
    out.push(
      createElement(
        Text,
        { key: 'est', color: 'cyan', wrap: 'truncate' },
        `≈ ${formatDuration(target.seconds)} · ${target.energy} energy · ${target.runs} job${target.runs === 1 ? '' : 's'}${target.travel ? ` (${formatDuration(target.travel)} walking)` : ''} · R for the route`,
      ),
    );
  }
  if (plan.unmet.length) {
    out.push(
      createElement(
        Text,
        { key: 'estu', color: 'yellow', wrap: 'truncate' },
        `${plan.stops.length ? '+ not from jobs' : 'No job estimate'}: ${plan.unmet.map((value) => value.need.label).join(', ')}`,
      ),
    );
  }
  return out;
}
