// Duels screen (g d): NPC duels (fought at once) and players in duel range (queued as a duel task).

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import type { DuelNpc, DuelOpponent } from '../game/duels.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { formatDuration, formatTravel, scrollWindow, truncate } from './format.ts';

const createElement = React.createElement;

type Row = { kind: 'npc'; npc: DuelNpc } | { kind: 'player'; o: DuelOpponent } | { kind: 'head'; text: string };

export function DuelsScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [sel, setSel] = useState(1);
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);

  useEffect(() => {
    void (async () => {
      await state.loadItems();
      await state.loadDuels();
    })();
  }, [state]);
  useEffect(() => {
    onCapture(!!confirm);
  }, [confirm]);

  const duels = state.duels;
  const rows: Row[] = [
    { kind: 'head', text: `NPC duels${duels?.difficulty ? ` · difficulty ${duels.difficulty}` : ''}` },
    ...(duels?.npcs ?? []).map((npc) => ({ kind: 'npc', npc }) as Row),
    { kind: 'head', text: 'Players in range (2 h walk)' },
    ...state.duelOpponents.map((opponent) => ({ kind: 'player', o: opponent }) as Row),
  ];
  const selectable = (index: number) => rows[index] !== undefined && rows[index]?.kind !== 'head';
  const move = (from: number, direction: 1 | -1) => {
    for (let index = from; index >= 0 && index < rows.length; index += direction) {
      if (selectable(index)) {
        return index;
      }
    }
    return sel;
  };
  const idx = selectable(sel) ? sel : move(Math.min(sel, rows.length - 1), 1);
  const selected = rows[idx];

  useInput(
    (input, key) => {
      if (confirm) {
        setConfirm(null);
        if (input === 'y') {
          confirm.run();
        }
        return;
      }
      if (key.escape) {
        return onExit();
      }
      if (key.upArrow || input === 'k') {
        return setSel(move(idx - 1, -1));
      }
      if (key.downArrow || input === 'j') {
        return setSel(move(idx + 1, 1));
      }
      if (!selected || !key.return) {
        return;
      }
      if (selected.kind === 'npc') {
        if (selected.npc.readyIn > 0) {
          return state.error(`${selected.npc.name} is ready in ${formatDuration(selected.npc.readyIn)}.`);
        }
        return setConfirm({
          text: `Duel ${selected.npc.name} (level ${selected.npc.level}) now?`,
          run: () => void state.fightNpc(selected.npc.id),
        });
      }
      if (selected.kind === 'player') {
        const character = state.character;
        const allianceHint = selected.o.allianceId && character.homeTown ? ' (check: may be an alliance member)' : '';
        return setConfirm({
          text: `Queue a duel against ${selected.o.name} (duel level ${selected.o.duelLevel})${allianceHint}?`,
          run: () => void state.duelPlayer(selected.o),
        });
      }
    },
    { isActive: active },
  );

  const leftW = Math.max(30, Math.floor(width * 0.45));
  const rightW = width - leftW;
  const [start, end] = scrollWindow(idx, rows.length, Math.max(2, height - 4));
  const left = createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height, paddingX: 1 },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `Duels · motivation ${Math.round((duels?.motivation ?? 0) * 100)}% · NPC ${Math.round((duels?.npcMotivation ?? 0) * 100)}%`,
    ),
    ...rows.slice(start, end).map((result, innerIndex) => {
      const count = start + innerIndex;
      if (result.kind === 'head') {
        return createElement(Text, { key: `h${count}`, bold: true, color: 'yellow', wrap: 'truncate' }, result.text);
      }
      if (result.kind === 'npc') {
        return createElement(
          Text,
          defined({
            key: `n${result.npc.id}`,
            inverse: count === idx,
            color: result.npc.readyIn > 0 ? 'gray' : undefined,
            wrap: 'truncate',
          }),
          `  ${truncate(result.npc.name, leftW - 22)} L${String(result.npc.level).padStart(3)} ${result.npc.readyIn > 0 ? formatDuration(result.npc.readyIn).padStart(8) : '   ready'}`,
        );
      }
      return createElement(
        Text,
        { key: `p${result.o.playerId}`, inverse: count === idx, wrap: 'truncate' },
        `  ${truncate(result.o.name, leftW - 24)} L${String(result.o.duelLevel).padStart(3)} ${formatTravel(state.travelTo(result.o)).padStart(8)}`,
      );
    }),
    !duels ? createElement(Text, { dimColor: true }, 'Loading…') : null,
  );

  const lines: React.ReactNode[] = [];
  if (selected?.kind === 'npc') {
    const weapon = selected.npc.weaponId ? state.itemName(selected.npc.weaponId) : '—';
    lines.push(
      createElement(Text, { key: 'n', bold: true }, selected.npc.name),
      createElement(Text, { key: 'l' }, `Level ${selected.npc.level} · weapon ${weapon}`),
    );
  } else if (selected?.kind === 'player') {
    lines.push(
      createElement(Text, { key: 'n', bold: true }, selected.o.name),
      createElement(
        Text,
        { key: 'l', wrap: 'truncate' },
        `Duel level ${selected.o.duelLevel}${selected.o.town ? ` · ${selected.o.town}` : ''}`,
      ),
      createElement(
        Text,
        { key: 'w', dimColor: true, wrap: 'truncate' },
        `at ${selected.o.x},${selected.o.y} · ${formatTravel(state.travelTo(selected.o))} walk (the duel task walks there)`,
      ),
    );
  }
  const last = state.lastNpcDuel;
  if (last) {
    lines.push(
      createElement(Text, { key: 'sp' }, ' '),
      createElement(Text, { key: 'lr', bold: true }, 'Last NPC duel'),
    );
    last.rounds.slice(0, Math.max(0, height - 12)).forEach((result, innerIndex) => {
      lines.push(
        createElement(
          Text,
          { key: `r${innerIndex}`, wrap: 'truncate' },
          `  round ${innerIndex + 1}: you ${result.own !== null ? `-${result.own} HP` : 'no hit'} · them ${result.other !== null ? `-${result.other} HP` : 'no hit'}`,
        ),
      );
    });
    lines.push(
      createElement(Text, { key: 'res', color: last.died ? 'red' : 'green', wrap: 'wrap' }, last.result || '—'),
    );
  }
  const keys = confirm
    ? createElement(Text, { color: 'yellow', wrap: 'truncate' }, `${confirm.text} y / n`)
    : createElement(Text, { dimColor: true, wrap: 'truncate' }, 'Enter duel · u refresh · Esc back');
  const right = createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: rightW, height, paddingX: 1 },
    ...lines,
    createElement(Box, { flexGrow: 1 }),
    keys,
  );
  return createElement(Box, { width, height }, left, right);
}
