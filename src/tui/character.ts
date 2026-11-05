// Character screen: Inventory (equipped slots + bag) and Skills (attributes/skills, spend free points).

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import type { BagItem, EquipSet } from '../game/inventory.ts';
import { bonusText, SLOT_NAMES, WEAR_SLOTS } from '../game/items.ts';
import type { ItemStats, StatKind } from '../game/itemstats.ts';
import {
  ATTRIBUTE_COLOR,
  ATTRIBUTE_OF,
  ATTRIBUTES,
  adjustPlan,
  emptyPlan,
  NAMES,
  plannedDelta,
  planUsed,
  SKILLS_OF,
  type SkillPlan,
} from '../game/skills.ts';
import type { GameState } from '../game/state.ts';
import { defined } from '../util/defined.ts';
import { type FormState, FormView, formKey, formValues, makeForm } from './form.ts';
import { money, scrollWindow, truncate } from './format.ts';

const createElement = React.createElement;

export type CharTab = 'inventory' | 'sets' | 'skills';
const CHAR_TABS: CharTab[] = ['inventory', 'sets', 'skills'];
const TAB_LABEL: Record<CharTab, string> = { inventory: 'Inventory', sets: 'Sets', skills: 'Skills' };
const TYPE_FILTERS = ['all', ...WEAR_SLOTS, 'collection', 'recipe'];
/** Wear slots first, in the game's order; everything else after them. */
const wearOrder = (type: string): number => {
  const index = WEAR_SLOTS.indexOf(type);
  return index < 0 ? WEAR_SLOTS.length : index;
};

export interface ScreenProps {
  state: GameState;
  width: number;
  height: number;
  /** True while the screen takes text input / confirmation (global shortcuts off). */
  onCapture: (capturing: boolean) => void;
  onExit: () => void;
  /** False while an overlay covers the screen. */
  active?: boolean;
}

const TOTAL_LABEL: Record<string, string> = {
  damage_min: 'min damage',
  damage_max: 'max damage',
  job: 'labor points',
  speed: '% speed',
  luck: '% luck',
  dollar: '% money',
  experience: '% experience',
  drop: '% drop chance',
  regen: '% regeneration',
  pray: 'praying',
  damage: 'damage',
  fort_offense: 'attack (fort)',
  fort_defense: 'defense (fort)',
  fort_resistance: 'resistance (fort)',
  fort_offense_sector: 'attack (sector)',
  fort_defense_sector: 'defense (sector)',
  fort_damage_sector: 'damage (sector)',
};
const PERCENT_KEYS = new Set(['luck', 'dollar', 'experience', 'drop', 'regen']);

/** Difference if `item` replaced `worn`, from the web's computed totals (upgrade + per-level values). */
export function gearDelta(item: ItemStats | null | undefined, worn: ItemStats | null | undefined): string {
  if (!item) {
    return '';
  }
  const keys = new Set([...Object.keys(item.totals), ...Object.keys(worn?.totals ?? {})]);
  const parts: string[] = [];
  for (const entryKey of keys) {
    let diff = (item.totals[entryKey] ?? 0) - (worn?.totals[entryKey] ?? 0);
    if (PERCENT_KEYS.has(entryKey)) {
      diff *= 100;
    }
    diff = Math.round(diff * 100) / 100;
    if (diff) {
      parts.push(`${diff > 0 ? '+' : ''}${diff} ${NAMES[entryKey] ?? TOTAL_LABEL[entryKey] ?? entryKey}`);
    }
  }
  return parts.join(', ');
}

/** What `/` matches: name, slot, set, "L<level>", and bonus texts ("trading", "+5 construction"). */
function itemSearchText(state: GameState, it: BagItem): string {
  const entry = state.items?.get(it.itemId);
  return [
    state.itemName(it.itemId),
    SLOT_NAMES[entry?.type ?? it.type] ?? it.type,
    entry?.set ?? '',
    entry?.level ? `L${entry.level}` : '',
    entry ? bonusText(entry, it.itemId, state.statContext) : '',
  ]
    .join(' | ')
    .toLowerCase();
}

function bagRows(state: GameState, typeFilter: string, filter: string): BagItem[] {
  const needle = filter.trim().toLowerCase();
  return state.inventory
    .items()
    .filter((item) => typeFilter === 'all' || (state.items?.get(item.itemId)?.type ?? item.type) === typeFilter)
    .filter((item) => !needle || itemSearchText(state, item).includes(needle))
    .sort(
      (first, second) =>
        wearOrder(first.type) - wearOrder(second.type) ||
        state.itemName(first.itemId).localeCompare(state.itemName(second.itemId)),
    );
}

export function CharacterScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [tab, setTab] = useState<CharTab>('inventory');
  const [pane, setPane] = useState<'wear' | 'bag'>('bag');
  const [wearSel, setWearSel] = useState(0);
  const [bagSel, setBagSel] = useState(0);
  const [typeIdx, setTypeIdx] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [skillSel, setSkillSel] = useState(0);
  const [plan, setPlan] = useState<SkillPlan>(emptyPlan);
  const [confirm, setConfirm] = useState(false);
  const [detailScroll, setDetailScroll] = useState(0);
  /** l: j k scroll the item detail instead of moving in the list. */
  const [detail, setDetail] = useState(false);
  const [useForm, setUseForm] = useState<{ itemId: number; form: FormState } | null>(null);
  const [setSel, setSetSel] = useState(0);
  const [setSwitch, setSetSwitch] = useState<EquipSet | null>(null);
  const [setForm, setSetForm] = useState<FormState | null>(null);
  const [setReplace, setSetReplace] = useState<EquipSet | null>(null);

  useEffect(() => {
    void (async () => {
      await state.loadItems();
      await state.refreshSkills();
    })();
  }, [state]);
  useEffect(() => {
    onCapture(filtering || confirm || !!useForm || !!setSwitch || !!setForm || !!setReplace);
  }, [filtering, confirm, useForm, setSwitch, setForm, setReplace]);
  useEffect(() => {
    if (tab === 'sets') {
      void state.loadEquipSets();
    }
  }, [tab, state]);

  const typeFilter = TYPE_FILTERS[typeIdx] ?? 'all';
  // New selection → detail panel back to the top.
  useEffect(() => setDetailScroll(0), [bagSel, wearSel, pane, typeIdx, filter]);
  const rows = useMemo(
    () => bagRows(state, typeFilter, filter),
    [state, state.items, state.inventory, state.inventory.bag.size, typeFilter, filter, state.log.length],
  );
  const bagIdx = Math.min(bagSel, Math.max(0, rows.length - 1));
  const skillRows = ATTRIBUTES.flatMap((first) => [first, ...SKILLS_OF[first]]);
  const used = planUsed(plan);

  const askUse = (it: BagItem) => {
    const entry = state.items?.get(it.itemId);
    if (entry && entry.usetype === 'none') {
      return state.error(`${entry.name} cannot be used.`);
    }
    const many = it.count > 1 && entry?.usetype !== 'single';
    return setUseForm({
      itemId: it.itemId,
      form: makeForm(`Use ${state.itemName(it.itemId)}${it.count > 1 ? ` (you have ${it.count})` : ''}?`, [
        many
          ? { key: 'count', label: 'Number of items', value: '1', kind: 'number', hint: `max ${it.count}` }
          : { key: 'count', label: 'Use', value: '1', kind: 'choice', options: ['1'] },
      ]),
    });
  };

  useInput(
    (input, key) => {
      if (useForm) {
        const form = formKey(useForm.form, input, key);
        if (form === 'cancel') {
          return setUseForm(null);
        }
        if (form !== 'submit') {
          return setUseForm({ ...useForm, form: form });
        }
        const countValue = Math.max(1, Number(formValues(useForm.form).count) || 1);
        setUseForm(null);
        // biome-ignore lint/correctness/useHookAtTopLevel: state.useItem is a game action, not a React hook
        return void state.useItem(useForm.itemId, countValue);
      }
      if (setForm) {
        const result = formKey(setForm, input, key);
        if (result === 'cancel') {
          return setSetForm(null);
        }
        if (result !== 'submit') {
          return setSetForm(result);
        }
        const name = formValues(setForm).name ?? '';
        setSetForm(null);
        void state.saveEquipSet(name).then((savedId) => {
          if (savedId === null) {
            return;
          }
          const savedIndex = state.equipSets?.sets.findIndex((set) => set.id === savedId) ?? -1;
          if (savedIndex >= 0) {
            setSetSel(savedIndex);
          }
        });
        return;
      }
      if (setReplace) {
        const set = setReplace;
        setSetReplace(null);
        if (input === 'y') {
          void state.replaceEquipSet(set.id);
        }
        return;
      }
      if (setSwitch) {
        const set = setSwitch;
        setSetSwitch(null);
        if (input === 'y') {
          void state.switchEquipSet(set.id);
        }
        return;
      }
      if (filtering) {
        if (key.return || key.escape) {
          setFiltering(false);
        }
        if (key.escape) {
          setFilter('');
        } else if (key.backspace || key.delete) {
          setFilter((textValue) => textValue.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta && !key.return) {
          setFilter((textValue) => textValue + input);
        }
        setBagSel(0);
        return;
      }
      if (confirm) {
        setConfirm(false);
        if (input === 'y') {
          void state.saveSkills(plan).then((ok) => ok && setPlan(emptyPlan()));
        }
        return;
      }
      if (detail && (key.escape || input === 'h')) {
        return setDetail(false);
      }
      if (key.leftArrow || key.rightArrow) {
        setDetail(false);
        const value = key.rightArrow ? 1 : CHAR_TABS.length - 1;
        return setTab((target) => CHAR_TABS[(CHAR_TABS.indexOf(target) + value) % CHAR_TABS.length] ?? target);
      }
      if (key.escape) {
        if (tab === 'skills' && (used.attributes || used.skills)) {
          setPlan(emptyPlan());
          return state.info('Discarded planned skill points.');
        }
        if (tab === 'inventory' && filter) {
          return setFilter('');
        }
        return onExit();
      }
      const up = key.upArrow || input === 'k';
      const down = key.downArrow || input === 'j';
      const step = key.pageUp || key.pageDown ? 10 : 1;
      if (tab === 'skills') {
        if (up || key.pageUp) {
          return setSkillSel((innerIndex) => Math.max(0, innerIndex - step));
        }
        if (down || key.pageDown) {
          return setSkillSel((innerIndex) => Math.min(skillRows.length - 1, innerIndex + step));
        }
        const entryKey = skillRows[skillSel];
        if (!entryKey) {
          return;
        }
        if (input === '+' || input === '=') {
          const pick = structuredClone(plan);
          if (adjustPlan(pick, state.skills, entryKey, 1)) {
            setPlan(pick);
          } else {
            state.error(entryKey in SKILLS_OF ? 'No free attribute points.' : 'No free skill points.');
          }
          return;
        }
        if (input === '-' || input === '_') {
          const pickInfo = structuredClone(plan);
          if (adjustPlan(pickInfo, state.skills, entryKey, -1)) {
            setPlan(pickInfo);
          }
          return;
        }
        if (key.return && (used.attributes || used.skills)) {
          return setConfirm(true);
        }
        return;
      }
      if (tab === 'sets') {
        const sets = state.equipSets?.sets ?? [];
        const selectedIndex = Math.min(setSel, Math.max(0, sets.length - 1));
        if (up || key.pageUp) {
          return setSetSel(Math.max(0, selectedIndex - step));
        }
        if (down || key.pageDown) {
          return setSetSel(Math.min(sets.length - 1, selectedIndex + step));
        }
        const selectedSet = sets[selectedIndex];
        if (input === 'S') {
          return setSetForm(
            makeForm('Save current equipment', [
              {
                key: 'name',
                label: 'Set name',
                value: '',
                hint: state.equipSets
                  ? `${state.equipSets.sets.length}/${state.equipSets.hasPremium ? state.equipSets.premiumMax : state.equipSets.max} used`
                  : 'loading sets',
              },
            ]),
          );
        }
        if (input === 'R' && selectedSet) {
          setSetReplace(selectedSet);
        } else if (key.return && selectedSet) {
          setSetSwitch(selectedSet);
        }
        return;
      }
      if (detail) {
        if (up || key.pageUp) {
          return setDetailScroll((countValue) => Math.max(0, countValue - step));
        }
        if (down || key.pageDown) {
          return setDetailScroll((countValue) => countValue + step);
        }
      }
      if (input === 'l') {
        return setDetail(true);
      }
      if (key.tab) {
        setDetail(false);
        return setPane((pick) => (pick === 'bag' ? 'wear' : 'bag'));
      }
      if (input === '/') {
        setPane('bag');
        setDetail(false);
        onCapture(true); // before the next keystroke reaches the global shortcuts
        return setFiltering(true);
      }
      if (input === 't') {
        setBagSel(0);
        return setTypeIdx((innerIndex) => (innerIndex + 1) % TYPE_FILTERS.length);
      }
      if (input === 'y') {
        setBagSel(0);
        return setTypeIdx((innerIndex) => (innerIndex + TYPE_FILTERS.length - 1) % TYPE_FILTERS.length);
      }
      if (pane === 'wear') {
        if (up || key.pageUp) {
          return setWearSel((innerIndex) => Math.max(0, innerIndex - step));
        }
        if (down || key.pageDown) {
          return setWearSel((innerIndex) => Math.min(WEAR_SLOTS.length - 1, innerIndex + step));
        }
        const slot = WEAR_SLOTS[wearSel];
        if ((key.return || input === 'x') && slot && state.inventory.wear.has(slot)) {
          return void state.unwear(slot);
        }
        return;
      }
      if (up || key.pageUp) {
        return setBagSel(Math.max(0, bagIdx - step));
      }
      if (down || key.pageDown) {
        return setBagSel(Math.min(rows.length - 1, bagIdx + step));
      }
      const it = rows[bagIdx];
      if (input === 'U' && it) {
        return askUse(it);
      }
      if ((key.return || input === 'e') && it) {
        const entry = state.items?.get(it.itemId);
        const type = entry?.type ?? it.type;
        // Usable products (coffee is a `yield` item) win over the wearable slot.
        if (entry && entry.usetype !== 'none') {
          return askUse(it);
        }
        if (WEAR_SLOTS.includes(type)) {
          return void state.wear(it.itemId);
        }
        return state.error(`${state.itemName(it.itemId)} can't be worn or used.`);
      }
    },
    { isActive: active },
  );

  const tabs = createElement(
    Text,
    { wrap: 'truncate' },
    ...CHAR_TABS.map((target) =>
      createElement(
        Text,
        defined({
          key: target,
          inverse: tab === target,
          bold: tab === target,
          color: tab === target ? 'cyan' : undefined,
        }),
        ` ${TAB_LABEL[target]} `,
      ),
    ),
    createElement(Text, { dimColor: true }, '   ← → switch · Esc back'),
    state.items ? null : createElement(Text, { color: 'yellow' }, '   loading item data…'),
  );

  const activeForm = useForm?.form ?? setForm;
  const otherForm = activeForm ? activeForm.fields.length + 4 : 0;
  const body =
    tab === 'inventory'
      ? createElement(InventoryTab, {
          state,
          width,
          height: height - 1 - otherForm,
          pane,
          wearSel,
          rows,
          bagIdx,
          typeFilter,
          filter,
          filtering,
          detailScroll,
          detail,
          clampScroll: (max: number) => setDetailScroll((countValue) => Math.min(countValue, max)),
        })
      : tab === 'sets'
        ? createElement(SetsTab, {
            state,
            width,
            height: height - 1 - otherForm,
            selected: setSel,
            confirm: setSwitch,
            replace: setReplace,
          })
        : createElement(SkillsTab, {
            state,
            width,
            height: height - 1,
            rows: skillRows,
            selected: skillSel,
            plan,
            confirm,
          });
  return createElement(
    Box,
    { flexDirection: 'column', width, height },
    tabs,
    body,
    activeForm ? createElement(FormView, { form: activeForm, width }) : null,
  );
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) {
        continue;
      }
      if (line && `${line} ${word}`.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}

const TYPE_TITLE: Record<string, string> = {
  head: 'Headgear',
  neck: 'Neckband',
  left_arm: 'Gun',
  right_arm: 'Duelling weapon',
  body: 'Clothing',
  foot: 'Shoes',
  animal: 'Animal',
  yield: 'Product',
  belt: 'Belt',
  pants: 'Pants',
  recipe: 'Recipe',
};
const SUB_TITLE: Record<string, string> = { shot: 'Firearm', hand: 'Melee weapon' };
const CLASS_TITLE: Record<string, string> = {
  greenhorn: 'Greenhorn',
  duelist: 'Dueller',
  adventurer: 'Adventurer',
  worker: 'Worker',
  soldier: 'Soldier',
};
const STAT_COLOR: Record<StatKind, Record<string, unknown>> = {
  damage: { color: 'red' },
  attribute: { color: 'green', bold: true },
  skill: { color: 'green' },
  other: { color: 'green' },
  speed: { color: 'cyan' },
  fort: { color: 'blue' },
};

/** Bonus lines as the web popup computes them (upgrade level, per-level values for this character). */
export function bonusLines(stats: ItemStats | null | undefined): string[] {
  return stats ? stats.lines.map((lineValue) => lineValue.text) : [];
}

/** `clampScroll` (character screen): the detail can take focus (l) and scroll; it reports how far. */
export function ItemDetail(transform: {
  state: GameState;
  itemId: number | undefined;
  count: number;
  wornId: number | undefined;
  compare: boolean;
  pane: 'wear' | 'bag';
  width: number;
  height: number;
  scroll: number;
  focused?: boolean;
  clampScroll?: (max: number) => void;
}) {
  const { state, itemId, count, wornId, compare, pane, width, height, scroll, focused, clampScroll } = transform;
  const def = itemId !== undefined ? state.items?.get(itemId) : undefined;
  const worn = wornId !== undefined ? state.items?.get(wornId) : undefined;
  const fieldWidth = Math.max(10, width - 4);
  const lines: React.ReactNode[] = [];
  const add = (text: string, props: Record<string, unknown> = {}) => {
    for (const textValue of wrapText(text, fieldWidth)) {
      lines.push(createElement(Text, { key: lines.length, ...props }, textValue || ' '));
    }
  };
  const gap = () => lines.push(createElement(Text, { key: lines.length }, ' '));
  const character = state.character;
  if (itemId === undefined) {
    add('Nothing selected', { dimColor: true });
  } else if (!def) {
    add(state.itemName(itemId), { bold: true });
  } else {
    const up = itemId % 1000;
    const stats = state.itemStats(itemId);
    add(state.itemName(itemId), { bold: true, color: def.set ? 'greenBright' : 'yellow' });
    const type =
      (def.description || TYPE_TITLE[def.type] || SLOT_NAMES[def.type] || def.type) +
      (def.subType ? ` (${SUB_TITLE[def.subType] ?? def.subType})` : '');
    add(
      `${type}${count > 1 ? ` · ×${count}` : ''}${up ? ` · upgrade ${up}` : ''}${def.action ? (def.type === 'recipe' ? ' · learnable' : ' · usable') : ''}`,
      { dimColor: true },
    );
    if (def.unique) {
      add('Unique', { color: 'magenta' });
    }
    if (def.type === 'recipe' && def.profession) {
      add(`Requires ${def.profession} (${def.professionLevel ?? '?'})`, { color: 'green' });
    }
    if (def.usebonus.length && def.type !== 'recipe') {
      add(def.usebonus.length > 1 ? 'Effects:' : 'Effect:', { bold: true });
      for (const url of def.usebonus) {
        add(`  ${url}`, { color: 'green' });
      }
    }
    gap();
    add('Bonuses', { bold: true });
    if (stats?.lines.length) {
      for (const lineValue of stats.lines) {
        add(`  ${lineValue.text.trim()}`, STAT_COLOR[lineValue.kind]);
      }
    } else {
      add('  none', { dimColor: true });
    }
    const set = state.itemSet(itemId);
    if (set) {
      gap();
      add(`${set.name} (${set.worn}/${set.items.length} worn)`, { bold: true, color: 'greenBright' });
      for (const textValue of set.bonus) {
        add(`  ${textValue}`, { color: 'green' });
      }
      for (const innerIndex of set.items) {
        add(`  ${innerIndex.worn ? '●' : '○'} ${innerIndex.name}`, { dimColor: !innerIndex.worn });
      }
    }
    const req = state.requiredLevel(itemId);
    const reqs: [string, boolean][] = [];
    if (req) {
      reqs.push([
        req.level !== req.base ? `Level ${req.level} (${req.base})` : `Level ${req.level}`,
        character.level < req.level,
      ]);
    }
    if (def.duelLevel) {
      reqs.push([`Duel level ${def.duelLevel}`, character.duelLevel < def.duelLevel]);
    }
    if (def.charClass) {
      reqs.push([`Class: ${CLASS_TITLE[def.charClass] ?? def.charClass}`, character.charClass !== def.charClass]);
    }
    if (def.charSex) {
      reqs.push([
        `Gender: ${def.charSex === 'male' ? 'Male' : 'Female'}${character.charClass === 'greenhorn' ? ' (No Greenhorn)' : ''}`,
        character.charSex !== def.charSex || character.charClass === 'greenhorn',
      ]);
    }
    if (reqs.length) {
      gap();
      add('Requires', { bold: true });
      for (const [requirementText, bad] of reqs) {
        add(`  ${requirementText}`, bad ? { color: 'red' } : {});
      }
    }
    gap();
    if (!def.sellable) {
      add('Unsalable', { color: 'red' });
    } else {
      add(`Sells for ${money(def.sell)}${def.price ? ` · buy ${money(def.price)}` : ''}`);
    }
    if (def.auctionable) {
      add('Auctionable', { color: 'green' });
    }
    if (!def.upgradeable) {
      add('Not upgradeable', { color: 'red' });
    }
    if (compare && WEAR_SLOTS.includes(def.type)) {
      gap();
      add(`Instead of ${wornId !== undefined ? state.itemName(wornId) : 'nothing'}`, { bold: true });
      const diff = gearDelta(stats, wornId !== undefined && worn ? state.itemStats(wornId) : null);
      if (diff) {
        for (const date of diff.split(', ')) {
          add(`  ${date}`, { color: date.startsWith('-') ? 'red' : 'green' });
        }
      } else {
        add('  no change', { dimColor: true });
      }
    }
  }
  const canWear = !!def && WEAR_SLOTS.includes(def.type);
  const canUse = !!def && def.usetype !== 'none';
  const scrollHint = !clampScroll ? '' : focused ? ' · j k scroll · h back' : ' · l detail';
  const hint =
    pane === 'wear'
      ? `Enter/x take off · Tab bag${scrollHint}`
      : `${canUse ? 'Enter/e use' : canWear ? 'Enter/e wear' : 'Enter/e no action'}${canUse ? ' · U use' : ''} · / filter · t/y type${scrollHint}`;
  const room = Math.max(1, height - 3);
  const maxTop = Math.max(0, lines.length - room);
  const top = Math.min(scroll, maxTop);
  const more = lines.length - top - room;
  useEffect(() => {
    if (scroll > maxTop) {
      clampScroll?.(maxTop);
    }
  });
  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: focused ? 'cyan' : 'yellow',
      paddingX: 1,
      width,
      height,
      flexShrink: 0,
    },
    ...lines.slice(top, top + room),
    createElement(Box, { flexGrow: 1 }),
    createElement(Text, { dimColor: true, wrap: 'truncate' }, more > 0 ? `↓ ${more} more · ${hint}` : hint),
  );
}

function InventoryTab(transform: {
  state: GameState;
  width: number;
  height: number;
  pane: 'wear' | 'bag';
  wearSel: number;
  rows: BagItem[];
  bagIdx: number;
  typeFilter: string;
  filter: string;
  filtering: boolean;
  detailScroll: number;
  detail: boolean;
  clampScroll: (max: number) => void;
}) {
  const {
    state,
    width,
    height,
    pane,
    wearSel,
    rows,
    bagIdx,
    typeFilter,
    filter,
    filtering,
    detailScroll,
    detail: detailFocus,
    clampScroll,
  } = transform;
  const inv = state.inventory;
  // Wide terminals: equipped | bag | details side by side. Narrow: details below, still tall.
  const side = width >= 100;
  const wearW = Math.min(40, Math.max(28, Math.floor(width * 0.28)));
  const detailW = side ? Math.min(46, Math.max(32, Math.floor(width * 0.32))) : width;
  const bagW = side ? width - wearW - detailW : width - wearW;
  const detailH = side ? height : Math.max(8, Math.floor(height * 0.45));
  const itemList = side ? height : Math.max(6, height - detailH);
  const wearSlot = WEAR_SLOTS[wearSel];
  const sel = pane === 'wear' && wearSlot ? inv.wear.get(wearSlot) : rows[bagIdx]?.itemId;
  const def = sel !== undefined ? state.items?.get(sel) : undefined;
  const wornId = def && pane === 'bag' ? inv.wear.get(def.type) : undefined;

  const wearPane = createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: pane === 'wear' && !detailFocus ? 'cyan' : 'gray',
      width: wearW,
      height: itemList,
      paddingX: 1,
      flexShrink: 0,
    },
    createElement(Text, { bold: true }, 'Equipped'),
    ...WEAR_SLOTS.map((slot, innerIndex) => {
      const id = inv.wear.get(slot);
      return createElement(
        Box,
        { key: slot, flexDirection: 'column' },
        createElement(
          Text,
          { color: 'yellow', dimColor: !(pane === 'wear' && innerIndex === wearSel), wrap: 'truncate' },
          SLOT_NAMES[slot] ?? slot,
        ),
        createElement(
          Text,
          { inverse: pane === 'wear' && innerIndex === wearSel, wrap: 'truncate', dimColor: id === undefined },
          `  ${id === undefined ? '—' : state.itemName(id)}`,
        ),
      );
    }).slice(0, Math.max(1, Math.floor((itemList - 4) / 2))),
    createElement(Text, { dimColor: true, wrap: 'truncate' }, `speed ×${state.character.speed.toFixed(2)}`),
  );

  const listRows = Math.max(1, itemList - 4);
  const [start, end] = scrollWindow(bagIdx, rows.length, listRows);
  const otherName = Math.max(10, bagW - 16);
  const typeLabel = typeFilter === 'all' ? 'all types' : (SLOT_NAMES[typeFilter] ?? typeFilter);
  const bagPane = createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: pane === 'bag' && !detailFocus ? 'cyan' : 'gray',
      width: bagW,
      height: itemList,
      paddingX: 1,
      flexShrink: 0,
    },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `Bag  ${rows.length ? `${bagIdx + 1}/${rows.length}` : '0'}${rows.length !== inv.bag.size ? ` of ${inv.bag.size}` : ''}`,
    ),
    createElement(
      Text,
      { wrap: 'truncate' },
      createElement(
        Text,
        { color: filtering ? 'cyan' : filter ? 'yellow' : 'gray' },
        filtering ? `/${filter}▏` : filter ? `/${filter}` : '/ filter',
      ),
      createElement(Text, { dimColor: true }, '  ·  '),
      createElement(Text, { color: typeFilter === 'all' ? 'gray' : 'yellow' }, `t ${typeLabel}`),
    ),
    ...rows.slice(start, end).map((it, innerIndex) => {
      const idx = start + innerIndex;
      const entry = state.items?.get(it.itemId);
      return createElement(
        Text,
        { key: it.itemId, inverse: pane === 'bag' && idx === bagIdx, wrap: 'truncate' },
        `${truncate(state.itemName(it.itemId), otherName)} `,
        createElement(
          Text,
          { dimColor: true },
          `${(it.count > 1 ? `×${it.count}` : '').padStart(5)} ${(entry?.level ? `L${entry.level}` : '').padStart(4)}`,
        ),
      );
    }),
    rows.length === 0
      ? createElement(
          Text,
          { dimColor: true },
          inv.bag.size ? 'Nothing matches. Esc clears the filter.' : 'Bag is empty (u refreshes).',
        )
      : null,
  );

  const detail = createElement(ItemDetail, {
    state,
    itemId: sel,
    count: sel !== undefined ? inv.count(sel) : 0,
    wornId,
    compare: pane === 'bag',
    pane,
    width: detailW,
    height: detailH,
    scroll: detailScroll,
    focused: detailFocus,
    clampScroll,
  });
  return side
    ? createElement(Box, null, wearPane, bagPane, detail)
    : createElement(Box, { flexDirection: 'column' }, createElement(Box, null, wearPane, bagPane), detail);
}

const setFullyWorn = (state: GameState, set: EquipSet): boolean =>
  WEAR_SLOTS.every((slot) => (state.inventory.wear.get(slot) ?? null) === (set.slots[slot] ?? null));

function SetsTab({
  state,
  width,
  height,
  selected,
  confirm,
  replace,
}: {
  state: GameState;
  width: number;
  height: number;
  selected: number;
  confirm: EquipSet | null;
  replace: EquipSet | null;
}) {
  const sets = state.equipSets?.sets ?? [];
  const selectedIndex = Math.min(selected, Math.max(0, sets.length - 1));
  const selectedSet = sets[selectedIndex];
  const listWidth = Math.max(30, Math.min(46, Math.floor(width * 0.35)));
  const detailWidth = width - listWidth;
  const listRows = Math.max(2, height - 4);
  const [start, end] = scrollWindow(selectedIndex, sets.length, listRows);
  const isOwned = (itemId: number) => state.inventory.isWorn(itemId) || state.inventory.count(itemId) > 0;
  const wornCount = selectedSet
    ? WEAR_SLOTS.filter((slot) => (selectedSet.slots[slot] ?? null) === (state.inventory.wear.get(slot) ?? null)).length
    : 0;
  const leftPane = createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: listWidth, height, paddingX: 1 },
    createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `Equipment sets  ${sets.length ? `${selectedIndex + 1}/${sets.length}` : '0'}`,
    ),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      state.equipSets
        ? `maximum ${state.equipSets.hasPremium ? state.equipSets.premiumMax : state.equipSets.max} · S save · R replace`
        : 'Loading…',
    ),
    ...sets.slice(start, end).map((source, innerIndex) => {
      const full = setFullyWorn(state, source);
      return createElement(
        Text,
        defined({
          key: source.id,
          inverse: start + innerIndex === selectedIndex,
          color: full ? 'green' : undefined,
          wrap: 'truncate',
        }),
        `${full ? '●' : '○'} ${truncate(source.name, listWidth - 6)}`,
      );
    }),
    sets.length === 0 && state.equipSets
      ? createElement(Text, { dimColor: true, wrap: 'wrap' }, 'No saved sets. Press S to save the current wear.')
      : null,
  );
  const detailPane = createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: detailWidth, height, paddingX: 1 },
    selectedSet
      ? createElement(
          Text,
          { bold: true, wrap: 'truncate' },
          `${selectedSet.name} · ${wornCount}/${WEAR_SLOTS.length} worn`,
        )
      : createElement(Text, { bold: true }, 'No set selected'),
    selectedSet
      ? createElement(
          Text,
          { dimColor: true, wrap: 'truncate' },
          'Enter switches. Items you wear now go back to the bag.',
        )
      : null,
    ...(selectedSet
      ? WEAR_SLOTS.map((slot) => {
          const wantedId = selectedSet.slots[slot] ?? null;
          const currentId = state.inventory.wear.get(slot) ?? null;
          const same = wantedId === currentId;
          return createElement(
            Text,
            defined({
              key: slot,
              color: same ? 'green' : wantedId && !isOwned(wantedId) ? 'red' : undefined,
              wrap: 'truncate',
            }),
            `${(SLOT_NAMES[slot] ?? slot).padEnd(12)} ${wantedId === null ? '—' : state.itemName(wantedId)}`,
            wantedId && !isOwned(wantedId) ? '  (not in bag)' : '',
            !same && currentId !== null
              ? createElement(Text, { dimColor: true }, `  now ${state.itemName(currentId)}`)
              : '',
          );
        })
      : []),
    createElement(Box, { flexGrow: 1 }),
    confirm
      ? createElement(Text, { color: 'yellow', wrap: 'truncate' }, `Switch to ${confirm.name}? y / n`)
      : replace
        ? createElement(
            Text,
            { color: 'yellow', wrap: 'truncate' },
            `Replace ${replace.name} with the current wear? y / n`,
          )
        : createElement(
            Text,
            { dimColor: true, wrap: 'truncate' },
            'Enter switch · S save · R replace · ↑↓ set · u refresh',
          ),
  );
  return createElement(Box, null, leftPane, detailPane);
}

function SkillsTab(pick: {
  state: GameState;
  width: number;
  height: number;
  rows: string[];
  selected: number;
  plan: SkillPlan;
  confirm: boolean;
}) {
  const { state, width, height, rows, selected, plan, confirm } = pick;
  const source = state.skills;
  const used = planUsed(plan);
  const listRows = Math.max(3, height - 4);
  const [start, end] = scrollWindow(selected, rows.length, listRows);
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, width, height },
    createElement(
      Text,
      { wrap: 'truncate' },
      'Free: ',
      createElement(
        Text,
        defined({ color: source.freeAttributes - used.attributes ? 'green' : undefined, bold: true }),
        `${source.freeAttributes - used.attributes} attribute`,
      ),
      ' · ',
      createElement(
        Text,
        defined({ color: source.freeSkills - used.skills ? 'green' : undefined, bold: true }),
        `${source.freeSkills - used.skills} skill`,
      ),
      createElement(Text, { dimColor: true }, '   + / − plan a point · Enter save · Esc discard'),
    ),
    createElement(
      Text,
      { dimColor: true, wrap: 'truncate' },
      `${''.padEnd(22)}${'own'.padStart(5)}${'bonus'.padStart(7)}${'total'.padStart(7)}`,
    ),
    ...rows.slice(start, end).map((entryKey, innerIndex) => {
      const idx = start + innerIndex;
      const isAttr = entryKey in SKILLS_OF;
      const attr = isAttr ? entryKey : (ATTRIBUTE_OF[entryKey] ?? entryKey);
      const delta = plannedDelta(plan, entryKey);
      const own = source.base(entryKey);
      const bonus = isAttr ? (source.attributeBonus[entryKey] ?? 0) : (source.skillBonus[entryKey] ?? 0);
      const name = (isAttr ? '' : '  ') + (NAMES[entryKey] ?? entryKey);
      return createElement(
        Text,
        { key: entryKey, inverse: idx === selected, wrap: 'truncate' },
        createElement(
          Text,
          { color: ATTRIBUTE_COLOR[attr as keyof typeof ATTRIBUTE_COLOR], bold: isAttr },
          name.padEnd(22),
        ),
        String(own).padStart(5),
        createElement(Text, { dimColor: true }, `+${bonus}`.padStart(7)),
        String(own + bonus + delta).padStart(7),
        delta ? createElement(Text, { color: 'green', bold: true }, `  +${delta}`) : null,
      );
    }),
    confirm
      ? createElement(
          Text,
          { color: 'yellow' },
          `Spend ${used.attributes} attribute and ${used.skills} skill point(s)? This is permanent. y / n`,
        )
      : null,
  );
}
