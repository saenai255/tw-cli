// Events screen (g e): seasonal events (currency counter, milestone rewards, friend gifts), community events, the
// Loteria card game (the player plays every step; nothing is automated) and the currency log.

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import {
  CARD_GAME_CARDS,
  CARD_GAME_STAGES,
  type CardGame,
  cardGameActions,
  nextCommunityStage,
  nextGiftAt,
  nextMilestone,
  type PayOption,
  type SeasonalEvent,
} from '../game/events.ts';
import type { GameState } from '../game/state.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { bar, formatClock, shortDuration, truncate } from './format.ts';

const createElement = React.createElement;

export const EVENT_TABS = ['Event', 'Loteria', 'Log'] as const;
type Tab = (typeof EVENT_TABS)[number];

/** A y/n question, or a choice of currency (digits). */
interface Prompt {
  text: string;
  options: { key: string; label: string; run: () => void }[];
}

const count = (value: number) => value.toLocaleString('en');

export function EventsScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('Event');
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const now = state.clock.now();
  const events = state.events;
  const running = events.running(now);
  const logEvent = running[0] ?? events.seasonal[0];
  const session = events.cardGame;

  useEffect(() => {
    if (!state.events.friends) {
      void state.loadFriends();
    }
  }, [state]);
  useEffect(() => {
    if (tab === 'Loteria' && !state.events.cardGame) {
      void state.openCardGame();
    }
    if (tab === 'Log' && logEvent && state.events.log?.eventId !== logEvent.id) {
      void state.loadEventLog(logEvent.id);
    }
  }, [tab, state, logEvent]);
  useEffect(() => {
    onCapture(!!prompt);
  }, [prompt, onCapture]);

  const confirm = (text: string, run: () => void) => setPrompt({ text, options: [{ key: 'y', label: 'yes', run }] });
  const choosePayment = (text: string, options: PayOption[], run: (option: PayOption) => void) => {
    if (!options.length) {
      return state.error(`${text}: the game sent no prices.`);
    }
    setPrompt({
      text,
      options: options.map((option, index) => ({
        key: String(index + 1),
        label: `${count(option.price)} ${option.name}`,
        run: () => run(option),
      })),
    });
  };

  const cardGameKey = (input: string, game: CardGame) => {
    const can = cardGameActions(game);
    if (can.start && input === 's') {
      if (game.freeGames > 0) {
        return void state.playCardGame('open');
      }
      return choosePayment('Start a paid game with', game.start, (option) =>
        state.playCardGame('open', { currency_id: option.currencyId }),
      );
    }
    const card = Number(input);
    if (can.pick && card >= 1 && card <= CARD_GAME_CARDS) {
      return void state.playCardGame('gamble', { card: card - 1 });
    }
    if (can.next && input === 'n') {
      return confirm(
        `Go to stage ${game.stage + 1}? A wrong card there loses ${game.reward.join(', ') || 'the current reward'}.`,
        () => void state.playCardGame('continue'),
      );
    }
    if (can.collect && input === 'c') {
      return confirm(
        `Collect ${game.reward.join(', ') || (game.status === 'lost' ? 'nothing (lost)' : 'the reward')} and end the game?`,
        () => void state.playCardGame('end'),
      );
    }
    if (can.bribe && input === 'b') {
      return choosePayment('Bribe (turn the lost card into a win) for', game.bribe, (option) =>
        state.playCardGame('bribe', { currency_id: option.currencyId }),
      );
    }
    if (can.change && input === 'r') {
      return choosePayment('Reroll the reward for', game.change, (option) =>
        state.playCardGame('change', { currency_id: option.currencyId }),
      );
    }
  };

  useInput(
    (input, key) => {
      if (prompt) {
        const option = prompt.options.find((candidate) => candidate.key === input);
        setPrompt(null);
        option?.run();
        return;
      }
      if (key.escape) {
        return onExit();
      }
      if (key.leftArrow || key.rightArrow || key.tab) {
        const step = key.leftArrow ? -1 : 1;
        const index = (EVENT_TABS.indexOf(tab) + step + EVENT_TABS.length) % EVENT_TABS.length;
        return setTab(EVENT_TABS[index] ?? 'Event');
      }
      if (tab === 'Event' && input === 's') {
        const due = events.giftsDue(now).find((entry) => entry.friends.length);
        if (!due) {
          return state.error('No friend can get event currency now.');
        }
        return confirm(
          `${due.event.gift?.label ?? 'Send'} to ${due.friends.length} friend(s): ${due.friends.map((friend) => friend.name).join(', ')}?`,
          () => void state.sendEventGifts(due.event.id),
        );
      }
      if (tab === 'Loteria' && session) {
        return cardGameKey(input, session.game);
      }
      if (tab === 'Log' && logEvent && events.log) {
        if (input === '>' && events.log.hasNext) {
          return void state.loadEventLog(logEvent.id, events.log.page + 1);
        }
        if (input === '<' && events.log.page > 1) {
          return void state.loadEventLog(logEvent.id, events.log.page - 1);
        }
      }
    },
    { isActive: active },
  );

  const inner = width - 4;
  const tabs = createElement(
    Text,
    { wrap: 'truncate' },
    ...EVENT_TABS.map((name) =>
      createElement(Text, defined({ key: name, inverse: name === tab, bold: name === tab }), ` ${name} `),
    ),
    createElement(Text, { dimColor: true }, '  ← → tab'),
  );
  const lines =
    tab === 'Event'
      ? eventLines(state, now, inner)
      : tab === 'Loteria'
        ? cardGameLines(state, now, inner)
        : logLines(state, logEvent, inner);
  const bodyRows = Math.max(1, height - 5);
  const footer = prompt
    ? createElement(
        Text,
        { color: 'yellow', wrap: 'truncate' },
        `${prompt.text}  ${prompt.options.map((option) => `${option.key} ${option.label}`).join(' · ')} · Esc cancel`,
      )
    : createElement(Text, { dimColor: true, wrap: 'truncate' }, keysFor(tab, session?.game ?? null));
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', width, height, paddingX: 1 },
    tabs,
    ...lines.slice(0, bodyRows).map((line, index) => createElement(Line, { key: index, line, width: inner })),
    createElement(Box, { flexGrow: 1 }),
    footer,
  );
}

interface StyledLine {
  text: string;
  color?: string | undefined;
  dim?: boolean | undefined;
  bold?: boolean | undefined;
}

function Line({ line, width }: { line: StyledLine; width: number }) {
  return createElement(
    Text,
    defined({ color: line.color, dimColor: line.dim, bold: line.bold, wrap: 'truncate' }),
    truncate(line.text, width),
  );
}

function keysFor(tab: Tab, game: CardGame | null): string {
  if (tab === 'Event') {
    return 's send currency to friends now · u refresh · ← → tab · Esc back';
  }
  if (tab === 'Log') {
    return '< > page · ← → tab · Esc back';
  }
  if (!game) {
    return 'u reload · ← → tab · Esc back';
  }
  const can = cardGameActions(game);
  return [
    can.start ? (game.freeGames ? 's free game' : 's start (paid)') : null,
    can.pick ? `1-${CARD_GAME_CARDS} pick a card` : null,
    can.next ? 'n next stage' : null,
    can.collect ? 'c collect' : null,
    can.bribe ? 'b bribe' : null,
    can.change ? 'r reroll reward' : null,
    'u reload · ← → tab · Esc back',
  ]
    .filter(Boolean)
    .join(' · ');
}

const endsIn = (endsAt: number | null, now: number) =>
  endsAt === null ? '' : ` · ends in ${shortDuration(Math.max(0, endsAt - now))} (${formatClock(endsAt, now)})`;

function eventLines(state: GameState, now: number, width: number): StyledLine[] {
  const events = state.events;
  const running = events.running(now);
  const lines: StyledLine[] = [];
  if (!running.length && !events.runningCommunity(now).length) {
    lines.push({ text: 'No event is running.', dim: true });
  }
  for (const event of running) {
    lines.push(...seasonalLines(state, event, now, width), { text: '' });
  }
  for (const event of events.runningCommunity(now)) {
    const next = nextCommunityStage(event);
    lines.push(
      { text: `Community: ${event.name}${endsIn(event.endsAt, now)}`, bold: true },
      {
        text: next
          ? `${bar(event.progress, next.at, 20)} ${count(event.progress)} / ${count(next.at)} (all players)`
          : `${count(event.progress)} · every stage reached`,
      },
      ...event.stages.map((stage) => ({
        text: `${stage.at <= event.progress ? '✓' : ' '} ${count(stage.at).padStart(9)}  ${stage.rewards.join(', ')}`,
        dim: stage.at <= event.progress,
      })),
      { text: '' },
    );
  }
  const wheel = events.cardGameWheel(now);
  if (wheel) {
    lines.push({
      text: `${wheel.title}: ${wheel.free ? `${wheel.free} free game(s), play it in the Loteria tab` : 'no free game now'}${endsIn(wheel.endsAt, now)}`,
      color: wheel.free ? 'green' : undefined,
    });
  }
  return lines;
}

function seasonalLines(state: GameState, event: SeasonalEvent, now: number, width: number): StyledLine[] {
  const next = nextMilestone(event);
  const lines: StyledLine[] = [
    { text: `${event.id}${endsIn(event.endsAt, now)}`, bold: true, color: 'yellow' },
    {
      text: next
        ? `${event.currency} ${count(event.collected)}  ${bar(event.collected, next.at, 20)}  next reward at ${count(next.at)}`
        : `${event.currency} ${count(event.collected)} · every reward collected`,
    },
  ];
  for (const milestone of event.milestones) {
    const reached = milestone.at <= event.collected;
    const reward = milestone.itemId ? state.itemName(milestone.itemId) : milestone.text;
    lines.push({
      text: truncate(
        `${reached ? '✓' : milestone === next ? '›' : ' '} ${count(milestone.at).padStart(8)}  ${reward}`,
        width,
      ),
      dim: reached,
      color: milestone === next ? 'cyan' : undefined,
    });
  }
  if (event.gift) {
    const friends = state.events.friends;
    const autopilot = state.autopilot.config;
    const due = friends ? (state.events.giftsDue(now).find((entry) => entry.event.id === event.id)?.friends ?? []) : [];
    const nextAt = friends ? nextGiftAt(friends, state.events.activations, event) : null;
    lines.push(
      { text: '' },
      { text: `Friends: ${event.gift.label} (each friend every ${shortDuration(event.gift.cooldown)})`, bold: true },
      {
        text: !friends
          ? 'Reading the friends list…'
          : !friends.length
            ? 'No friends on your list.'
            : due.length
              ? `${due.length} of ${friends.length} can get it now: ${due.map((friend) => friend.name).join(', ')}`
              : `All ${friends.length} sent${nextAt ? `; next at ${formatClock(nextAt, now)}` : ''}`,
        color: due.length ? 'green' : undefined,
      },
      {
        text: `Autopilot: ${!autopilot.modules.eventGifts ? 'off (g a)' : !autopilot.running ? 'paused, sends nothing (g a, R)' : autopilot.modules.dryRun ? 'dry run, sends nothing' : 'sends to all eligible friends (checks every 10 min)'}`,
        dim: true,
      },
    );
  }
  return lines;
}

function cardGameLines(state: GameState, now: number, width: number): StyledLine[] {
  const wheel = state.events.cardGameWheel(now);
  const session = state.events.cardGame;
  if (!wheel) {
    const other = state.events.wheels.find((candidate) => candidate.endsAt > now);
    return [
      {
        text: other ? `${other.title} is a wheel the TUI cannot play; use the browser.` : 'No Loteria running.',
        dim: true,
      },
    ];
  }
  if (!session) {
    return [{ text: `${wheel.title}: loading…`, dim: true }];
  }
  const game = session.game;
  const stages = Array.from({ length: CARD_GAME_STAGES }, (_unused, index) => {
    const stage = index + 1;
    const cleared = stage < game.stage || (stage === game.stage && (game.status === 'won' || game.status === 'bribed'));
    return stage === game.stage && game.status !== 'closed' ? `[${stage}]` : cleared ? `✓${stage}` : ` ${stage} `;
  }).join(' ');
  const statusText: Record<CardGame['status'], string> = {
    closed: game.freeGames
      ? `No game running · ${game.freeGames} free game(s)`
      : 'No game running · next free game tomorrow',
    running: `Stage ${game.stage}: pick one of ${CARD_GAME_CARDS} cards`,
    won: `Stage ${game.stage} won: collect it, or go on and risk it`,
    bribed: `Stage ${game.stage} won (bribed): collect it, or go on and risk it`,
    lost: `Stage ${game.stage} lost: collect what is left, or bribe`,
  };
  const lines: StyledLine[] = [
    { text: `${wheel.title}${endsIn(wheel.endsAt, now)}`, bold: true, color: 'yellow' },
    {
      text: statusText[game.status],
      color: game.status === 'lost' ? 'red' : game.status === 'closed' ? undefined : 'green',
    },
    { text: `Stages ${stages}` },
  ];
  if (game.status === 'running') {
    lines.push({ text: Array.from({ length: CARD_GAME_CARDS }, (_unused, index) => `[ ${index + 1} ]`).join('  ') });
  }
  if (game.reward.length) {
    lines.push({ text: `Current reward: ${game.reward.join(', ')}`, color: 'cyan' });
  }
  lines.push({ text: '' }, { text: 'Reward pools', bold: true });
  game.pools.forEach((pool, index) => {
    lines.push({
      text: truncate(`${index + 1 === game.stage ? '›' : ' '} stage ${index + 1}: ${pool.join(', ') || '—'}`, width),
      dim: index + 1 !== game.stage,
    });
  });
  return lines;
}

function logLines(state: GameState, event: SeasonalEvent | undefined, width: number): StyledLine[] {
  const log = state.events.log;
  if (!event) {
    return [{ text: 'No event.', dim: true }];
  }
  if (!log || log.eventId !== event.id) {
    return [{ text: `${event.id} log: loading…`, dim: true }];
  }
  const rows: StyledLine[] = [
    { text: `${event.id} · ${event.currency} log · page ${log.page}${log.hasNext ? ' (more: >)' : ''}`, bold: true },
  ];
  if (!log.entries.length) {
    rows.push({ text: 'Nothing logged.', dim: true });
  }
  for (const entry of log.entries) {
    const when = new Date(entry.at * 1000).toISOString().slice(5, 16).replace('T', ' ');
    const value = `${entry.value > 0 ? '+' : ''}${count(entry.value)}`.padStart(8);
    rows.push({
      text: truncate(`${when}  ${value}  ${entry.text}`, width),
      color: entry.value < 0 ? 'red' : undefined,
    });
  }
  return rows;
}
