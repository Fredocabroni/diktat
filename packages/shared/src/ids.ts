import { z } from 'zod';

const uuid = z.string().uuid();

export type UserId = string & { readonly __brand: 'UserId' };
export type WalletId = string & { readonly __brand: 'WalletId' };
export type ApTransactionId = string & { readonly __brand: 'ApTransactionId' };
export type BattleId = string & { readonly __brand: 'BattleId' };
export type RoundId = string & { readonly __brand: 'RoundId' };
export type TopicId = string & { readonly __brand: 'TopicId' };
export type PredictionId = string & { readonly __brand: 'PredictionId' };
export type FactCheckId = string & { readonly __brand: 'FactCheckId' };
export type ClipId = string & { readonly __brand: 'ClipId' };
export type TribeId = string & { readonly __brand: 'TribeId' };
export type TriviaQuestionId = string & { readonly __brand: 'TriviaQuestionId' };
export type XPostId = string & { readonly __brand: 'XPostId' };

const make =
  <T extends string>(_brand: T) =>
  (raw: string): string & { readonly __brand: T } =>
    uuid.parse(raw) as string & { readonly __brand: T };

export const userId = make('UserId') as (raw: string) => UserId;
export const walletId = make('WalletId') as (raw: string) => WalletId;
export const apTransactionId = make('ApTransactionId') as (raw: string) => ApTransactionId;
export const battleId = make('BattleId') as (raw: string) => BattleId;
export const roundId = make('RoundId') as (raw: string) => RoundId;
export const topicId = make('TopicId') as (raw: string) => TopicId;
export const predictionId = make('PredictionId') as (raw: string) => PredictionId;
export const factCheckId = make('FactCheckId') as (raw: string) => FactCheckId;
export const clipId = make('ClipId') as (raw: string) => ClipId;
export const tribeId = make('TribeId') as (raw: string) => TribeId;
export const triviaQuestionId = make('TriviaQuestionId') as (raw: string) => TriviaQuestionId;
export const xPostId = make('XPostId') as (raw: string) => XPostId;

export const UserIdSchema = uuid.transform(userId);
export const WalletIdSchema = uuid.transform(walletId);
export const ApTransactionIdSchema = uuid.transform(apTransactionId);
export const BattleIdSchema = uuid.transform(battleId);
export const RoundIdSchema = uuid.transform(roundId);
export const TopicIdSchema = uuid.transform(topicId);
export const PredictionIdSchema = uuid.transform(predictionId);
export const FactCheckIdSchema = uuid.transform(factCheckId);
export const ClipIdSchema = uuid.transform(clipId);
export const TribeIdSchema = uuid.transform(tribeId);
export const TriviaQuestionIdSchema = uuid.transform(triviaQuestionId);
export const XPostIdSchema = uuid.transform(xPostId);
