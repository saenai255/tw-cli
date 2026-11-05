// Home screen (g h, the start screen): what the character is doing now and what is queued. No browser
// counterpart; it gathers the header, task queue, report list and chat the web shows in separate windows.
// Layout: working · session · task queue (left) | minimap · reports (right) · chat (bottom, interactive).

import { Box, type DOMElement, measureElement, Text, useInput } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { GameState } from '../game/state.ts';
import { regenSeconds } from '../game/timeline.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { ChatPanel, chatRoomIds } from './chat.ts';
import { bar, formatDuration, formatTimeOfDay, money, truncate } from './format.ts';
import { ICON, stepIcon, taskIcon } from './icons.ts';
import { buildGrid, ZOOMS } from './map.ts';
import { QueuePane } from './queue.ts';

const createElement = React.createElement;
/** How long the "done" line shows after a task ends. */
const DONE_S = 30;

/** Server seconds → local "14:32". */
const clockTime = (seconds: number) => formatTimeOfDay(seconds * 1000);
const perHour = (amount: number) => Math.round(amount).toLocaleString('en-US');
/** A report summary on one line, so a list row cannot grow tall. */
const oneLine = (summary: string) => summary.replace(/\s*\n\s*/g, ' · ');

export function HomeScreen({ state, width, height, onCapture, active = true }: ScreenProps) {
  const [room, setRoom] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [zoom, setZoom] = useState(128);
  // The queue panel gets what the working and session panels leave: measured after layout.
  const queueBox = useRef<DOMElement>(null);
  const [queueRows, setQueueRows] = useState(3);
  useEffect(() => {
    if (!queueBox.current) {
      return;
    }
    const rows = Math.max(1, measureElement(queueBox.current).height - 2);
    if (rows !== queueRows) {
      setQueueRows(rows);
    }
  });

  useEffect(() => {
    onCapture(draft !== null || confirm);
  }, [draft, confirm]);
  useEffect(() => () => onCapture(false), []);

  // Reports: one read on first show; then the live "new report" push refreshes them (announceNewReport).
  // Without live updates, re-read a few seconds after a job ends, when its report has been written.
  useEffect(() => {
    if (state.recentReports === null) {
      void state.loadRecentReports();
    }
  }, []);
  useEffect(() => {
    if (!state.rates.jobsDone || state.live?.active) {
      return;
    }
    const target = setTimeout(() => void state.loadRecentReports(), 5000);
    return () => clearTimeout(target);
  }, [state.rates.jobsDone]);

  useInput(
    (input, key) => {
      if (confirm) {
        if (input === 'y') {
          void state.cancel(0);
        }
        return setConfirm(false);
      }
      if (draft !== null) {
        if (key.escape) {
          return setDraft(null);
        }
        if (key.return) {
          const id = chatRoomIds(state)[room];
          setDraft(null);
          if (id && draft.trim()) {
            void state.chatSay(id, draft);
          }
          return;
        }
        if (key.backspace || key.delete) {
          return setDraft(draft.slice(0, -1));
        }
        if (input && !key.ctrl && !key.meta) {
          setDraft(draft + input);
        }
        return;
      }
      const count = chatRoomIds(state).length;
      if (key.leftArrow || input === 'h') {
        return setRoom((index) => (count ? (Math.min(index, count - 1) + count - 1) % count : 0));
      }
      if (key.rightArrow || input === 'l') {
        return setRoom((index) => (count ? (Math.min(index, count - 1) + 1) % count : 0));
      }
      if (key.return) {
        if (!state.live?.active) {
          return state.error('Live updates are off: press g L to connect to chat.');
        }
        if (!count) {
          return state.error('No chat room yet (still connecting).');
        }
        return setDraft('');
      }
      if ((input === 'c' || key.delete) && state.queue[0]) {
        return setConfirm(true);
      }
      if (input === '+' || input === '=') {
        return setZoom((value) => ZOOMS[Math.max(0, ZOOMS.indexOf(value) - 1)] ?? value);
      }
      if (input === '-' || input === '_') {
        return setZoom((value) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(value) + 1)] ?? value);
      }
    },
    { isActive: active },
  );

  // Small terminals drop panels: chat first, then the right column (minimap, reports).
  const chatH = height >= 23 ? Math.max(6, Math.floor(height * 0.3)) : 0;
  const topH = height - chatH;
  const wide = width >= 96;
  const leftW = wide ? Math.max(48, Math.floor(width * 0.5)) : width;
  const rightW = width - leftW;
  const valueMap = Math.max(6, Math.floor(topH * 0.5));

  return createElement(
    Box,
    { flexDirection: 'column', width, height },
    createElement(
      Box,
      { height: topH },
      createElement(
        Box,
        { flexDirection: 'column', width: leftW, height: topH },
        createElement(WorkingPanel, { state, width: leftW, confirm }),
        createElement(SessionPanel, { state, width: leftW }),
        createElement(
          Box,
          { ref: queueBox, flexGrow: 1, flexDirection: 'column', overflow: 'hidden' },
          createElement(QueuePane, {
            state,
            selected: 0,
            focused: false,
            width: leftW,
            confirm: false,
            maxRows: queueRows,
          }),
        ),
      ),
      wide
        ? createElement(
            Box,
            { flexDirection: 'column', width: rightW, height: topH },
            createElement(Minimap, { state, width: rightW, height: valueMap, zoom }),
            createElement(ReportsPanel, { state, width: rightW, height: topH - valueMap }),
          )
        : null,
    ),
    chatH ? createElement(ChatPanel, { state, width, height: chatH, focused: true, roomIdx: room, draft }) : null,
  );
}

/** The queue head: progress, time left, expected rewards; idle and the autopilot's next step otherwise. */
function WorkingPanel({ state, width, confirm }: { state: GameState; width: number; confirm: boolean }) {
  const now = state.clock.now();
  const head = state.queue[0];
  const fieldWidth = width - 4;
  const rows: React.ReactNode[] = [];
  const last = state.rates.lastTask;
  if (last && now - last.end < DONE_S) {
    // The job report is usually there by now (live push or the re-read above): show what it paid.
    const rep = state.recentReports?.find((report) => report.title.includes(last.title));
    const paid = rep ? ` · ${oneLine(rep.summary)}` : '';
    rows.push(createElement(Text, { key: 'done', color: 'green', wrap: 'truncate' }, `✓ ${last.title} done${paid}`));
  }
  let title = 'Idle';
  if (!head) {
    rows.push(
      createElement(
        Text,
        { key: 'idle', color: 'yellow', wrap: 'truncate' },
        last ? `Nothing queued for ${formatDuration(now - last.end)}` : 'Nothing queued',
        createElement(Text, { dimColor: true }, ' · g j jobs · g a autopilot'),
      ),
    );
  } else {
    const way = head.way;
    const walking = way !== undefined && way.end > now;
    const from = way ? (walking ? way.start : way.end) : head.start;
    const to = walking && way ? way.end : head.end;
    const ratio = to > from ? Math.min(1, Math.max(0, (now - from) / (to - from))) : 1;
    const query = head.type === 'job' ? state.queuedJob(head) : null;
    title = walking
      ? `${ICON.walk} Walking`
      : head.type === 'job'
        ? `${ICON.job} Working`
        : head.type === 'sleep'
          ? `${ICON.sleep} Sleeping`
          : `${taskIcon(head.type)} ${head.title}`;
    rows.push(
      createElement(
        Text,
        { key: 't', bold: true, wrap: 'truncate' },
        walking ? `${ICON.walk} ${head.title}` : head.title,
        createElement(
          Text,
          { dimColor: true, bold: false },
          ` · ${head.coords.x},${head.coords.y} · ${formatDuration(head.end - (head.way?.end ?? head.start))}`,
        ),
      ),
    );
    rows.push(
      createElement(
        Text,
        { key: 'bar', wrap: 'truncate' },
        createElement(Text, { color: walking ? 'cyan' : 'green' }, bar(ratio, 1, Math.max(8, fieldWidth - 28))),
        ` ${String(Math.floor(ratio * 100)).padStart(3)}%  ${formatDuration(to - now)} left (${clockTime(to)})`,
      ),
    );
    if (query) {
      const job = query.values;
      const luck =
        query.job.luckValue[1] > 0 ? `  luck ${money(query.job.luckValue[0])}–${money(query.job.luckValue[1])}` : '';
      rows.push(
        createElement(
          Text,
          { key: 'r', wrap: 'truncate' },
          createElement(Text, { color: 'green' }, `+${job.experience} xp  ${money(job.money)}`),
          luck,
          query.job.danger !== null
            ? createElement(
                Text,
                defined({ color: query.job.danger >= 50 ? 'red' : undefined }),
                `  danger ${query.job.danger}%`,
              )
            : '',
        ),
      );
      const drops = (
        job.items?.length
          ? job.items.map((index) => ({ name: state.itemName(index.itemId), percent: index.percent as number | null }))
          : state.jobProducts(query.job)
      )
        .map((pick) => `${pick.name}${pick.percent !== null ? ` ${pick.percent}%` : ''}`)
        .join(' · ');
      if (drops) {
        rows.push(createElement(Text, { key: 'd', color: 'magenta', wrap: 'truncate' }, `Drops: ${drops}`));
      }
    }
    const next = state.queue[1];
    if (next) {
      const end = state.queue[state.queue.length - 1]?.end ?? next.end;
      const more = state.queue.length > 2 ? ` (+${state.queue.length - 2} more)` : '';
      rows.push(
        createElement(
          Text,
          { key: 'n', dimColor: true, wrap: 'truncate' },
          `then ${truncate(next.title, Math.max(8, fieldWidth - 30))}${more} · queue ends ${clockTime(end)}`,
        ),
      );
    }
  }
  const cfg = state.autopilot.config;
  const plan = state.runner.plan;
  if (cfg.running || plan) {
    const next = plan?.tasks[0];
    const status = cfg.running ? (cfg.modules.dryRun ? 'dry run' : 'running') : 'paused';
    rows.push(
      createElement(
        Text,
        { key: 'ap', wrap: 'truncate' },
        createElement(Text, { color: cfg.running ? 'green' : 'yellow' }, `autopilot ${status}`),
        createElement(
          Text,
          { dimColor: true },
          next
            ? ` · ${cfg.running ? 'next' : 'would do'}: ${stepIcon(next.step, next.action)} ${next.step.title} (${next.why ?? plan?.why ?? ''})`
            : plan
              ? ` · ${plan.why}`
              : ' · planning…',
        ),
      ),
    );
  }
  if (confirm && head) {
    rows.push(createElement(Text, { key: 'cf', color: 'red', wrap: 'truncate' }, `Cancel ${head.title}? y / n`));
  }
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width, paddingX: 1, flexShrink: 0 },
    createElement(Text, { bold: true, color: 'cyan' }, title),
    ...rows,
  );
}

/** Measured XP/h and $/h (rolling hour), what the queue would pay, level and regen ETAs. */
function SessionPanel({ state, width }: { state: GameState; width: number }) {
  const now = state.clock.now();
  const character = state.character;
  const result = state.rates.rates(now, character.experience, character.cash + character.deposit);
  const first = state.rates.first;
  const tl = state.queue.length ? state.timeline() : null;
  const left = tl ? tl.end - now : 0;
  const pick = character.progress;
  const eta =
    result && result.xpH > 0 && !pick.maxed
      ? ` · lvl ${character.level + 1} in ~${formatDuration(Math.round(((pick.need - pick.have) / result.xpH) * 3600))}`
      : '';
  const full = (have: number, max: number, rate: number) => {
    const value = regenSeconds(have, max, max, rate);
    return value === 0 ? 'full' : Number.isFinite(value) ? `full ${clockTime(now + value)}` : '—';
  };
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, paddingX: 1, flexShrink: 0 },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      'Session',
      createElement(
        Text,
        { dimColor: true, bold: false },
        ` · ${state.rates.jobsDone} job(s) · ${first ? formatDuration(now - first.t) : '0s'}`,
      ),
    ),
    createElement(
      Text,
      { wrap: 'truncate' },
      createElement(
        Text,
        { color: 'green' },
        result ? `${perHour(result.xpH)} xp/h  ${money(Math.round(result.moneyH))}/h` : 'measuring…',
      ),
      createElement(
        Text,
        { dimColor: true },
        result ? ` (last ${formatDuration(result.span)})${eta}` : ' (needs 5 min)',
      ),
    ),
    tl && left > 60
      ? createElement(
          Text,
          { dimColor: true, wrap: 'truncate' },
          `queued: ${perHour((tl.gained.xp * 3600) / left)} xp/h ${money(Math.round((tl.gained.money * 3600) / left))}/h until ${clockTime(tl.end)}`,
        )
      : null,
    createElement(
      Text,
      { wrap: 'truncate' },
      createElement(Text, { color: 'cyan' }, 'EN '),
      full(character.energy, character.maxEnergy, character.energyRegen),
      '   ',
      createElement(Text, { color: 'red' }, 'HP '),
      full(character.health, character.maxHealth, character.healthRegen),
    ),
  );
}

/** The map around the character (zoom with + / -); m opens the full map. */
function Minimap({ state, width, height, zoom }: { state: GameState; width: number; height: number; zoom: number }) {
  const cols = Math.max(10, width - 2);
  const rows = Math.max(2, height - 3);
  const grid = buildGrid(state, { ...state.character.position, zoom }, cols, rows);
  const county = state.world.countyAt(state.character.position);
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width, height, flexShrink: 0 },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      ` ${county?.name ?? 'Map'}`,
      createElement(Text, { dimColor: true, bold: false }, ` · ${zoom}px · +/- zoom · m map`),
    ),
    ...grid.map((segs, value) =>
      createElement(
        Text,
        { key: value, wrap: 'truncate' },
        ...segs.map((source, index) =>
          createElement(
            Text,
            defined({ key: index, color: source.color, dimColor: source.dim, bold: source.bold }),
            source.inverse && source.text === '+' ? ' ' : source.text,
          ),
        ),
      ),
    ),
  );
}

/** Newest reports (all folders): title, then the list summary (rewards, items found). */
function ReportsPanel({ state, width, height }: { state: GameState; width: number; height: number }) {
  const list = state.recentReports;
  const shown = list?.slice(0, Math.max(1, Math.floor((height - 3) / 2))) ?? [];
  const unread = list?.filter((report) => !report.read).length ?? 0;
  const fieldWidth = width - 4;
  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'gray',
      width,
      height,
      paddingX: 1,
      overflow: 'hidden',
    },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      'Reports',
      createElement(Text, { dimColor: true, bold: false }, `${unread ? ` · ${unread} unread` : ''} · M all`),
    ),
    list === null
      ? createElement(Text, { dimColor: true }, 'Loading…')
      : list.length
        ? null
        : createElement(Text, { dimColor: true }, 'No reports.'),
    ...shown.flatMap((report) => [
      createElement(
        Text,
        { key: `${report.id}t`, bold: !report.read, wrap: 'truncate' },
        truncate(`${report.read ? ' ' : '•'}${report.title}`, fieldWidth - report.date.length - 1),
        createElement(Text, { dimColor: true, bold: false }, ` ${report.date}`),
      ),
      createElement(Text, { key: `${report.id}s`, dimColor: true, wrap: 'truncate' }, `  ${oneLine(report.summary)}`),
    ]),
  );
}
