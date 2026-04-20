import * as React from 'react';
import { ArchitectEmblem } from './architect.js';
import { CitizenEmblem } from './citizen.js';
import { LegendaryEmblem } from './legendary.js';
import { MythicEmblem } from './mythic.js';
import { OperativeEmblem } from './operative.js';
import { PartisanEmblem } from './partisan.js';
import { SenatorEmblem } from './senator.js';
import { StatesmanEmblem } from './statesman.js';
import { StrategistEmblem } from './strategist.js';
import { TacticianEmblem } from './tactician.js';
import { VanguardEmblem } from './vanguard.js';
import { VoterEmblem } from './voter.js';

export const EMBLEMS = {
  citizen: CitizenEmblem,
  voter: VoterEmblem,
  partisan: PartisanEmblem,
  operative: OperativeEmblem,
  strategist: StrategistEmblem,
  tactician: TacticianEmblem,
  vanguard: VanguardEmblem,
  senator: SenatorEmblem,
  statesman: StatesmanEmblem,
  architect: ArchitectEmblem,
  legendary: LegendaryEmblem,
  mythic: MythicEmblem,
} as const satisfies Record<string, () => React.ReactElement>;

export type EmblemId = keyof typeof EMBLEMS;
