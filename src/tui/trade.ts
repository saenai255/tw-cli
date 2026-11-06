// Trade screen (g b): bank, town shops (buy / sell), the market (goods for sale and buy orders: search with filters,
// bid, buy now, sell into a buy order, place a buy order, sell, pick up, withdraw).
// Shops and the bank are those of the town you stand in, else your home town (buying needs you there).

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import {
  depositFee,
  MARKET_CATEGORIES,
  type MarketFilter,
  type MarketOffer,
  type MobileTraderItem,
  marketFee,
  SHOPS,
  type ShopKey,
  suggestedBid,
} from '../game/trade.ts';
import { defined } from '../util/defined.ts';
import { ItemDetail, type ScreenProps } from './character.ts';
import { type FormField, type FormState, FormView, formKey, formValues, makeForm } from './form.ts';
import { coarseDuration, formatTravel, money, scrollWindow, truncate } from './format.ts';

const createElement = React.createElement;

type Tab = 'bank' | 'trader' | ShopKey | 'market' | 'mine';
const TABS: { key: Tab; label: string }[] = [
  { key: 'bank', label: 'Bank' },
  { key: 'trader', label: 'Mobile trader' },
  ...SHOPS.map((source) => ({ key: source.key as Tab, label: source.label })),
  { key: 'market', label: 'Market' },
  { key: 'mine', label: 'My market' },
];
type Pending =
  | { kind: 'deposit' }
  | { kind: 'bid'; offer: MarketOffer }
  | { kind: 'sell-shop'; itemId: number }
  | { kind: 'sell-market'; itemId: number }
  | { kind: 'buy-order' }
  | { kind: 'search' };
type Confirm = { text: string; run: () => void } | null;

const isShop = (target: Tab): target is ShopKey => SHOPS.some((source) => source.key === target);
const DAYS = ['1', '2', '3', '4', '5', '6', '7'];
const YES_NO = ['no', 'yes'];
const catLabel = (type: string) => MARKET_CATEGORIES.find((candidate) => candidate.type === type)?.label ?? 'all';
const catType = (label: string) => MARKET_CATEGORIES.find((candidate) => candidate.label === label)?.type ?? '';
const itemsLabel = (state: ScreenProps['state'], offer: MarketOffer) =>
  `${offer.count > 1 ? `${offer.count}× ` : ''}${state.itemName(offer.itemId)}`;
const priceLabel = (pick: { currency: string; amount: number }) =>
  pick.currency === 'dollar' ? money(pick.amount) : `${pick.amount} ${pick.currency}`;

function filterText(value: MarketFilter): string {
  const parts = [
    value.type ? catLabel(value.type) : '',
    value.levelMin || value.levelMax ? `level ${value.levelMin || 0}–${value.levelMax || '∞'}` : '',
    value.usable ? 'usable' : '',
    value.consumable ? 'consumable' : '',
  ];
  return parts.filter(Boolean).join(', ');
}

/** Limited offers end when all are sold or their time is up (the timestamp is in server seconds). */
const hasEnded = (item: MobileTraderItem, nowMs: number): boolean =>
  item.limitedCount === 0 || (item.limitedAt !== null && item.limitedAt * 1000 <= nowMs);

export function TradeScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('bank');
  const [sel, setSel] = useState(0);
  /** Shop and market tabs: the shop's goods / offers, or your bag (to sell). */
  const [side, setSide] = useState<'goods' | 'bag'>('goods');
  const [form, setForm] = useState<FormState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const town = state.tradeTown;

  useEffect(() => void state.loadItems(), [state]);
  useEffect(() => {
    onCapture(!!form || !!confirm);
  }, [form, confirm]);
  useEffect(() => {
    setSel(0);
    setSide('goods');
    if (tab === 'trader') {
      return void state.openMobileTrader();
    }
    if (!town) {
      return;
    }
    if (tab === 'bank') {
      void state.openBank(town.id);
    } else if (isShop(tab)) {
      void state.openShop(tab, town.id);
    } else if (tab === 'mine') {
      void state.loadMarketMine();
    }
  }, [tab, town?.id]);

  const bagItems = state.inventory
    .items()
    .filter((second) => !state.inventory.isWorn(second.itemId))
    .sort((first, second) => state.itemName(first.itemId).localeCompare(state.itemName(second.itemId)));
  const shopItems = state.shop && isShop(tab) && state.shop.key === tab ? state.shop.items : [];
  const mine = state.marketMine
    ? [
        ...state.marketMine.bids.map((offer) => ({ o: offer, mineKind: 'bid' as const })),
        ...state.marketMine.offers.map((offer) => ({ o: offer, mineKind: 'offer' as const })),
        ...state.marketMine.buyOrders.map((offer) => ({ o: offer, mineKind: 'want' as const })),
      ]
    : [];
  const filter = state.market.filter;
  const traderItems = state.mobileTrader?.items ?? [];
  const rowsCount =
    tab === 'bank'
      ? 0
      : tab === 'trader'
        ? traderItems.length
        : side === 'bag'
          ? bagItems.length
          : isShop(tab)
            ? shopItems.length
            : tab === 'market'
              ? state.market.offers.length
              : mine.length;
  const idx = Math.min(sel, Math.max(0, rowsCount - 1));

  const ask = (pick: Pending, formState: FormState) => {
    setPending(pick);
    setForm(formState);
  };

  const submit = (pick: Pending, value: Record<string, string>) => {
    const transform = (entryKey: string) => Number(value[entryKey] ?? '') || 0;
    if (pick.kind === 'deposit') {
      return void state.depositMoney(transform('amount'));
    }
    if (pick.kind === 'search') {
      const currentValue: MarketFilter = {
        type: catType(value.cat ?? ''),
        levelMin: transform('lmin'),
        levelMax: transform('lmax'),
        usable: value.usable === 'yes',
        consumable: value.consumable === 'yes',
        buyOrders: value.dir === 'buy orders',
      };
      return void state.searchMarket(value.query ?? '', 1, currentValue).then(() => setSel(0));
    }
    if (pick.kind === 'bid') {
      return void state.bidMarket(pick.offer, transform('amount'), value.pay === 'bank account');
    }
    if (pick.kind === 'buy-order') {
      return void state.placeBuyOrder({
        query: value.item ?? '',
        count: Math.max(1, transform('count')),
        days: Math.max(1, transform('days')),
        maxBid: transform('maxbid') || undefined,
        instant: transform('instant') || undefined,
        fromBank: value.pay === 'bank account',
      });
    }
    if (pick.kind === 'sell-shop') {
      return void state.sellToShop(pick.itemId, Math.max(1, transform('count')));
    }
    if (pick.kind === 'sell-market') {
      return void state.sellOnMarket({
        itemId: pick.itemId,
        count: Math.max(1, transform('count')),
        days: Math.max(1, transform('days')),
        startPrice: transform('start') || undefined,
        buyNow: transform('buynow') || undefined,
      });
    }
  };

  useInput(
    (input, key) => {
      if (form && pending) {
        const otherForm = formKey(form, input, key);
        if (otherForm === 'cancel') {
          setForm(null);
          return setPending(null);
        }
        if (otherForm !== 'submit') {
          return setForm(otherForm);
        }
        setForm(null);
        setPending(null);
        return submit(pending, formValues(form));
      }
      if (confirm) {
        setConfirm(null);
        if (input === 'y') {
          confirm.run();
        }
        return;
      }
      if (key.escape) {
        if (side === 'bag') {
          return setSide('goods');
        }
        return onExit();
      }
      if (key.leftArrow || key.rightArrow) {
        const value = key.rightArrow ? 1 : TABS.length - 1;
        return setTab(
          (cur) => TABS[(TABS.findIndex((target) => target.key === cur) + value) % TABS.length]?.key ?? cur,
        );
      }
      const step = key.pageUp || key.pageDown ? 10 : 1;
      if (key.upArrow || input === 'k' || key.pageUp) {
        return setSel(Math.max(0, idx - step));
      }
      if (key.downArrow || input === 'j' || key.pageDown) {
        return setSel(Math.min(rowsCount - 1, idx + step));
      }
      if (tab === 'trader') {
        const item = traderItems[idx];
        if (key.return && item?.prices[0]) {
          if (hasEnded(item, Date.now())) {
            return state.error('This mobile-trader offer has ended.');
          }
          const pick = item.prices[0];
          setConfirm({
            text: `Buy ${state.itemName(item.itemId)} for ${priceLabel(pick)}?`,
            run: () => void state.buyMobileTrader(item),
          });
        }
        return;
      }
      if (!town) {
        return;
      }

      if (tab === 'bank') {
        if (key.return || input === 'd') {
          const fee = state.bank?.fee ?? 0;
          return ask(
            { kind: 'deposit' },
            makeForm(
              `Deposit in ${state.bank?.townName || town.name} (fee ${fee}%)`,
              [{ key: 'amount', label: 'Amount $', value: String(state.character.cash), kind: 'number' }],
              (value) =>
                `Fee: $ ${depositFee(Number(value.amount) || 0, fee)} · you have $ ${state.character.cash} in cash`,
            ),
          );
        }
        return;
      }

      if ((isShop(tab) || tab === 'market') && key.tab) {
        setSel(0);
        return setSide((source) => (source === 'goods' ? 'bag' : 'goods'));
      }

      if (side === 'bag') {
        const it = bagItems[idx];
        if (!it || !key.return) {
          return;
        }
        const entry = state.items?.get(it.itemId);
        if (isShop(tab)) {
          if (entry && !entry.sellable) {
            return state.error(`${entry.name} cannot be sold.`);
          }
          if (it.count > 1) {
            return ask(
              { kind: 'sell-shop', itemId: it.itemId },
              makeForm(
                `Sell ${state.itemName(it.itemId)} for $ ${entry?.sell ?? '?'} each`,
                [{ key: 'count', label: 'How many', value: '1', kind: 'number', hint: `max ${it.count}` }],
                (value) => `Total: $ ${(entry?.sell ?? 0) * (Number(value.count) || 0)}`,
              ),
            );
          }
          return setConfirm({
            text: `Sell ${state.itemName(it.itemId)} for $ ${entry?.sell ?? '?'}?`,
            run: () => void state.sellToShop(it.itemId, 1),
          });
        }
        if (entry && !entry.auctionable) {
          return state.error(`${entry.name} cannot be sold on the market.`);
        }
        return ask(
          { kind: 'sell-market', itemId: it.itemId },
          makeForm(
            `Sell ${state.itemName(it.itemId)} on the market of ${town.name}`,
            [
              { key: 'count', label: 'Amount', value: '1', kind: 'number', hint: `max ${it.count}` },
              { key: 'start', label: 'Starting bid $', value: '', kind: 'number', hint: 'empty: buy-now only' },
              { key: 'buynow', label: 'Buy now $', value: '', kind: 'number', hint: 'empty: auction only' },
              { key: 'days', label: 'Days', value: '1', kind: 'choice', options: DAYS },
            ],
            (value) => {
              const fee = marketFee({
                startPrice: Number(value.start) || 0,
                buyNow: Number(value.buynow) || 0,
                days: Number(value.days) || 1,
                homeTown: town.id === state.character.homeTown?.id,
              });
              return `Shop sell price $ ${entry?.sell ?? '?'} each · fee up to $ ${fee} (less at a bigger market)`;
            },
          ),
        );
      }

      if (isShop(tab)) {
        const itemId = shopItems[idx];
        if (itemId !== undefined && key.return) {
          const price = state.shopPrice(itemId);
          if (!town.here) {
            return state.error(`You are not in ${town.name}. Walk there first.`);
          }
          return setConfirm({
            text: `Buy ${state.itemName(itemId)} for $ ${price}?`,
            run: () => void state.buyFromShop(itemId),
          });
        }
        return;
      }

      if (tab === 'market') {
        if (input === '/') {
          return ask(
            { kind: 'search' },
            makeForm('Search the market', [
              { key: 'query', label: 'Item name', value: state.market.query, hint: 'empty: everything' },
              {
                key: 'dir',
                label: 'Show',
                value: filter.buyOrders ? 'buy orders' : 'for sale',
                kind: 'choice',
                options: ['for sale', 'buy orders'],
              },
              {
                key: 'cat',
                label: 'Category',
                value: catLabel(filter.type),
                kind: 'choice',
                options: MARKET_CATEGORIES.map((candidate) => candidate.label),
              },
              {
                key: 'lmin',
                label: 'Level from',
                value: filter.levelMin ? String(filter.levelMin) : '',
                kind: 'number',
              },
              {
                key: 'lmax',
                label: 'Level to',
                value: filter.levelMax ? String(filter.levelMax) : '',
                kind: 'number',
                hint: 'empty: any',
              },
              {
                key: 'usable',
                label: 'Usable by me',
                value: filter.usable ? 'yes' : 'no',
                kind: 'choice',
                options: YES_NO,
              },
              {
                key: 'consumable',
                label: 'Consumable',
                value: filter.consumable ? 'yes' : 'no',
                kind: 'choice',
                options: YES_NO,
              },
            ]),
          );
        }
        if (input === 't') {
          return void state
            .searchMarket(state.market.query, 1, { ...filter, buyOrders: !filter.buyOrders })
            .then(() => setSel(0));
        }
        if (input === 'n') {
          return ask(
            { kind: 'buy-order' },
            makeForm(
              `Buy order at the market of ${town.name}`,
              [
                { key: 'item', label: 'Item name', value: '' },
                { key: 'count', label: 'Amount', value: '1', kind: 'number' },
                {
                  key: 'instant',
                  label: 'Instant price $',
                  value: '',
                  kind: 'number',
                  hint: 'a seller gets this at once',
                },
                {
                  key: 'maxbid',
                  label: 'Max bid $',
                  value: '',
                  kind: 'number',
                  hint: 'auction; above the instant price',
                },
                { key: 'days', label: 'Days', value: '1', kind: 'choice', options: DAYS },
                { key: 'pay', label: 'Pay from', value: 'cash', kind: 'choice', options: ['cash', 'bank account'] },
              ],
              (value) => {
                const found = state.findAuctionable(value.item ?? '');
                const what = !value.item
                  ? 'type an item name'
                  : found.length === 1
                    ? (found[0]?.name ?? value.item)
                    : found.length
                      ? `${found.length} matches: ${found
                          .slice(0, 3)
                          .map((marketItem) => marketItem.name)
                          .join(', ')}…`
                      : 'no such market item';
                const fee = marketFee({
                  startPrice: Number(value.maxbid) || 0,
                  buyNow: Number(value.instant) || 0,
                  days: Number(value.days) || 1,
                  homeTown: town.id === state.character.homeTown?.id,
                });
                return `${what} · fee up to $ ${fee}`;
              },
            ),
          );
        }
        if (input === '>' && state.market.next) {
          return void state.searchMarket(state.market.query, state.market.page + 1).then(() => setSel(0));
        }
        if (input === '<' && state.market.page > 1) {
          return void state.searchMarket(state.market.query, state.market.page - 1).then(() => setSel(0));
        }
        const offer = state.market.offers[idx];
        if (!offer) {
          return;
        }
        if (input === 'w') {
          return void state.walkToTownAt(offer.town, offer.town.name);
        }
        const wanted = offer.direction === 'BUY';
        if (key.return && offer.buyNow !== null) {
          const buyNow = offer.buyNow;
          return setConfirm(
            wanted
              ? {
                  text: `Sell ${itemsLabel(state, offer)} to ${offer.seller} now for $ ${buyNow}?`,
                  run: () => void state.bidMarket(offer, buyNow),
                }
              : {
                  text: `Buy ${itemsLabel(state, offer)} now for $ ${buyNow} (cash, then bank)?`,
                  run: () => void state.bidMarket(offer, buyNow),
                },
          );
        }
        if (input === 'b' || key.return) {
          const fields: FormField[] = [
            {
              key: 'amount',
              label: wanted ? 'Your price $' : 'Your bid $',
              value: String(suggestedBid(offer)),
              kind: 'number',
              hint: offer.buyNow !== null ? `${wanted ? 'instant sale' : 'buy now'}: $ ${offer.buyNow}` : '',
            },
          ];
          if (!wanted) {
            fields.push({
              key: 'pay',
              label: 'Pay from',
              value: 'cash',
              kind: 'choice',
              options: ['cash', 'bank account'],
            });
          }
          return ask(
            { kind: 'bid', offer: offer },
            makeForm(
              `${wanted ? 'Sell into the buy order for' : 'Bid on'} ${itemsLabel(state, offer)}`,
              fields,
              wanted
                ? () => `You have ${state.inventory.count(offer.itemId)} · the item leaves your bag when you win`
                : undefined,
            ),
          );
        }
        return;
      }

      // My market: pick up finished bids / offers / buy orders in the market town, withdraw running ones.
      if (input === 'P') {
        return setConfirm({
          text: `Pick up everything finished at the market of ${state.townHere?.name ?? 'this town'}?`,
          run: () => void state.pickUpAllMarket(),
        });
      }
      const match = mine[idx];
      if (!match) {
        return;
      }
      if (input === 'w') {
        return void state.walkToTownAt(match.o.town, match.o.town.name);
      }
      if (key.return && match.o.finished) {
        return void state.pickUpMarket(match.o);
      }
      if (input === 'x' && match.mineKind !== 'bid' && !match.o.finished) {
        return setConfirm({
          text: `Withdraw your ${match.mineKind === 'want' ? 'buy order' : 'offer'} for ${itemsLabel(state, match.o)}? Fees are only partly refunded.`,
          run: () => void state.withdrawMarket(match.o),
        });
      }
    },
    { isActive: active },
  );

  // ---- render ------------------------------------------------------------------------------
  const leftW = Math.max(34, Math.floor(width * 0.5));
  const rightW = width - leftW;
  const bodyH = height - 1; // below the tab row
  const otherForm = form ? form.fields.length + 4 + (form.note ? 1 : 0) : 0;
  const listRows = Math.max(2, height - 6 - (confirm ? 1 : 0));
  const [start, end] = scrollWindow(idx, rowsCount, listRows);
  const tabs = createElement(
    Text,
    { wrap: 'truncate' },
    ...TABS.map((target) =>
      createElement(
        Text,
        defined({
          key: target.key,
          inverse: tab === target.key,
          bold: tab === target.key,
          color: tab === target.key ? 'cyan' : undefined,
        }),
        ` ${target.label} `,
      ),
    ),
    createElement(Text, { dimColor: true }, ' ← →'),
  );
  const trader = state.mobileTrader;
  const traderLeft = trader?.changesAt ? Math.max(0, trader.changesAt - state.clock.now()) : 0;
  const where =
    tab === 'trader'
      ? `${trader ? `Mobile trader · ${trader.items.length} offer(s)` : 'Loading mobile trader…'}${traderLeft ? ` · changes in ${coarseDuration(traderLeft)}` : ''} · cash ${money(state.character.cash)} · bank ${money(state.character.deposit)}`
      : town
        ? `${town.name}${town.here ? ' (you are here)' : ' (home town; you are not there)'} · cash ${money(state.character.cash)} · bank ${money(state.character.deposit)}`
        : 'No town: stand in a town or join one.';

  const rows: React.ReactNode[] = [];
  let detail: React.ReactNode = null;
  if (tab === 'bank') {
    const second = state.bank;
    rows.push(
      createElement(
        Text,
        { key: 'b', bold: true },
        second ? `Bank of ${second.townName || town?.name}` : 'Loading bank…',
      ),
    );
    if (second) {
      rows.push(createElement(Text, { key: 'c' }, `Cash        ${money(state.character.cash)}`));
      rows.push(createElement(Text, { key: 'd' }, `Bank        ${money(state.character.deposit)}`));
      rows.push(createElement(Text, { key: 'f' }, `Deposit fee ${second.fee}%`));
      rows.push(
        createElement(
          Text,
          { key: 'n', dimColor: true, wrap: 'wrap' },
          'Money in the bank is safe from duels. Purchases use cash first, then the bank. Enter: deposit.',
        ),
      );
    }
  } else if (tab === 'trader') {
    rows.push(
      createElement(
        Text,
        { key: 'hd', dimColor: true, wrap: 'truncate' },
        'Rotating offers · buy with cash, then bank · Enter buy · u refresh',
      ),
    );
    traderItems.slice(start, end).forEach((traderItem, index) => {
      const pick = traderItem.prices[0];
      const level = state.items?.get(traderItem.itemId)?.level;
      const soldOut = hasEnded(traderItem, Date.now());
      const price = pick ? priceLabel(pick) : '—';
      const unaffordable =
        !!pick && pick.currency === 'dollar' && pick.amount > state.character.cash + state.character.deposit;
      const limited = traderItem.limitedAt
        ? coarseDuration(traderItem.limitedAt - state.clock.now())
        : traderItem.limitedCount !== null
          ? `${traderItem.limitedCount} left`
          : '';
      rows.push(
        createElement(
          Text,
          defined({
            key: traderItem.itemId,
            inverse: start + index === idx,
            color: soldOut ? 'gray' : unaffordable ? 'red' : undefined,
            wrap: 'truncate',
          }),
          `${truncate(state.itemName(traderItem.itemId), leftW - 28)} ${level ? `L${level}`.padStart(4) : '    '} ${price.padStart(9)} ${truncate(limited, 6).padStart(6)}`,
        ),
      );
    });
    const item = traderItems[idx];
    if (item) {
      const pick = item.prices[0];
      detail = createElement(
        Box,
        { flexDirection: 'column', width: rightW, height: bodyH - otherForm },
        createElement(
          Text,
          { bold: true, color: 'yellow', wrap: 'truncate' },
          pick
            ? `${priceLabel(pick)}${item.discount ? ` (${item.discount}% off ${priceLabel({ ...pick, amount: pick.base })})` : ''}${item.teaser ? ` · ${item.teaser}` : ''}`
            : 'No price',
        ),
        createElement(ItemDetail, {
          state,
          itemId: item.itemId,
          count: 1,
          wornId: undefined,
          compare: false,
          pane: 'bag',
          width: rightW,
          height: Math.max(6, bodyH - otherForm - 2),
          scroll: 0,
        }),
      );
    }
  } else if (side === 'bag') {
    rows.push(
      createElement(
        Text,
        { key: 'hd', dimColor: true, wrap: 'truncate' },
        `Your bag: Enter ${isShop(tab) ? 'sells to the shop' : 'offers on the market'} · Tab back`,
      ),
    );
    bagItems.slice(start, end).forEach((second, index) => {
      const entry = state.items?.get(second.itemId);
      const ok = isShop(tab) ? entry?.sellable !== false : entry?.auctionable !== false;
      rows.push(
        createElement(
          Text,
          defined({
            key: second.itemId,
            inverse: start + index === idx,
            color: ok ? undefined : 'gray',
            wrap: 'truncate',
          }),
          `${truncate(state.itemName(second.itemId), leftW - 18)} ${second.count > 1 ? `×${second.count}`.padStart(4) : '    '} ${money(entry?.sell ?? 0).padStart(8)}`,
        ),
      );
    });
    const it = bagItems[idx];
    if (it) {
      detail = createElement(ItemDetail, {
        state,
        itemId: it.itemId,
        count: it.count,
        wornId: undefined,
        compare: false,
        pane: 'bag',
        width: rightW,
        height: bodyH - otherForm,
        scroll: 0,
      });
    }
  } else if (isShop(tab)) {
    const shop = state.shop;
    rows.push(
      createElement(
        Text,
        { key: 'hd', dimColor: true, wrap: 'truncate' },
        shop && shop.key === tab
          ? `${SHOPS.find((xCoord) => xCoord.key === tab)?.label ?? tab} level ${shop.level} · ${shop.items.length} items · Tab: sell`
          : 'Loading shop…',
      ),
    );
    shopItems.slice(start, end).forEach((shopItemId, index) => {
      const req = state.requiredLevel(shopItemId);
      const tooLow = req && req.level > state.character.level;
      const price = state.shopPrice(shopItemId);
      rows.push(
        createElement(
          Text,
          defined({
            key: shopItemId,
            inverse: start + index === idx,
            color: tooLow ? 'gray' : price > state.character.cash + state.character.deposit ? 'red' : undefined,
            wrap: 'truncate',
          }),
          `${truncate(state.itemName(shopItemId), leftW - 18)} ${req ? `L${req.level}`.padStart(4) : '    '} ${money(price).padStart(8)}`,
        ),
      );
    });
    const id = shopItems[idx];
    if (id !== undefined) {
      const entry = state.items?.get(id);
      const wornId = entry ? state.inventory.wear.get(entry.type) : undefined;
      detail = createElement(ItemDetail, {
        state,
        itemId: id,
        count: 1,
        wornId,
        compare: wornId !== undefined,
        pane: 'bag',
        width: rightW,
        height: bodyH - otherForm,
        scroll: 0,
      });
    }
  } else if (tab === 'market') {
    const match = state.market;
    const text = filterText(filter);
    rows.push(
      createElement(
        Text,
        { key: 'mode', wrap: 'truncate' },
        createElement(
          Text,
          { color: filter.buyOrders ? 'magenta' : 'green', bold: true },
          filter.buyOrders ? 'Buy orders (wanted)' : 'For sale',
        ),
        createElement(Text, { dimColor: true }, ` · t switch${text ? ` · ${text}` : ''}`),
      ),
    );
    rows.push(
      createElement(
        Text,
        { key: 'hd', dimColor: true, wrap: 'truncate' },
        match.searched
          ? `${match.query ? `"${match.query}"` : 'everything'} · page ${match.page}${match.next ? ' (> next)' : ''} · / search · n buy order · Tab sell`
          : '/ search (filters) · n place a buy order · Tab sell from your bag',
      ),
    );
    if (match.offers.length) {
      rows.push(
        createElement(
          Text,
          { key: 'cols', dimColor: true, wrap: 'truncate' },
          `${'Item'.padEnd(leftW - 30)}     bid ${filter.buyOrders ? 'instant' : 'buy now'}  ends`,
        ),
      );
    }
    match.offers.slice(start, end).forEach((marketOffer, index) => {
      const price = marketOffer.buyNow !== null ? money(marketOffer.buyNow) : '';
      const bid = marketOffer.bid !== null ? money(marketOffer.bid) : '';
      const have = marketOffer.direction === 'BUY' && state.inventory.count(marketOffer.itemId) >= marketOffer.count;
      rows.push(
        createElement(
          Text,
          defined({
            key: marketOffer.id,
            inverse: start + index === idx,
            bold: marketOffer.highestBidder,
            color: have ? 'green' : undefined,
            wrap: 'truncate',
          }),
          `${truncate(itemsLabel(state, marketOffer), leftW - 30)} ${bid.padStart(7)} ${price.padStart(7)} ${coarseDuration(marketOffer.endsIn).padStart(5)}`,
        ),
      );
    });
    const offer = match.offers[idx];
    if (offer) {
      detail = offerDetail(state, offer, rightW, bodyH - otherForm);
    }
  } else {
    const mm = state.marketMine;
    rows.push(
      createElement(
        Text,
        { key: 'hd', dimColor: true, wrap: 'truncate' },
        mm
          ? `${mm.bids.length} bid(s) · ${mm.offers.length} offer(s) · ${mm.buyOrders.length} buy order(s) at ${town?.name ?? '?'}`
          : 'Loading…',
      ),
    );
    mine.slice(start, end).forEach(({ o: offer, mineKind }, index) => {
      const status = offer.finished
        ? mineKind === 'bid'
          ? offer.highestBidder
            ? 'won, pick up'
            : 'ended'
          : 'ended, collect'
        : coarseDuration(offer.endsIn);
      const label =
        mineKind === 'bid' ? (offer.direction === 'BUY' ? 'sell ' : 'bid  ') : mineKind === 'want' ? 'want ' : 'offer';
      rows.push(
        createElement(
          Text,
          defined({
            key: `${mineKind}${offer.id}`,
            inverse: start + index === idx,
            color: offer.finished ? 'green' : undefined,
            wrap: 'truncate',
          }),
          `${label} ${truncate(itemsLabel(state, offer), leftW - 30)} ${(offer.bid !== null ? money(offer.bid) : '').padStart(7)} ${status.padStart(14)}`,
        ),
      );
    });
    const matchValue = mine[idx];
    if (matchValue) {
      detail = offerDetail(state, matchValue.o, rightW, bodyH - otherForm);
    }
  }

  const help = confirm
    ? createElement(Text, { color: 'yellow', wrap: 'truncate' }, `${confirm.text} y / n`)
    : createElement(
        Text,
        { dimColor: true, wrap: 'truncate' },
        tab === 'bank'
          ? 'Enter deposit · ← → tab · Esc back'
          : tab === 'trader'
            ? 'Enter buy · u refresh · ← → tab · Esc back'
            : side === 'bag'
              ? 'Enter sell · Tab back · Esc back'
              : isShop(tab)
                ? 'Enter buy · Tab sell · ← → tab · Esc back'
                : tab === 'market'
                  ? filter.buyOrders
                    ? '/ search · t for sale · Enter sell now (or ask) · b ask · n buy order · w walk · < > page'
                    : '/ search · t buy orders · Enter buy now (or bid) · b bid · n buy order · w walk · < > page · Tab sell'
                  : 'Enter pick up · P pick up all here · x withdraw · w walk to town · ← → tab · Esc back',
      );
  const left = createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', width: leftW, height: bodyH, paddingX: 1 },
    createElement(Text, { color: town?.here ? 'green' : 'yellow', wrap: 'truncate' }, where),
    ...rows,
    rowsCount === 0 && tab !== 'bank'
      ? createElement(
          Text,
          { dimColor: true },
          tab === 'market'
            ? ''
            : tab === 'trader'
              ? trader
                ? 'No offers right now.'
                : 'Loading offers…'
              : 'Nothing here.',
        )
      : null,
    createElement(Box, { flexGrow: 1 }),
    help,
  );
  const right = createElement(
    Box,
    { flexDirection: 'column', width: rightW, height: bodyH },
    detail ? createElement(Box, { flexGrow: 1, flexDirection: 'column' }, detail) : createElement(Box, { flexGrow: 1 }),
    form ? createElement(FormView, { form, width: rightW }) : null,
  );
  return createElement(
    Box,
    { flexDirection: 'column', width, height },
    tabs,
    createElement(Box, { width, height: bodyH }, left, right),
  );
}

function offerDetail(state: ScreenProps['state'], offer: MarketOffer, width: number, height: number): React.ReactNode {
  const way = state.travelTo(offer.town);
  const lines = [
    createElement(
      Text,
      { key: 'n', bold: true, wrap: 'truncate' },
      `${offer.direction === 'BUY' ? 'Wanted: ' : ''}${itemsLabel(state, offer)}`,
    ),
    createElement(
      Text,
      { key: 'p', wrap: 'truncate' },
      `Bid ${offer.bid !== null ? money(offer.bid) : '—'} · ${offer.direction === 'BUY' ? 'Instant' : 'Buy now'} ${offer.buyNow !== null ? money(offer.buyNow) : '—'}${offer.count > 1 && offer.buyNow !== null ? ` (${money(Math.floor(offer.buyNow / offer.count))} each)` : ''}`,
    ),
    createElement(
      Text,
      { key: 's', dimColor: true, wrap: 'truncate' },
      `${offer.direction === 'BUY' ? 'Buyer' : 'Seller'} ${offer.seller}${offer.bidder ? ` · best bid ${offer.bidder}` : ''}${offer.highestBidder ? ' (you)' : ''}`,
    ),
    offer.direction === 'BUY'
      ? createElement(
          Text,
          { key: 'h', dimColor: true, wrap: 'truncate' },
          `You have ${state.inventory.count(offer.itemId)} in your bag`,
        )
      : null,
    offer.description
      ? createElement(Text, { key: 'd', dimColor: true, wrap: 'truncate' }, `“${offer.description}”`)
      : null,
    createElement(
      Text,
      { key: 't', dimColor: true, wrap: 'truncate' },
      `${offer.finished ? 'Ended' : `Ends in ${coarseDuration(offer.endsIn)}`} · at ${offer.town.name} (${formatTravel(way)} away)`,
    ),
  ];
  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'gray',
      paddingX: 1,
      width,
      height: Math.max(6, Math.min(height, 10)),
    },
    ...lines,
  );
}
