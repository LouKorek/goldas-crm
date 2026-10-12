// The unified player model: one `players` collection, every person has a
// stage (the relationship with the agency) and a category (the market).

export const STAGES = ['tracking', 'in_process', 'represented', 'not_relevant'] as const;
export type Stage = typeof STAGES[number];

export const STAGE_LABELS: Record<Stage, { he: string; en: string }> = {
  tracking:     { he: 'במעקב',     en: 'Tracking' },
  in_process:   { he: 'בתהליך',    en: 'In process' },
  represented:  { he: 'מיוצג',     en: 'Represented' },
  not_relevant: { he: 'לא רלוונטי', en: 'Not relevant' },
};

export const CATEGORIES = ['men', 'women', 'youth', 'jewish'] as const;
export type Category = typeof CATEGORIES[number];

export const CATEGORY_LABELS: Record<Category, { he: string; en: string }> = {
  men:    { he: 'גברים',       en: 'Men' },
  women:  { he: 'נשים',        en: 'Women' },
  youth:  { he: 'נוער',        en: 'Youth' },
  jewish: { he: 'יהודים', en: 'Jewish abroad' },
};

/** The legacy pipeline_* collection for each category. */
export const LEGACY_PIPELINE_COLLECTIONS: Record<Category, string> = {
  men: 'pipeline_men', women: 'pipeline_women', youth: 'pipeline_youth', jewish: 'pipeline_jewish',
};

/** Deal stages are the 9 pipeline statuses the agency already uses. */
export const DEAL_STAGES = [
  'Not Contacted', 'Waiting Response', 'Initial Talks', 'Mandate Received',
  'Offered to Club', 'Negotiation', 'Draft Signed', 'Contract Signed', 'Not Relevant',
] as const;
export type DealStage = typeof DEAL_STAGES[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  'Not Contacted': 'לא נוצר קשר', 'Waiting Response': 'ממתין לתגובה', 'Initial Talks': 'שיחות ראשונות',
  'Mandate Received': 'מנדט התקבל', 'Offered to Club': 'הוצע למועדון', 'Negotiation': 'משא ומתן',
  'Draft Signed': 'טיוטה נחתמה', 'Contract Signed': 'חוזה נחתם', 'Not Relevant': 'לא רלוונטי',
};

export const isDealStage = (v: unknown): v is DealStage => (DEAL_STAGES as readonly string[]).includes(String(v));

/**
 * The player stage implied by a pipeline status. "Contract Signed" keeps the
 * player in process: promotion to represented is an explicit step (one click),
 * so a signed candidate is never silently mixed into the represented list.
 */
export const stageFromStatus = (status: unknown): Stage => {
  const s = String(status || '');
  if (s === 'Not Relevant') return 'not_relevant';
  if (s === 'Not Contacted' || s === '') return 'tracking';
  return 'in_process';
};

/** Category of a represented player from the fields the old form kept. */
export const categoryFromPlayer = (p: { gender?: unknown; currentClubIsYouth?: unknown; category?: unknown }): Category => {
  if (p.category && (CATEGORIES as readonly string[]).includes(String(p.category))) return p.category as Category;
  if (String(p.gender || '') === 'Women') return 'women';
  if (p.currentClubIsYouth) return 'youth';
  return 'men';
};

/** Display name regardless of which legacy field the record carries. */
export const playerName = (p: { name?: unknown; fullName?: unknown; playerName?: unknown }): string =>
  String(p.name || p.fullName || p.playerName || '').trim();

/** Deals older than this many days in "Waiting Response" raise an alert. */
export const DEAL_STALE_DAYS = 14;
