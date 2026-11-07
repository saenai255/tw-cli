// Event screen (g e, only while a seasonal event runs): personal and community rewards, friends who can still
// receive event points, and the bulk send (friendsbar/event_all).

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import { type ActiveEvent, type EventReward, eventFriendAvailable } from '../game/event.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { shortDuration } from './format.ts';

const createElement = React.createElement;

interface EventLine {
  text: string;
  color?: string;
  bold?: boolean;
}

const rewardLine = (reward: EventReward, claimed: boolean, next: boolean, points: number): EventLine => {
  const marker = claimed ? '✓' : next ? '→' : '·';
  const tail = next ? `  (${(reward.at - points).toLocaleString('en-US')} to go)` : '';
  return {
    text: ` ${marker} ${reward.at.toLocaleString('en-US').padStart(8)}  ${reward.text}${tail}`,
    color: claimed ? 'green' : next ? 'yellow' : 'gray',
  };
};

function contentLines(state: ScreenProps['state'], event: ActiveEvent, now: number): EventLine[] {
  const lines: EventLine[] = [];
  const claimed = event.rewards.filter((reward) => reward.at <= event.points).length;
  lines.push({
    text: `Personal rewards · ${claimed}/${event.rewards.length} claimed`,
    color: 'yellow',
    bold: true,
  });
  if (!event.rewards.length) {
    lines.push({ text: '  none', color: 'gray' });
  }
  for (const reward of event.rewards) {
    lines.push(rewardLine(reward, reward.at <= event.points, event.next?.at === reward.at, event.points));
  }

  if (event.communityRewards.length) {
    const unlocked = event.communityRewards.filter((reward) => reward.at <= event.communityPoints).length;
    lines.push({ text: '' });
    lines.push({
      text: `Community rewards · ${unlocked}/${event.communityRewards.length} · ${event.communityPoints.toLocaleString('en-US')} collected`,
      color: 'yellow',
      bold: true,
    });
    for (const reward of event.communityRewards) {
      lines.push(rewardLine(reward, reward.at <= event.communityPoints, false, event.communityPoints));
    }
  }

  lines.push({ text: '' });
  const friendsbar = event.friendsbar;
  if (!friendsbar) {
    lines.push({ text: 'Friend points · this event has none', color: 'gray' });
    return lines;
  }
  const friends = state.eventFriends;
  const eligible = friends?.filter((friend) => eventFriendAvailable(friend, friendsbar.cooldown, now)) ?? [];
  const waiting = (friends?.length ?? 0) - eligible.length;
  const nextAt = Math.min(
    ...(friends ?? [])
      .map((friend) => (friend.activationAt ? friend.activationAt + friendsbar.cooldown : Infinity))
      .filter((at) => at > now),
  );
  lines.push({
    text: `Friends · ${eligible.length} of ${friends?.length ?? 0} can receive · ${friendsbar.label}`,
    color: 'yellow',
    bold: true,
  });
  if (friends === null) {
    lines.push({ text: '  loading friends…', color: 'gray' });
  } else if (eligible.length) {
    for (const friend of eligible) {
      const sent = friend.activationAt
        ? ` · last sent ${shortDuration(Math.max(0, now - friend.activationAt))} ago`
        : '';
      lines.push({ text: `  ${friend.name} · L${friend.level}${sent}` });
    }
  } else {
    lines.push({ text: '  Everyone has received points.', color: 'gray' });
  }
  if (waiting > 0) {
    const next = Number.isFinite(nextAt) ? ` · next in ${shortDuration(Math.max(0, nextAt - now))}` : '';
    lines.push({ text: `  ${waiting} waiting${next}`, color: 'gray' });
  }
  return lines;
}

export function EventScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const event = state.event;
  const [top, setTop] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (event?.friendsbar) {
      void state.loadEventFriends();
    }
  }, [event?.id]);
  useEffect(() => {
    onCapture(confirm);
  }, [confirm, onCapture]);

  const now = state.clock.now();
  const friendsbar = event?.friendsbar;
  const eligible = event
    ? (state.eventFriends ?? []).filter((friend) => eventFriendAvailable(friend, friendsbar?.cooldown ?? 0, now))
    : [];
  const lines = event ? contentLines(state, event, now) : [];
  const bodyH = Math.max(1, height - 4);
  const maxTop = Math.max(0, lines.length - bodyH);
  const start = Math.min(top, maxTop);

  const send = () => {
    if (sending || !eligible.length) {
      return;
    }
    setSending(true);
    void state.sendEventPointsToAll().finally(() => setSending(false));
  };

  useInput(
    (input, key) => {
      if (confirm) {
        if (input === 'y') {
          setConfirm(false);
          send();
        } else {
          setConfirm(false);
        }
        return;
      }
      if (key.escape) {
        return onExit();
      }
      if (key.upArrow || input === 'k') {
        return setTop(Math.max(0, start - 1));
      }
      if (key.downArrow || input === 'j') {
        return setTop(Math.min(maxTop, start + 1));
      }
      if (key.pageUp) {
        return setTop(Math.max(0, start - bodyH));
      }
      if (key.pageDown) {
        return setTop(Math.min(maxTop, start + bodyH));
      }
      if (input === 'a') {
        if (sending || state.busy) {
          return;
        }
        if (state.eventFriends === null) {
          return state.info('Event friends are still loading.');
        }
        if (!eligible.length) {
          return state.info('No friend can receive event points right now.');
        }
        return setConfirm(true);
      }
    },
    { isActive: active },
  );

  if (!event) {
    return createElement(
      Box,
      { flexDirection: 'column', width, height },
      createElement(Text, { color: 'yellow' }, 'No active event.'),
      createElement(Text, { dimColor: true }, 'Esc back'),
    );
  }

  const sent =
    state.eventFriendsSent !== null && state.eventFriendsSent > 0
      ? ` · sent to ${state.eventFriendsSent} friend(s)`
      : '';
  const message = sending
    ? 'Sending event points…'
    : state.eventFriendsMessage
      ? `Last: ${state.eventFriendsMessage}${sent}`
      : state.eventFriendsSent !== null
        ? `Sent to ${state.eventFriendsSent} friend(s).`
        : '';
  const hint = confirm
    ? `${event.friendsbar?.label ?? 'Send event points'} to ${eligible.length} friend(s)? y / n`
    : sending
      ? 'Sending…'
      : 'a send to all · u refresh · j k scroll · Esc back';
  return createElement(
    Box,
    { flexDirection: 'column', width, height },
    createElement(
      Text,
      { bold: true, color: 'magenta', wrap: 'truncate' },
      `${event.name} · ${event.points.toLocaleString('en-US')} points`,
    ),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      `${event.ends ? `ends ${event.ends}` : 'event active'}${
        event.next
          ? ` · next personal reward at ${event.next.at.toLocaleString('en-US')} (${(event.next.at - event.points).toLocaleString('en-US')} to go)`
          : ' · all personal rewards reached'
      }`,
    ),
    createElement(Text, defined({ color: message ? 'green' : undefined, wrap: 'truncate' }), message || ' '),
    createElement(
      Box,
      { flexDirection: 'column', height: bodyH },
      ...lines
        .slice(start, start + bodyH)
        .map((line, index) =>
          createElement(
            Text,
            defined({ key: index, color: line.color, bold: line.bold, wrap: 'truncate' }),
            line.text || ' ',
          ),
        ),
    ),
    createElement(Text, defined({ color: confirm ? 'yellow' : undefined, dimColor: !confirm, wrap: 'truncate' }), hint),
  );
}
