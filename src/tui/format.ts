/** Durations and money as the TUI shows them; all pure formatting, no game rules. */
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;
/** Rounding below half a minute up to "1s" reads better than "0s" for a task that just started. */
const SHORTEST_SECOND = 59.5;

const twoDigits = (value: number): string => String(value).padStart(2, '0');

export function formatDuration(totalSeconds: number): string {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / SECONDS_PER_HOUR);
  const minutes = Math.floor((rounded % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = rounded % SECONDS_PER_MINUTE;
  return hours > 0 ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}` : `${minutes}:${twoDigits(seconds)}`;
}

/** A travel time, or "—" while the character position is unknown. */
export const formatTravel = (way: number | null): string => (way === null ? '—' : formatDuration(way));

/** "15s", "45m", "2h10", "3d4h" */
export function shortDuration(seconds: number): string {
  if (seconds < SHORTEST_SECOND) {
    return `${Math.max(1, Math.round(seconds))}s`;
  }
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  if (minutes < SECONDS_PER_MINUTE) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / SECONDS_PER_MINUTE);
  if (hours < 24) {
    return `${hours}h${minutes % SECONDS_PER_MINUTE ? twoDigits(minutes % SECONDS_PER_MINUTE) : ''}`;
  }
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

/** Coarse "2d" / "3h" / "45m" for deadlines and offers; never "0m". */
export function coarseDuration(seconds: number): string {
  if (seconds <= 0) {
    return 'ended';
  }
  if (seconds >= SECONDS_PER_DAY) {
    return `${Math.floor(seconds / SECONDS_PER_DAY)}d`;
  }
  if (seconds >= SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_HOUR)}h`;
  }
  return `${Math.max(1, Math.floor(seconds / SECONDS_PER_MINUTE))}m`;
}

export function bar(value: number, max: number, width: number): string {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const full = Math.round(ratio * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export function money(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Keeps the selected row visible inside a window of `height` rows. */
export function scrollWindow(selected: number, total: number, height: number): [start: number, end: number] {
  if (total <= height) {
    return [0, total];
  }
  const start = Math.min(Math.max(0, selected - Math.floor(height / 2)), total - height);
  return [start, start + height];
}

/** Wall-clock time of an epoch-milliseconds moment: "14:05", or "Tue 14:05" when it is not today. */
export function formatClock(epochSeconds: number, nowSeconds = Date.now() / 1000): string {
  const date = new Date(epochSeconds * 1000);
  const clock = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  if (date.toDateString() === new Date(nowSeconds * 1000).toDateString()) {
    return clock;
  }
  return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}`;
}

/** Local time of day of an epoch-milliseconds moment: "14:05". */
export const formatTimeOfDay = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
