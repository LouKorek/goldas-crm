// Zod schemas for the records every layer writes. Firestore timestamps and
// server values are left loose (`unknown`) on purpose; the schemas guard the
// fields people and Golda fill, not the bookkeeping fields db.js adds.
import { z } from 'zod';
import { STAGES, CATEGORIES, DEAL_STAGES } from './stages.js';
import { POSITIONS, FOOT_OPTIONS, CONTRACT_STATUS, CONTACT_ROLES } from './constants.js';
import { AGE_GROUPS } from './ageGroups.js';

const str = z.string().trim();
const optStr = str.optional().default('');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).optional().default('');

export const fileRefSchema = z.object({
  fileId: str.optional(), url: str.optional(), name: optStr, originalName: optStr,
  type: optStr, size: z.number().optional(), uploadedAt: optStr, uploadedBy: optStr,
}).passthrough();

export const linkedClubSchema = z.object({ clubName: str, clubId: str.optional(), linkedAt: optStr }).passthrough();

export const ageGroupOverrideSchema = z.object({
  id: z.enum(AGE_GROUPS.map((g) => g.id) as [string, ...string[]]),
  season: z.number().int(),
});

export const playerSchema = z.object({
  name: str.min(1),
  stage: z.enum(STAGES),
  category: z.enum(CATEGORIES),
  gender: z.enum(['Men', 'Women', '']).optional().default(''),
  nationalities: z.array(str).optional().default([]),
  dob: dateStr,
  primaryPosition: z.enum(POSITIONS).or(z.literal('')).optional().default(''),
  secondaryPositions: z.array(z.enum(POSITIONS)).optional().default([]),
  foot: z.enum(FOOT_OPTIONS).or(z.literal('')).optional().default(''),
  height: z.union([z.number(), str]).optional(),
  currentClub: optStr,
  currentClubId: optStr,
  currentClubIsYouth: z.boolean().optional().default(false),
  leagueCountry: optStr, leagueTier: optStr, leagueManual: optStr, leagueMode: optStr,
  natTeamStatus: optStr, natTeamCountry: optStr,
  contractStatus: z.enum(CONTRACT_STATUS).or(z.literal('')).optional().default(''),
  contractStart: dateStr, contractEnd: dateStr, reprStart: dateStr, reprEnd: dateStr,
  passportNumber: optStr, passportExpiry: dateStr,
  agentName: optStr, agentPhone: optStr,
  transferFee: optStr, salary: optStr,
  profileLink: optStr, videoLink: optStr, ifaTeamUrl: optStr,
  notes: optStr,
  source: z.enum(['manual', 'tm_watch', 'migration', 'golda']).optional().default('manual'),
  ageGroupOverride: ageGroupOverrideSchema.nullable().optional(),
  linkedClubs: z.array(linkedClubSchema).optional().default([]),
  contractFiles: z.array(fileRefSchema).optional().default([]),
  passportFiles: z.array(fileRefSchema).optional().default([]),
  reprFiles: z.array(fileRefSchema).optional().default([]),
  deletedAt: z.unknown().nullable().optional(),
}).passthrough();
export type Player = z.infer<typeof playerSchema>;

export const clubSchema = z.object({
  name: str.min(1),
  key: str.min(1),
  aliases: z.array(str).optional().default([]),
  country: optStr,
  leagueTier: optStr,
  logoUrl: optStr,
  logoFileId: optStr,
  website: optStr,
  notes: optStr,
  deletedAt: z.unknown().nullable().optional(),
}).passthrough();
export type Club = z.infer<typeof clubSchema>;

export const teamSchema = z.object({
  name: str.min(1),
  kind: z.enum(['senior', 'youth', 'women', 'other']).default('senior'),
  ageGroupId: optStr,
  ifaTeamUrl: optStr,
}).passthrough();

export const dealStageEntrySchema = z.object({ stage: z.enum(DEAL_STAGES), at: str, by: optStr, note: optStr });

export const dealSchema = z.object({
  playerId: str.min(1),
  playerName: str,
  category: z.enum(CATEGORIES),
  clubId: optStr,
  clubName: str.min(1),
  stage: z.enum(DEAL_STAGES),
  history: z.array(dealStageEntrySchema).optional().default([]),
  enteredStageAt: optStr,
  transferFee: optStr, salary: optStr, commission: optStr,
  mandateFiles: z.array(fileRefSchema).optional().default([]),
  owner: optStr,
  notes: optStr,
  source: z.enum(['manual', 'migration', 'golda']).optional().default('manual'),
  closedAt: z.unknown().nullable().optional(),
  deletedAt: z.unknown().nullable().optional(),
}).passthrough();
export type Deal = z.infer<typeof dealSchema>;

export const INTERACTION_KINDS = ['note', 'call', 'meeting', 'message', 'stage_change', 'promotion', 'system'] as const;
export const interactionSchema = z.object({
  kind: z.enum(INTERACTION_KINDS),
  playerId: optStr,
  dealId: optStr,
  clubId: optStr,
  text: str,
  by: optStr,
  at: str,
}).passthrough();

export const contactSchema = z.object({
  clubName: optStr, clubId: optStr, clubIsYouth: z.boolean().optional().default(false),
  contactName: str.min(1),
  contactRole: z.enum(CONTACT_ROLES).or(z.literal('')).optional().default(''),
  contactPhone: optStr,
  deletedAt: z.unknown().nullable().optional(),
}).passthrough();

export const auditSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'restore', 'purge', 'migrate']),
  collection: str,
  docId: str,
  by: optStr,
  byName: optStr,
  via: z.enum(['web', 'golda', 'server']).default('web'),
  at: z.unknown(),
  fields: z.array(str).optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
}).passthrough();
