import { z } from 'zod';

export const TIER_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
export const TierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10),
  z.literal(11),
]);
export type Tier = z.infer<typeof TierSchema>;

export const BattleModeSchema = z.enum(['trivia', 'open_debate', 'voice_debate']);
export type BattleMode = z.infer<typeof BattleModeSchema>;

export const BattleStatusSchema = z.enum(['queued', 'live', 'settled', 'cancelled']);
export type BattleStatus = z.infer<typeof BattleStatusSchema>;

export const PredictionDirectionSchema = z.enum(['yes', 'no']);
export type PredictionDirection = z.infer<typeof PredictionDirectionSchema>;

export const PredictionStatusSchema = z.enum(['open', 'settled', 'void']);
export type PredictionStatus = z.infer<typeof PredictionStatusSchema>;

export const FactCheckVerdictSchema = z.enum(['true', 'false', 'misleading', 'unverified']);
export type FactCheckVerdict = z.infer<typeof FactCheckVerdictSchema>;

export const XPostStatusSchema = z.enum(['pending', 'approved', 'posted', 'rejected']);
export type XPostStatus = z.infer<typeof XPostStatusSchema>;

export const ApReasonSchema = z.enum([
  'battle_win',
  'battle_loss',
  'prediction_settle',
  'ghost_credit',
  'streak_bonus',
  'admin_adjust',
]);
export type ApReason = z.infer<typeof ApReasonSchema>;

export const OpinionPositionSchema = z.number().int().gte(-2).lte(2);
export type OpinionPosition = z.infer<typeof OpinionPositionSchema>;
