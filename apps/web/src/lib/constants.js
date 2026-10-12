// Reference lists (positions, statuses, countries, ISO codes, flags...) live
// in the shared domain package so the web app, the functions and Golda use
// one copy. This file keeps the UI-only formatting helpers.
export {
  POSITIONS, POSITION_ORDER, FOOT_OPTIONS, NAT_TEAM_STATUS, natTeamStatusOf,
  CONTRACT_STATUS, PIPELINE_STATUS, PIPELINE_STATUS_COLORS, CONTACT_ROLES,
  LEAGUE_TIERS, LEAGUE_TIER_VALUES, ALERT_DAYS, COUNTRIES, EU_COUNTRIES,
  isEuropean, ISO2, flagEmoji,
} from '@goldas/domain';

// ── Time slots ────────────────────────────────────────────────────
export const TIME_SLOTS = Array.from({ length: 4 * 24 }, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
});

// ── Age calculation ───────────────────────────────────────────────
export const calcAge = (dob) => {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age;
};

// ── Format number with commas ─────────────────────────────────────
export const fmtNum = (n) => {
  if (!n || n === 'Not specified') return n || '—';
  return Number(String(n).replace(/,/g,'')).toLocaleString();
};

// ── Format date ───────────────────────────────────────────────────
export const fmtDate = (d) => {
  if (!d) return '—';
  try {
    // Handle YYYY-MM-DD format from date inputs — show a 2-digit year (e.g. 26).
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [y, m, day] = d.split('-');
      return `${day}/${m}/${y.slice(2)}`;
    }
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    const day = String(dt.getDate()).padStart(2,'0');
    const mon = String(dt.getMonth()+1).padStart(2,'0');
    const yr  = String(dt.getFullYear()).slice(2);
    return `${day}/${mon}/${yr}`;
  } catch { return String(d); }
};

// ── Phone formatting (by country prefix) ─────────────────────────
// Israel example: "0506665574" / "+972506665574" -> "+972 50 666 5574".
export const formatPhone = (raw) => {
  if (!raw) return '';
  let digits = String(raw).replace(/[^\d+]/g, '');
  // Israeli local number (0XXXXXXXXX) -> international +972
  if (/^0\d{8,9}$/.test(digits)) digits = '+972' + digits.slice(1);
  // Israel
  if (/^\+?972/.test(digits)) {
    const rest = digits.replace(/^\+?972/, '');
    if (rest.length >= 8) return `+972 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`.trim();
    return `+972 ${rest}`.trim();
  }
  // Generic international: keep "+CC" then group the remainder in threes.
  if (digits.startsWith('+')) {
    const m = digits.match(/^\+(\d{1,3})(\d+)$/);
    if (m) return `+${m[1]} ${m[2].replace(/(\d{3})(?=\d)/g, '$1 ')}`.trim();
  }
  return raw;
};

// ── Days until ────────────────────────────────────────────────────
export const daysUntil = (d) => {
  if (!d) return null;
  const diff = new Date(d) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
};

// ── Is birthday soon (within 7 days) ─────────────────────────────
export const isBirthdaySoon = (dob, days = 7) => {
  if (!dob) return false;
  const today = new Date();
  const birth = new Date(dob);
  const thisYear = new Date(today.getFullYear(), birth.getMonth(), birth.getDate());
  if (thisYear < today) thisYear.setFullYear(today.getFullYear() + 1);
  const diff = Math.ceil((thisYear - today) / (1000 * 60 * 60 * 24));
  return diff >= 0 && diff <= days;
};

