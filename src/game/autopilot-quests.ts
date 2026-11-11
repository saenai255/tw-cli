// Autopilot quest module: on-the-spot quest steps the runner does between tasks, one per tick: finish
// quests (reward by priority), wear items a quest asks for (and put the old gear back afterwards), buy quest
// items (mobile trader and market offers from anywhere, shops in the town you are in; quest-buy.ts picks the
// source), pick up market goods, and accept quests from the saloon of towns it is in. Job items and job runs
// are not here: the planner's Quests goal covers them, and its shop trips walk to the town. Requirements it
// cannot do are logged once.

import { errorMessage } from '../util/errors.ts';
import type { MarketPickup } from './autopilot-config.ts';
import { type AutopilotConfig, goalWeights, questInScope } from './autopilot-config.ts';
import { baseId } from './items.ts';
import { type BuyPick, where } from './quest-buy.ts';
import { parseGameNumber, type Quest } from './quests.ts';
import type { GameState } from './state.ts';
import { walkPost } from './tasks.ts';
import { buyMobileTrader, MarketApi, shopBuy } from './trade.ts';

/** A quest that only waits for its time window: the quest log is re-read this often so it finishes inside it. */
const WINDOW_CHECK_MS = 10 * 60_000;

/** Picks a reward option by the priority: XP / money; an item you could wear now that beats yours always wins. */
export function chooseReward(
  options: { id: number; text: string }[],
  config: AutopilotConfig,
  isUpgrade: (text: string) => boolean = () => false,
): number | undefined {
  if (options.length <= 1) {
    return options[0]?.id;
  }
  const width = goalWeights(config);
  const score = (textValue: string) => {
    if (isUpgrade(textValue)) {
      return Infinity;
    }
    const count = parseGameNumber(textValue) || 1;
    if (/experience|xp/i.test(textValue)) {
      return width.xp * count;
    }
    if (/dollar|\$/i.test(textValue)) {
      return width.money * count;
    }
    return 0; // other item rewards: only taken when nothing better (or an upgrade, above)
  };
  return options.reduce((accumulator, current) =>
    score(current.text) > score(accumulator.text) ? current : accumulator,
  ).id;
}

export interface QuestHost {
  state: GameState;
  config: AutopilotConfig;
  budget(): number;
  spend(amount: number): void;
  skipped(): Set<string>;
  fail(key: string, msg: string): void;
}

/** Remembers gear taken off for a quest and which towns' saloons were checked. */
export class QuestModule {
  private host: QuestHost;
  /** Quest id → the item that was worn in that slot before. */
  private swapped = new Map<number, { slot: string; prev: number | null }>();
  private saloonChecked = new Map<number, number>();
  private windowAt = 0;
  private logged = new Set<string>();

  constructor(host: QuestHost) {
    this.host = host;
  }

  private quests(): Quest[] {
    const { state, config } = this.host;
    const rules = state.autopilot.rules;
    return state.quests.filter((quest) => quest.accepted && questInScope(quest, rules, config));
  }

  /** One quest step if there is one to do now; true when it sent a request. */
  async step(): Promise<boolean> {
    const gameState = this.host.state;
    if (!gameState.items) {
      return false;
    }
    const skip = this.host.skipped();
    const quests = this.quests();

    for (const currentQuest of quests.filter((quest) => quest.finishable)) {
      const key = `finish:${currentQuest.id}`;
      if (skip.has(key)) {
        continue;
      }
      // Map quest givers want you there: walk first when not at the giver.
      const at = currentQuest.employerAt;
      const position = gameState.character.position;
      if (at && (at.x !== position.x || at.y !== position.y) && skip.has(`finish-here:${currentQuest.id}`)) {
        if (gameState.queue.length) {
          continue;
        }
        gameState.debug.add('quest', `Walk to ${currentQuest.employerName} to finish ${currentQuest.title}`, {
          quest: currentQuest.id,
          giverAt: at,
          position: position,
        });
        const result = await gameState
          .autopilotCall(() =>
            gameState.tasks.add(
              gameState.queue.length,
              [walkPost(currentQuest.employer, 'questgiver', at)],
              gameState.taskLimit,
            ),
          )
          .catch((entry) => {
            this.host.fail(`walk:${currentQuest.id}`, String(entry));
            return null;
          });
        if (result?.added.length) {
          gameState.queue.push(...result.added);
          gameState.info(`Autopilot: walking to ${currentQuest.employerName} to finish ${currentQuest.title}.`);
        }
        return true;
      }
      const reward = chooseReward(currentQuest.rewardOptions, this.host.config, (textValue) =>
        this.isUpgrade(textValue),
      );
      gameState.debug.add('quest', `Finish ${currentQuest.title}`, {
        quest: currentQuest.id,
        giver: currentQuest.employerName,
        giverAt: at,
        position: position,
        rewardOptions: currentQuest.rewardOptions,
        chosen: reward,
      });
      const before = gameState.log.length;
      await gameState.finishQuest(currentQuest, reward);
      if (gameState.log.slice(before).some((line) => line.level === 'error')) {
        this.host.fail(at ? `finish-here:${currentQuest.id}` : key, `could not finish ${currentQuest.title}`);
      }
      return true;
    }

    for (const wearQuest of quests) {
      for (const requirement of wearQuest.requirements.filter((openRequirement) => !openRequirement.solved)) {
        if (requirement.kind === 'wear' && requirement.itemId !== undefined) {
          const requiredBase = baseId(requirement.itemId);
          if (gameState.inventory.countBase(requirement.itemId) > 0 && !skip.has(`wear:${requirement.itemId}`)) {
            const id = [...gameState.inventory.bag.values()].find(
              (second) => baseId(second.itemId) === requiredBase,
            )?.itemId;
            if (id === undefined) {
              continue;
            }
            const slot = gameState.items.get(id)?.type ?? '';
            if (!this.swapped.has(wearQuest.id)) {
              this.swapped.set(wearQuest.id, { slot, prev: gameState.inventory.wear.get(slot) ?? null });
            }
            gameState.debug.add('quest', `Wear ${gameState.itemName(id)} for ${wearQuest.title}`, {
              quest: wearQuest.id,
              requirement: requirement.info,
              slot,
              previous: this.swapped.get(wearQuest.id),
            });
            const before = gameState.log.length;
            await gameState.wear(id);
            if (gameState.log.slice(before).some((line) => line.level === 'error')) {
              this.host.fail(
                `wear:${requirement.itemId}`,
                `could not wear ${gameState.itemName(id)} for ${wearQuest.title}`,
              );
            } else {
              void gameState.loadQuests(true);
            }
            return true;
          }
        } else if (requirement.kind === 'other') {
          this.once(
            `other:${requirement.info}`,
            `Autopilot: skipping a requirement it cannot do yet: "${requirement.info}" (${wearQuest.title}).`,
          );
        }
      }
    }

    if (await this.buyStep(quests, skip)) {
      return true;
    }

    // Everything done but the time window: re-read the quest log now and then (the server should mark the
    // window solved inside it; unverified), so the finish above happens in time.
    const waiting = quests.filter(
      (currentQuest) =>
        !currentQuest.finishable &&
        currentQuest.requirements.some((requirement) => !requirement.solved) &&
        currentQuest.requirements.every((requirement) => requirement.solved || requirement.kind === 'window'),
    );
    if (waiting.length && Date.now() - this.windowAt > WINDOW_CHECK_MS) {
      this.windowAt = Date.now();
      gameState.debug.add(
        'quest',
        `Waiting for a time window: re-reading the quest log (${waiting.map((currentQuest) => currentQuest.title).join(', ')})`,
        {
          windows: waiting.map((currentQuest) => ({
            quest: currentQuest.id,
            window: currentQuest.requirements.find((requirement) => requirement.kind === 'window')?.window,
          })),
        },
      );
      await gameState.loadQuests(true);
      return true;
    }

    // Quest done (finished or wear requirement solved): put the old gear back unless the quest item is better.
    for (const [qid, sw] of this.swapped) {
      const found = gameState.quests.find((currentQuest) => currentQuest.id === qid);
      const stillNeeded =
        found?.requirements.some((requirement) => requirement.kind === 'wear' && !requirement.solved) ||
        (found && !found.finishable && found.requirements.some((requirement) => requirement.kind === 'wear'));
      if (stillNeeded) {
        continue;
      }
      this.swapped.delete(qid);
      gameState.debug.add('quest', `Quest gear no longer needed (${found?.title ?? qid})`, {
        slot: sw.slot,
        previous: sw.prev && gameState.itemName(sw.prev),
      });
      if (
        sw.prev &&
        gameState.inventory.count(sw.prev) > 0 &&
        !this.betterThan(gameState.inventory.wear.get(sw.slot), sw.prev)
      ) {
        await gameState.wear(sw.prev);
        gameState.info(`Autopilot: put ${gameState.itemName(sw.prev)} back on.`);
        return true;
      }
    }

    return this.acceptInTown(skip);
  }

  /** The planned shop stop (you are in the town): buy and pick up what is due here; true when it did something. */
  async buyHere(): Promise<boolean> {
    return this.buyStep(this.quests(), this.host.skipped());
  }

  /**
   * One purchase or pickup: market goods waiting in the town you are in; then, for quests it can finish once
   * the items are bought, what needs no walk (mobile trader, market offers) or sells in this town's shops.
   */
  private async buyStep(quests: Quest[], skip: Set<string>): Promise<boolean> {
    const gameState = this.host.state;
    const here = gameState.townHere;
    const pickup = here && gameState.autopilot.pickups.find((pickInfo) => pickInfo.townId === here.id);
    if (pickup) {
      await this.pickUp(pickup);
      return true;
    }
    if (!this.host.config.quests.buy) {
      return false;
    }
    const all = gameState.questPurchases(quests);
    for (const currentQuest of quests) {
      const entry = all.get(currentQuest.id);
      if (!entry || entry.blocker || entry.problem) {
        continue;
      }
      for (const pick of entry.picks) {
        if (pick.source.kind === 'shop' && pick.source.townId !== here?.id) {
          continue;
        }
        const key = `item:${baseId(pick.itemId)}`;
        if (skip.has(key)) {
          continue;
        }
        if (pick.cost > this.host.budget()) {
          this.once(
            `budget:${currentQuest.id}:${baseId(pick.itemId)}`,
            `Autopilot: ${pick.name} ($${pick.cost}) for ${currentQuest.title} is over what is left of today's spend cap ($${this.host.budget()}).`,
          );
          continue;
        }
        await this.buy(currentQuest, pick, key);
        return true;
      }
    }
    return false;
  }

  private async buy(currentQuest: Quest, pick: BuyPick, key: string): Promise<void> {
    const gameState = this.host.state;
    const src = pick.source;
    const money = (result: { cash?: number | undefined; deposit?: number | undefined }) => {
      if (typeof result.cash === 'number') {
        gameState.character.cash = result.cash;
      }
      if (typeof result.deposit === 'number') {
        gameState.character.deposit = result.deposit;
      }
    };
    gameState.debug.add('quest', `Buy ${pick.count}× ${pick.name} for ${currentQuest.title} (${where(src)})`, {
      quest: currentQuest.id,
      pick,
      budget: this.host.budget(),
      cash: gameState.character.cash,
      deposit: gameState.character.deposit,
    });
    try {
      if (src.kind === 'shop') {
        for (let index = 0; index < pick.count; index++) {
          const result = await gameState.autopilotCall(
            () => shopBuy(gameState.client, src.shop, src.townId, pick.itemId, gameState.inventory.lastInvId),
            `buy ${pick.name} (${where(src)})`,
          );
          gameState.inventory.applyChanges(result.changes);
          money(result);
        }
      } else if (src.kind === 'mobile') {
        for (let innerIndex = 0; innerIndex < pick.count; innerIndex++) {
          money(
            await gameState.autopilotCall(
              () => buyMobileTrader(gameState.client, src.item, 'dollar'),
              `buy ${pick.name} (mobile trader)`,
            ),
          );
        }
        gameState.buyCatalog.mobile = null; // stock and limited counts changed: read it again
        await gameState.refreshInventory();
      } else {
        // Instant buy at the offer's price, from the bank when cash is short (bidtype 1); goods wait in its town.
        const fromBank = gameState.character.cash < src.price;
        const resultValue = await gameState.autopilotCall(
          () => new MarketApi(gameState.client).bid(src.offer, src.price, fromBank),
          `buy ${pick.name} (${where(src)})`,
        );
        gameState.buyCatalog.dropOffer(src.offer.id);
        if (!resultValue.instant) {
          throw new Error('the offer did not sell at its buy-now price (bid placed instead)');
        }
        money(resultValue);
        gameState.updateAutopilot((autopilotFile) =>
          autopilotFile.pickups.push({
            offerId: src.offer.id,
            itemId: pick.itemId,
            count: pick.count,
            townId: src.townId,
            townName: src.townName,
            at: src.at,
            quest: currentQuest.soloTitle || currentQuest.title,
          }),
        );
      }
      this.host.spend(pick.cost);
      gameState.info(
        `Autopilot: bought ${pick.count > 1 ? `${pick.count}× ` : ''}${pick.name} for ${currentQuest.title} ($${pick.cost}, ${where(src)})${src.kind === 'market' ? `; picking it up in ${src.townName}` : ''}.`,
      );
      void gameState.loadQuests(true);
    } catch (err) {
      this.host.fail(key, `buying ${pick.name} (${where(src)}): ${errorMessage(err)}`);
    }
  }

  /** Picks up market goods bought for a quest; once only: a failure leaves it to you (trade screen, market). */
  private async pickUp(pickInfo: MarketPickup): Promise<void> {
    const gameState = this.host.state;
    const name = gameState.itemName(pickInfo.itemId);
    gameState.debug.add('quest', `Pick up ${name} at the market in ${pickInfo.townName}`, { pickup: pickInfo });
    gameState.updateAutopilot(
      (autopilotFile) =>
        (autopilotFile.pickups = autopilotFile.pickups.filter((xCoord) => xCoord.offerId !== pickInfo.offerId)),
    );
    try {
      await gameState.autopilotCall(
        () => new MarketApi(gameState.client).fetch(pickInfo.offerId),
        `market: pick up ${name}`,
      );
      gameState.info(`Autopilot: picked up ${name} at the market in ${pickInfo.townName} (for ${pickInfo.quest}).`);
      await gameState.refreshInventory();
      void gameState.loadQuests(true);
    } catch (err) {
      gameState.error(
        `Autopilot: could not pick up ${name} in ${pickInfo.townName}: ${errorMessage(err)}. Pick it up on the market tab of the trade screen.`,
      );
    }
  }

  /** In a town: once an hour, accept what its saloon offers (filters, room in the quest log). */
  private async acceptInTown(skip: Set<string>): Promise<boolean> {
    const gameState = this.host.state;
    const town = gameState.townHere;
    if (!town || Date.now() - (this.saloonChecked.get(town.id) ?? 0) < 3600_000) {
      return false;
    }
    this.saloonChecked.set(town.id, Date.now());
    if (gameState.questCapacity && gameState.quests.length >= gameState.questCapacity) {
      return false;
    }
    await gameState.loadSaloon();
    gameState.debug.add('quest', `Saloon in ${town.name}: ${gameState.saloon.length} quest giver(s)`, {
      givers: gameState.saloon,
      questLog: `${gameState.quests.length}/${gameState.questCapacity || '?'}`,
    });
    const cfg = this.host.config;
    for (const entry of gameState.saloon) {
      if (!(await gameState.openEmployer(entry.key)) || !gameState.employer) {
        continue;
      }
      for (const currentQuest of gameState.employer.open) {
        if (!currentQuest.acceptable || currentQuest.accepted || skip.has(`accept:${currentQuest.id}`)) {
          continue;
        }
        if (
          cfg.quests.excludedChains.includes(currentQuest.group) ||
          (!cfg.quests.repeatable && /repeatable/i.test(currentQuest.group))
        ) {
          continue;
        }
        if (gameState.questCapacity && gameState.quests.length >= gameState.questCapacity) {
          return true;
        }
        gameState.debug.add('quest', `Accept ${currentQuest.title}`, {
          quest: currentQuest.id,
          chain: currentQuest.group,
          giver: entry.name,
          requirements: currentQuest.requirements,
        });
        await gameState.acceptQuest(currentQuest);
      }
    }
    return true;
  }

  private isUpgrade(text: string): boolean {
    const gameState = this.host.state;
    const id = gameState.items?.findByName(text.trim());
    if (id === undefined) {
      return false;
    }
    const slot = gameState.items?.get(id)?.type;
    const req = gameState.requiredLevel(id);
    if (!slot || (req && req.level > gameState.character.level)) {
      return false;
    }
    return this.betterThan(id, gameState.inventory.wear.get(slot) ?? undefined);
  }

  /** Item a beats b by total attribute + skill points (a rough "better gear" test). */
  private betterThan(value: number | undefined, currentValue: number | undefined): boolean {
    if (!value) {
      return false;
    }
    if (!currentValue) {
      return true;
    }
    const gameState = this.host.state;
    const pts = (id: number) => {
      const entry = gameState.items?.get(id);
      return entry
        ? Object.values(entry.attributes).reduce((accumulator, current) => accumulator + current, 0) +
            Object.values(entry.skills).reduce((accumulator, current) => accumulator + current, 0)
        : 0;
    };
    return pts(value) > pts(currentValue);
  }

  private once(key: string, msg: string): void {
    if (this.logged.has(key)) {
      return;
    }
    this.logged.add(key);
    this.host.state.debug.add('quest', msg.replace(/^Autopilot: /, 'Skip: '), { key });
    this.host.state.info(msg);
  }
}
