// ── Positions ────────────────────────────────────────────────────
export const POSITIONS = ['GK','CB','RB','LB','CDM','CM','CAM','RM','LM','RW','LW','CF','ST'];

// ── Foot ─────────────────────────────────────────────────────────
export const FOOT_OPTIONS = ['Right','Left','Both'];

// ── National Team Status ─────────────────────────────────────────
export const NAT_TEAM_STATUS = [
  'Current Senior','Former Senior','Current Youth','Former Youth','None'
];

// ── Contract Status ───────────────────────────────────────────────
export const CONTRACT_STATUS = ['Free','Under Contract','Loan','Trial'];

// ── Transfer Status ──────────────────────────────────────
export const PIPELINE_STATUS = [
  'Not Contacted','Waiting Response','Initial Talks',
  'Mandate Received','Offered to Club','Negotiation',
  'Draft Signed','Contract Signed','Not Relevant'
];

export const PIPELINE_STATUS_COLORS = {
  'Not Contacted':    { bg:'rgba(139,148,158,0.1)',  text:'#8B949E' },
  'Waiting Response': { bg:'rgba(96,165,250,0.12)',  text:'#60A5FA' },
  'Initial Talks':    { bg:'rgba(251,191,36,0.12)',  text:'#FBBF24' },
  'Mandate Received': { bg:'rgba(74,222,128,0.12)',  text:'#4ADE80' },
  'Offered to Club':  { bg:'rgba(167,139,250,0.12)', text:'#A78BFA' },
  'Negotiation':      { bg:'rgba(251,146,60,0.12)',  text:'#FB923C' },
  'Draft Signed':     { bg:'rgba(34,197,94,0.12)',   text:'#22C55E' },
  'Contract Signed':  { bg:'rgba(74,222,128,0.2)',   text:'#4ADE80' },
  'Not Relevant':     { bg:'rgba(248,113,113,0.1)',  text:'#F87171' },
};

// ── Contact Roles ─────────────────────────────────────────────────
export const CONTACT_ROLES = [
  'Sporting Director','Head Coach','CEO','President',
  'Scout','Agent','Technical Director','Other'
];

// ── League Tiers ─────────────────────────────────────────────────
export const LEAGUE_TIERS = ['1st','2nd','3rd','4th','5th+'];
export const LEAGUE_TIER_VALUES = ['Tier 1','Tier 2','Tier 3','Tier 4','Tier 5+'];

// ── Countries ─────────────────────────────────────────────────────
export const COUNTRIES = [
  'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda',
  'Argentina','Armenia','Australia','Austria','Azerbaijan',
  'Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize',
  'Benin','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Brazil',
  'Brunei','Bulgaria','Burkina Faso','Burundi',
  'Cambodia','Cameroon','Canada','Cape Verde','Central African Republic',
  'Chad','Chile','China','Colombia','Comoros','Congo','Costa Rica','Croatia',
  'Cuba','Cyprus','Czech Republic',
  'Denmark','Djibouti','Dominican Republic','DR Congo',
  'Ecuador','Egypt','El Salvador','England','Equatorial Guinea','Eritrea',
  'Estonia','Eswatini','Ethiopia',
  'Fiji','Finland','France',
  'Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala',
  'Guinea','Guinea-Bissau','Guyana',
  'Haiti','Honduras','Hungary',
  'Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy',
  'Jamaica','Japan','Jordan',
  'Kazakhstan','Kenya','Kosovo','Kuwait','Kyrgyzstan',
  'Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein',
  'Lithuania','Luxembourg',
  'Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Mauritania',
  'Mauritius','Mexico','Moldova','Monaco','Mongolia','Montenegro','Morocco',
  'Mozambique','Myanmar',
  'Namibia','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria',
  'North Korea','North Macedonia','Northern Ireland','Norway',
  'Oman',
  'Pakistan','Palestine','Panama','Papua New Guinea','Paraguay','Peru',
  'Philippines','Poland','Portugal',
  'Qatar',
  'Romania','Russia','Rwanda',
  'San Marino','Saudi Arabia','Scotland','Senegal','Serbia','Sierra Leone',
  'Singapore','Slovakia','Slovenia','Solomon Islands','Somalia','South Africa',
  'South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden',
  'Switzerland','Syria',
  'Tajikistan','Tanzania','Thailand','Timor-Leste','Togo',
  'Trinidad and Tobago','Tunisia','Turkey','Turkmenistan',
  'Uganda','Ukraine','United Arab Emirates','United Kingdom','United States',
  'Uruguay','Uzbekistan',
  'Venezuela','Vietnam',
  'Wales',
  'Yemen',
  'Zambia','Zimbabwe'
];

// ── EU Countries ─────────────────────────────────────────────────
export const EU_COUNTRIES = [
  'Austria','Belgium','Bulgaria','Croatia','Cyprus','Czech Republic','Denmark',
  'Estonia','Finland','France','Germany','Greece','Hungary','Ireland','Italy',
  'Latvia','Lithuania','Luxembourg','Malta','Netherlands','Poland','Portugal',
  'Romania','Slovakia','Slovenia','Spain','Sweden'
];

export const isEuropean = (nationalities = []) =>
  nationalities.some(n => EU_COUNTRIES.includes(n));

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
    // Handle YYYY-MM-DD format from date inputs
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [y, m, day] = d.split('-');
      return `${day}/${m}/${y}`;
    }
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    const day = String(dt.getDate()).padStart(2,'0');
    const mon = String(dt.getMonth()+1).padStart(2,'0');
    const yr  = dt.getFullYear();
    return `${day}/${mon}/${yr}`;
  } catch { return String(d); }
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

// ── Notification advance days ─────────────────────────────────────
export const ALERT_DAYS = [0, 7, 14, 30, 60, 90];
