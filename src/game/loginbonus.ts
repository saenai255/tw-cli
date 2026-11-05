// Daily login bonus collection: west.player.LoginBonus (tw2game @621677).
//   GET/POST game.php?window=loginbonus → {couponAmount, nuggetAmount, currentStage, rewardCollected, ...}
//   loginbonus/collect → {rewards:{xp?, nuggets?, upb?, items?}}
// The TUI checks Player.hasLoginBonus on startup and collects automatically; there is no bonus page.
// The browser's 7-day pony-express delivery (`collect_item`) is intentionally not used here.
import type { GameClient } from '../http/game-client.ts';
import { type JsonObject, obj } from '../util/json.ts';

export interface LoginBonusRewards {
  xp: number;
  nuggets: number;
  bonds: number;
}

const errorText = (json: JsonObject): string => String(json.msg ?? json.error ?? 'Login bonus failed');

/** Collects today's five-day streak reward (LoginBonus.collectReward). */
export async function collectLoginBonus(client: GameClient): Promise<LoginBonusRewards> {
  const json = await client.remoteCall('loginbonus', 'collect', {});
  if (json.error) {
    throw new Error(errorText(json));
  }
  const rewards = obj(json.rewards);
  return {
    xp: Number(rewards.xp) || 0,
    nuggets: Number(rewards.nuggets) || 0,
    bonds: Number(rewards.upb) || 0,
  };
}

/** Human-readable summary of a collect reply (the browser shows reward widgets). */
export function loginRewardText(rewards: LoginBonusRewards): string {
  const parts: string[] = [];
  if (rewards.xp) {
    parts.push(`+${rewards.xp} XP`);
  }
  if (rewards.nuggets) {
    parts.push(`+${rewards.nuggets} nugget${rewards.nuggets === 1 ? '' : 's'}`);
  }
  if (rewards.bonds) {
    parts.push(`+${rewards.bonds} bond${rewards.bonds === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}
