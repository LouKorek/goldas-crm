// Single source of truth for the CRM's reference lists.
// Used by the web app, the Netlify functions and Golda.

export const POSITIONS = ['GK','CB','RB','LB','CDM','CM','CAM','RM','LM','RW','LW','CF','ST'] as const;
export type Position = typeof POSITIONS[number];

/** Defensive to offensive sort order. */
export const POSITION_ORDER: Record<Position, number> = Object.fromEntries(
  POSITIONS.map((p, i) => [p, i]),
) as Record<Position, number>;

export const FOOT_OPTIONS = ['Right','Left','Both'] as const;
export type Foot = typeof FOOT_OPTIONS[number];

export const NAT_TEAM_STATUS = ['Current Senior','Former Senior','Current Youth','Former Youth'] as const;
export type NatTeamStatus = typeof NAT_TEAM_STATUS[number];

/** Records written before the "None" chip was removed still hold that literal. */
export const natTeamStatusOf = (v: unknown): string => {
  const s = String(v ?? '').trim();
  return s && s !== 'None' ? s : '';
};

export const CONTRACT_STATUS = ['Free','Under Contract','Loan','Trial'] as const;
export type ContractStatus = typeof CONTRACT_STATUS[number];

export const PIPELINE_STATUS = [
  'Not Contacted','Waiting Response','Initial Talks',
  'Mandate Received','Offered to Club','Negotiation',
  'Draft Signed','Contract Signed','Not Relevant',
] as const;
export type PipelineStatus = typeof PIPELINE_STATUS[number];

export const PIPELINE_STATUS_COLORS: Record<PipelineStatus, { bg: string; text: string }> = {
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

export const CONTACT_ROLES = [
  'Sporting Director','Head Coach','CEO','President',
  'Scout','Agent','Technical Director','Other',
] as const;
export type ContactRole = typeof CONTACT_ROLES[number];

export const LEAGUE_TIERS = ['1st','2nd','3rd','4th','5th+'] as const;
export const LEAGUE_TIER_VALUES = ['Tier 1','Tier 2','Tier 3','Tier 4','Tier 5+'] as const;

export const ALERT_DAYS = [0, 7, 14, 30, 60, 90] as const;

export const COUNTRIES: readonly string[] = [
  "Afghanistan",
  "Albania",
  "Algeria",
  "American Samoa",
  "Andorra",
  "Angola",
  "Anguilla",
  "Antigua and Barbuda",
  "Argentina",
  "Armenia",
  "Aruba",
  "Australia",
  "Austria",
  "Azerbaijan",
  "Bahamas",
  "Bahrain",
  "Bangladesh",
  "Barbados",
  "Belarus",
  "Belgium",
  "Belize",
  "Benin",
  "Bermuda",
  "Bhutan",
  "Bolivia",
  "Bosnia and Herzegovina",
  "Botswana",
  "Brazil",
  "British Virgin Islands",
  "Brunei",
  "Bulgaria",
  "Burkina Faso",
  "Burundi",
  "Cambodia",
  "Cameroon",
  "Canada",
  "Cape Verde",
  "Cayman Islands",
  "Central African Republic",
  "Chad",
  "Chile",
  "China",
  "Chinese Taipei",
  "Colombia",
  "Comoros",
  "Congo",
  "Cook Islands",
  "Costa Rica",
  "Croatia",
  "Cuba",
  "Curacao",
  "Cyprus",
  "Czech Republic",
  "Denmark",
  "Djibouti",
  "Dominica",
  "Dominican Republic",
  "DR Congo",
  "Ecuador",
  "Egypt",
  "El Salvador",
  "England",
  "Equatorial Guinea",
  "Eritrea",
  "Estonia",
  "Eswatini",
  "Ethiopia",
  "Fiji",
  "Finland",
  "France",
  "Gabon",
  "Gambia",
  "Georgia",
  "Germany",
  "Ghana",
  "Gibraltar",
  "Greece",
  "Grenada",
  "Guam",
  "Guatemala",
  "Guinea",
  "Guinea-Bissau",
  "Guyana",
  "Haiti",
  "Honduras",
  "Hong Kong",
  "Hungary",
  "Iceland",
  "India",
  "Indonesia",
  "Iran",
  "Iraq",
  "Ireland",
  "Israel",
  "Italy",
  "Ivory Coast",
  "Jamaica",
  "Japan",
  "Jordan",
  "Kazakhstan",
  "Kenya",
  "Kosovo",
  "Kuwait",
  "Kyrgyzstan",
  "Laos",
  "Latvia",
  "Lebanon",
  "Lesotho",
  "Liberia",
  "Libya",
  "Liechtenstein",
  "Lithuania",
  "Luxembourg",
  "Macau",
  "Madagascar",
  "Malawi",
  "Malaysia",
  "Maldives",
  "Mali",
  "Malta",
  "Mauritania",
  "Mauritius",
  "Mexico",
  "Moldova",
  "Monaco",
  "Mongolia",
  "Montenegro",
  "Montserrat",
  "Morocco",
  "Mozambique",
  "Myanmar",
  "Namibia",
  "Nepal",
  "Netherlands",
  "New Caledonia",
  "New Zealand",
  "Nicaragua",
  "Niger",
  "Nigeria",
  "North Korea",
  "North Macedonia",
  "Northern Ireland",
  "Norway",
  "Oman",
  "Pakistan",
  "Palestine",
  "Panama",
  "Papua New Guinea",
  "Paraguay",
  "Peru",
  "Philippines",
  "Poland",
  "Portugal",
  "Puerto Rico",
  "Qatar",
  "Republic of Ireland",
  "Romania",
  "Russia",
  "Rwanda",
  "Saint Kitts and Nevis",
  "Saint Lucia",
  "Saint Vincent and the Grenadines",
  "Samoa",
  "San Marino",
  "Saudi Arabia",
  "Scotland",
  "Senegal",
  "Serbia",
  "Sierra Leone",
  "Singapore",
  "Slovakia",
  "Slovenia",
  "Solomon Islands",
  "Somalia",
  "South Africa",
  "South Korea",
  "South Sudan",
  "Spain",
  "Sri Lanka",
  "Sudan",
  "Suriname",
  "Sweden",
  "Switzerland",
  "Syria",
  "Tahiti",
  "Tajikistan",
  "Tanzania",
  "Thailand",
  "Timor-Leste",
  "Togo",
  "Trinidad and Tobago",
  "Tunisia",
  "Turkey",
  "Turkmenistan",
  "Turks and Caicos",
  "Uganda",
  "Ukraine",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "Uruguay",
  "US Virgin Islands",
  "Uzbekistan",
  "Vanuatu",
  "Venezuela",
  "Vietnam",
  "Wales",
  "Yemen",
  "Zambia",
  "Zimbabwe"
];

export const EU_COUNTRIES: readonly string[] = [
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Cyprus",
  "Czech Republic",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Ireland",
  "Italy",
  "Latvia",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Netherlands",
  "Poland",
  "Portugal",
  "Romania",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden"
];

export const isEuropean = (nationalities: readonly string[] = []): boolean =>
  nationalities.some((n) => EU_COUNTRIES.includes(n));

/** Country name to ISO alpha-2, keyed by the spellings our forms and Transfermarkt use. */
export const ISO2: Record<string, string> = {
  // Europe
  'Albania':'AL','Andorra':'AD','Armenia':'AM','Austria':'AT','Azerbaijan':'AZ','Belarus':'BY',
  'Belgium':'BE','Bosnia-Herzegovina':'BA','Bulgaria':'BG','Croatia':'HR','Cyprus':'CY',
  'Czech Republic':'CZ','Denmark':'DK','England':'GB-ENG','Estonia':'EE','Faroe Islands':'FO',
  'Finland':'FI','France':'FR','Georgia':'GE','Germany':'DE','Gibraltar':'GI','Greece':'GR',
  'Greenland':'GL','Guernsey':'GG','Hungary':'HU','Iceland':'IS','Ireland':'IE','Isle of Man':'IM',
  'Israel':'IL','Italy':'IT','Jersey':'JE','Kosovo':'XK','Latvia':'LV','Liechtenstein':'LI',
  'Lithuania':'LT','Luxembourg':'LU','Malta':'MT','Moldova':'MD','Monaco':'MC','Montenegro':'ME',
  'Netherlands':'NL','North Macedonia':'MK','Macedonia':'MK','Northern Ireland':'GB-NIR','Norway':'NO',
  'Poland':'PL','Portugal':'PT','Romania':'RO','Russia':'RU','San Marino':'SM','Scotland':'GB-SCT',
  'Serbia':'RS','Slovakia':'SK','Slovenia':'SI','Spain':'ES','Sweden':'SE','Switzerland':'CH',
  'Türkiye':'TR','Turkey':'TR','Ukraine':'UA','United Kingdom':'GB','Wales':'GB-WLS','Vatican':'VA',
  // Americas
  'Anguilla':'AI','Antigua and Barbuda':'AG','Argentina':'AR','Aruba':'AW','Bahamas':'BS',
  'Barbados':'BB','Belize':'BZ','Bermuda':'BM','Bolivia':'BO','Bonaire':'BQ','Brazil':'BR',
  'British Virgin Islands':'VG','Canada':'CA','Cayman Islands':'KY','Chile':'CL','Colombia':'CO',
  'Costa Rica':'CR','Cuba':'CU','Curacao':'CW','Dominica':'DM','Dominican Republic':'DO',
  'Ecuador':'EC','El Salvador':'SV','Falkland Islands':'FK','French Guiana':'GF','Grenada':'GD',
  'Guadeloupe':'GP','Guatemala':'GT','Guyana':'GY','Haiti':'HT','Honduras':'HN','Jamaica':'JM',
  'Martinique':'MQ','Mexico':'MX','Montserrat':'MS','Netherlands Antilles':'CW','Nicaragua':'NI',
  'Panama':'PA','Paraguay':'PY','Peru':'PE','Puerto Rico':'PR','Saint-Martin':'MF','Sint Maarten':'SX',
  'St. Kitts & Nevis':'KN','St. Lucia':'LC','St. Vincent & Grenadinen':'VC','Suriname':'SR',
  'Trinidad and Tobago':'TT','Turks- and Caicosinseln':'TC','United States':'US','USA':'US',
  'Uruguay':'UY','Venezuela':'VE','American Virgin Islands':'VI',
  // Africa
  'Algeria':'DZ','Angola':'AO','Benin':'BJ','Botswana':'BW','Burkina Faso':'BF','Burundi':'BI',
  'Cameroon':'CM','Cape Verde':'CV','Central African Republic':'CF','Chad':'TD','Comoros':'KM',
  'Congo':'CG',"People's republic of the Congo":'CG','DR Congo':'CD','Zaire':'CD',
  "Cote d'Ivoire":'CI','Djibouti':'DJ','Egypt':'EG','Equatorial Guinea':'GQ','Eritrea':'ER',
  'Eswatini':'SZ','Swaziland':'SZ','Ethiopia':'ET','Gabon':'GA','Ghana':'GH','Guinea':'GN',
  'Guinea-Bissau':'GW','Kenya':'KE','Lesotho':'LS','Liberia':'LR','Libya':'LY','Madagascar':'MG',
  'Malawi':'MW','Mali':'ML','Mauritania':'MR','Mauritius':'MU','Mayotte':'YT','Morocco':'MA',
  'Mozambique':'MZ','Namibia':'NA','Niger':'NE','Nigeria':'NG','Réunion':'RE','Rwanda':'RW',
  'Sao Tome and Principe':'ST','Senegal':'SN','Seychelles':'SC','Sierra Leone':'SL','Somalia':'SO',
  'South Africa':'ZA','Southern Sudan':'SS','Sudan':'SD','Tanzania':'TZ','The Gambia':'GM',
  'Togo':'TG','Tunisia':'TN','Uganda':'UG','Western Sahara':'EH','Zambia':'ZM','Zanzibar':'TZ',
  'Zimbabwe':'ZW',
  // Asia & Middle East
  'Afghanistan':'AF','Bahrain':'BH','Bangladesh':'BD','Bhutan':'BT','Brunei Darussalam':'BN',
  'Cambodia':'KH','China':'CN','Chinese Taipei':'TW','Hongkong':'HK','India':'IN','Indonesia':'ID',
  'Iran':'IR','Iraq':'IQ','Japan':'JP','Jordan':'JO','Kazakhstan':'KZ','Korea, North':'KP',
  'Korea, South':'KR','South Korea':'KR','Kuwait':'KW','Kyrgyzstan':'KG','Laos':'LA','Lebanon':'LB',
  'Macao':'MO','Malaysia':'MY','Maldives':'MV','Mongolia':'MN','Myanmar':'MM','Nepal':'NP',
  'Oman':'OM','Pakistan':'PK','Palestine':'PS','Philippines':'PH','Qatar':'QA','Saudi Arabia':'SA',
  'Singapore':'SG','Sri Lanka':'LK','Syria':'SY','Tajikistan':'TJ','Thailand':'TH','Timor-Leste':'TL',
  'Turkmenistan':'TM','United Arab Emirates':'AE','Uzbekistan':'UZ','Vietnam':'VN','Yemen':'YE',
  // Oceania
  'American Samoa':'AS','Australia':'AU','Cookinseln':'CK','Fiji':'FJ',
  'Federated States of Micronesia':'FM','Guam':'GU','Kiribati':'KI','Marshall Islands':'MH',
  'Nauru':'NR','New Caledonia':'NC','New Zealand':'NZ','Niue':'NU','Northern Mariana Islands':'MP',
  'Palau':'PW','Papua New Guinea':'PG','Samoa':'WS','Solomon Islands':'SB','Tahiti':'PF','Tonga':'TO',
  'Tuvalu':'TV','Vanuatu':'VU',
};

/**
 * Flag emoji for a country. England, Scotland and Wales use subdivision tag
 * sequences; unknown countries yield an empty string rather than tofu.
 */
export const flagEmoji = (country: string): string => {
  const code = ISO2[country];
  if (!code) return '';
  const SUB: Record<string, string> = { 'GB-ENG': 'gbeng', 'GB-SCT': 'gbsct', 'GB-WLS': 'gbwls' };
  if (SUB[code]) {
    return '\u{1F3F4}' + [...SUB[code]].map((ch) => String.fromCodePoint(0xE0000 + ch.charCodeAt(0))).join('') + '\u{E007F}';
  }
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65));
};
