// One-cell symbols used across the TUI. Only text-presentation characters (no emoji): emoji are two cells
// wide in most terminals and Ink would misalign columns.
import type { TimelineStep } from '../game/timeline.ts';

export const ICON = {
  job: '⚒',
  walk: '→',
  sleep: '☾',
  bank: '$',
  item: '✚',
  wait: '◷',
  level: '★',
  duel: '⚔',
  quest: '!',
  mail: '✉',
  event: '❀',
  done: '✓',
  fail: '✘',
  action: '•',
} as const;

const TASK_ICONS: Record<string, string> = { job: ICON.job, walk: ICON.walk, sleep: ICON.sleep };

/** Icon for a queue task type from the server (job, walk, sleep, duel, …). */
export function taskIcon(type: string): string {
  return TASK_ICONS[type] ?? (/duel/.test(type) ? ICON.duel : ICON.action);
}

/** The server starts these action titles with the action's name; use that when the plan has no action. */
const DEPOSIT_TITLE = /^Deposit/;
const USE_TITLE = /^Use /;

/** Icon for a planned or projected step; `action` tells deposits from item uses. */
export function stepIcon(step: TimelineStep, action?: { type: string }): string {
  if (step.kind !== 'action') {
    return taskIcon(step.kind);
  }
  if (action?.type === 'deposit' || DEPOSIT_TITLE.test(step.title)) {
    return ICON.bank;
  }
  if (action?.type === 'use' || USE_TITLE.test(step.title)) {
    return ICON.item;
  }
  return ICON.action;
}
