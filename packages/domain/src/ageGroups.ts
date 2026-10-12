// Youth age groups by the Israeli FA (IFA) cohort rule.
//
// Only the RULE is stored: a season starts on July 1, and a player's group
// is decided by (season start year - birth year). The data for a given
// group changes every year, so nothing here is pinned to a season; the
// group is recomputed for whatever season is asked for. A manual override
// on the player record always wins (see resolveAgeGroup).

export const SEASON_START_MONTH = 7; // July

export const AGE_GROUPS = [
  { id: 'noar',      he: 'נוער',     en: 'U19', diffs: [17, 18] },
  { id: 'nearim_a',  he: "נערים א'", en: 'U17', diffs: [16] },
  { id: 'nearim_b',  he: "נערים ב'", en: 'U16', diffs: [15] },
  { id: 'nearim_c',  he: "נערים ג'", en: 'U15', diffs: [14] },
  { id: 'yeladim_a', he: "ילדים א'", en: 'U14', diffs: [13] },
  { id: 'yeladim_b', he: "ילדים ב'", en: 'U13', diffs: [12] },
  { id: 'yeladim_c', he: "ילדים ג'", en: 'U12', diffs: [11] },
  { id: 'trom_a',    he: "טרום א'",  en: 'U11', diffs: [10] },
  { id: 'trom_b',    he: "טרום ב'",  en: 'U10', diffs: [9] },
  { id: 'trom_c',    he: "טרום ג'",  en: 'U9',  diffs: [8] },
] as const;

export type AgeGroupId = typeof AGE_GROUPS[number]['id'];
export type AgeGroup = typeof AGE_GROUPS[number];

export const ageGroupById = (id: unknown): AgeGroup | undefined =>
  AGE_GROUPS.find((g) => g.id === id);

/** Year the current (or given date's) season started: July 1 boundary. */
export const seasonStartYear = (at: Date = new Date()): number =>
  at.getMonth() + 1 >= SEASON_START_MONTH ? at.getFullYear() : at.getFullYear() - 1;

/** "2026/27" style label for the season containing `at`. */
export const seasonLabel = (at: Date = new Date()): string => {
  const y = seasonStartYear(at);
  return `${y}/${String(y + 1).slice(2)}`;
};

const birthYearOf = (dob: unknown): number | null => {
  if (dob == null || dob === '') return null;
  if (dob instanceof Date) return isNaN(dob.getTime()) ? null : dob.getFullYear();
  const s = String(dob).trim();
  const m = /^(\d{4})/.exec(s);
  if (m) return Number(m[1]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getFullYear();
};

/**
 * Default age group for a birth date in the season containing `at`.
 * Returns null for adults (older than the youth range) or when the
 * birth date is unusable.
 */
export const ageGroupFor = (dob: unknown, at: Date = new Date()): AgeGroup | null => {
  const by = birthYearOf(dob);
  if (by == null) return null;
  const diff = seasonStartYear(at) - by;
  return AGE_GROUPS.find((g) => (g.diffs as readonly number[]).includes(diff)) ?? null;
};

/** True when the player would fall in a youth group this season. */
export const isYouthAge = (dob: unknown, at: Date = new Date()): boolean => ageGroupFor(dob, at) !== null;

/**
 * The group to show for a player: a manual override (stored id) when set,
 * otherwise the cohort default. Overrides are kept per season so a stale
 * one from last season is ignored.
 */
export const resolveAgeGroup = (
  player: { dob?: unknown; ageGroupOverride?: { id: AgeGroupId; season: number } | null },
  at: Date = new Date(),
): AgeGroup | null => {
  const o = player.ageGroupOverride;
  if (o && o.season === seasonStartYear(at)) {
    const g = ageGroupById(o.id);
    if (g) return g;
  }
  return ageGroupFor(player.dob, at);
};
