import React, { useState, useEffect } from 'react';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { POSITIONS, CONTACT_ROLES, COUNTRIES, fmtDate } from 'lib/constants';
import { Modal, Field, ChipGroup, SortTh, SearchInput, FilterBar, PageHeader, ExportMenu,
         Empty, Spinner, useConfirm, PhoneDisplay, PhoneActions, RowActions, NumberInput } from 'components/ui/UI';
import { toast } from 'components/ui/UI';
import { useRole } from 'lib/roleContext';

// ====================================================================
// Club logo fetcher - layered strategy with Hebrew/abbreviation support
// 1. Hardcoded canonical aliases (covers TLV, B"S, JLM, Hebrew names)
// 2. Wikidata search (returns logo from P154 property)
// 3. TheSportsDB (sport-specific, can't return city images)
// 4. Wikipedia EN / HE with strict football-club verification
// ====================================================================

// localStorage-backed cache (persists across sessions)
// Bump key when fetcher logic changes to invalidate old negative results
const LOGO_CACHE_KEY = 'goldas_logo_cache_v8';
let _logoCache = {};
try { _logoCache = JSON.parse(localStorage.getItem(LOGO_CACHE_KEY) || '{}'); } catch {}
const NEG = '__none__';
function saveCache() {
  try { localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(_logoCache)); } catch {}
}
// Clear old cache versions on load
try {
  for (let i = 1; i < 8; i++) localStorage.removeItem(`goldas_logo_cache_v${i}`);
} catch {}

// Israeli football clubs - canonical names with common aliases.
// Maps any variant to a canonical English name we can search precisely.
const CLUB_ALIASES = {
  // Maccabi Tel Aviv
  'maccabi tlv':         'Maccabi Tel Aviv F.C.',
  'maccabi t.a':         'Maccabi Tel Aviv F.C.',
  'maccabi ta':          'Maccabi Tel Aviv F.C.',
  'maccabi tel-aviv':    'Maccabi Tel Aviv F.C.',
  'maccabi tel aviv':    'Maccabi Tel Aviv F.C.',
  'מכבי תל אביב':         'Maccabi Tel Aviv F.C.',
  'מכבי תא':              'Maccabi Tel Aviv F.C.',
  // Hapoel Tel Aviv
  'hapoel tlv':          'Hapoel Tel Aviv F.C.',
  'hapoel t.a':          'Hapoel Tel Aviv F.C.',
  'hapoel ta':           'Hapoel Tel Aviv F.C.',
  'hapoel tel-aviv':     'Hapoel Tel Aviv F.C.',
  'hapoel tel aviv':     'Hapoel Tel Aviv F.C.',
  'הפועל תל אביב':         'Hapoel Tel Aviv F.C.',
  'הפועל תא':              'Hapoel Tel Aviv F.C.',
  // Maccabi Haifa
  'maccabi haifa':       'Maccabi Haifa F.C.',
  'מכבי חיפה':            'Maccabi Haifa F.C.',
  // Hapoel Haifa
  'hapoel haifa':        'Hapoel Haifa F.C.',
  'הפועל חיפה':           'Hapoel Haifa F.C.',
  // Beitar Jerusalem
  'beitar jerusalem':    'Beitar Jerusalem F.C.',
  'beitar jlm':          'Beitar Jerusalem F.C.',
  'betar jerusalem':     'Beitar Jerusalem F.C.',
  'betar jlm':           'Beitar Jerusalem F.C.',
  'beitar yerushalayim': 'Beitar Jerusalem F.C.',
  'ביתר ירושלים':         'Beitar Jerusalem F.C.',
  // Hapoel Beer Sheva
  'hapoel beer sheva':   "Hapoel Be'er Sheva F.C.",
  "hapoel be'er sheva":  "Hapoel Be'er Sheva F.C.",
  'hapoel beersheva':    "Hapoel Be'er Sheva F.C.",
  'hapoel bs':           "Hapoel Be'er Sheva F.C.",
  'hapoel b"s':          "Hapoel Be'er Sheva F.C.",
  'הפועל באר שבע':         "Hapoel Be'er Sheva F.C.",
  'הפועל ב"ש':            "Hapoel Be'er Sheva F.C.",
  // Maccabi Netanya
  'maccabi netanya':     'Maccabi Netanya F.C.',
  'מכבי נתניה':           'Maccabi Netanya F.C.',
  // Maccabi Petah Tikva
  'maccabi petah tikva': 'Maccabi Petah Tikva F.C.',
  'maccabi pt':          'Maccabi Petah Tikva F.C.',
  'maccabi petah tikvah':'Maccabi Petah Tikva F.C.',
  'מכבי פתח תקווה':        'Maccabi Petah Tikva F.C.',
  'מכבי פ"ת':             'Maccabi Petah Tikva F.C.',
  // Hapoel Petah Tikva
  'hapoel petah tikva':  'Hapoel Petah Tikva F.C.',
  'hapoel pt':           'Hapoel Petah Tikva F.C.',
  'הפועל פתח תקווה':       'Hapoel Petah Tikva F.C.',
  'הפועל פ"ת':            'Hapoel Petah Tikva F.C.',
  // Bnei Sakhnin
  'bnei sakhnin':        'Bnei Sakhnin F.C.',
  'sakhnin':             'Bnei Sakhnin F.C.',
  'בני סכנין':            'Bnei Sakhnin F.C.',
  // Hapoel Hadera
  'hapoel hadera':       'Hapoel Hadera F.C.',
  'הפועל חדרה':           'Hapoel Hadera F.C.',
  // Hapoel Jerusalem
  'hapoel jerusalem':    'Hapoel Jerusalem F.C.',
  'hapoel jlm':          'Hapoel Jerusalem F.C.',
  'הפועל ירושלים':        'Hapoel Jerusalem F.C.',
  // Bnei Yehuda
  'bnei yehuda':         'Bnei Yehuda Tel Aviv F.C.',
  'bnei yehuda tlv':     'Bnei Yehuda Tel Aviv F.C.',
  'בני יהודה':           'Bnei Yehuda Tel Aviv F.C.',
  'בני יהודה תל אביב':    'Bnei Yehuda Tel Aviv F.C.',  // plain "בני יהודה" is a disambig page; logo is here
  // F.C. Ashdod  (do NOT alias the bare city name "אשדוד" — it pulls a city image)
  'ashdod':              'F.C. Ashdod',
  'fc ashdod':           'F.C. Ashdod',
  // Hapoel Kfar Saba
  'hapoel kfar saba':    'Hapoel Kfar Saba F.C.',
  'הפועל כפר סבא':         'Hapoel Kfar Saba F.C.',
  // Hapoel Ramat Gan
  'hapoel ramat gan':    'Hapoel Ramat Gan F.C.',
  'הפועל רמת גן':          'Hapoel Ramat Gan F.C.',
  // Hapoel Nof HaGalil (Nazareth Illit)
  'hapoel nof hagalil':  'Hapoel Nof HaGalil F.C.',
  'הפועל נוף הגליל':       'Hapoel Nof HaGalil F.C.',
  // Maccabi Bnei Reineh
  'maccabi bnei reineh': 'Maccabi Bnei Reineh F.C.',
  'מכבי בני ריינה':        'Maccabi Bnei Reineh F.C.',
  // Hapoel Kfar Shalem
  'hapoel kfar shalem':  'Hapoel Kfar Shalem F.C.',
  'kfar shalem':         'Hapoel Kfar Shalem F.C.',
  'הפועל כפר שלם':         'Hapoel Kfar Shalem F.C.',
  'כפר שלם':              'Hapoel Kfar Shalem F.C.',
  // Hapoel Tel Aviv U-19 & similar — handled by stripping suffixes below
  // More Liga Leumit / Liga Alef teams
  'hapoel ramat hasharon': 'Hapoel Ramat HaSharon F.C.',
  'הפועל רמת השרון':       'Hapoel Ramat HaSharon F.C.',
  'hapoel raanana':      "Hapoel Ra'anana A.F.C.",
  "hapoel ra'anana":     "Hapoel Ra'anana A.F.C.",
  'הפועל רעננה':           "Hapoel Ra'anana A.F.C.",
  'hapoel rishon':       'Hapoel Rishon LeZion F.C.',
  'hapoel rishon lezion':'Hapoel Rishon LeZion F.C.',
  'הפועל ראשון לציון':      'Hapoel Rishon LeZion F.C.',
  'hapoel afula':        'Hapoel Afula F.C.',
  'הפועל עפולה':           'Hapoel Afula F.C.',
  'hapoel umm al-fahm':  'Hapoel Umm al-Fahm F.C.',
  'הפועל אום אל פחם':       'Hapoel Umm al-Fahm F.C.',
  'hapoel acre':         'Hapoel Acre F.C.',
  'hapoel akko':         'Hapoel Acre F.C.',
  'הפועל עכו':             'Hapoel Acre F.C.',
  'hapoel katamon':      'Hapoel Katamon Jerusalem F.C.',
  'הפועל קטמון':           'Hapoel Katamon Jerusalem F.C.',
  'hapoel marmorek':     'Hapoel Marmorek F.C.',
  'הפועל מרמורק':          'Hapoel Marmorek F.C.',
  'maccabi herzliya':    'Maccabi Herzliya F.C.',
  'מכבי הרצליה':           'Maccabi Herzliya F.C.',
  'maccabi yavne':       'Maccabi Yavne F.C.',
  'מכבי יבנה':            'Maccabi Yavne F.C.',
  'maccabi kabilio jaffa': 'Maccabi Kabilio Jaffa F.C.',
  'מכבי קבליו יפו':         'Maccabi Kabilio Jaffa F.C.',
  'ms kafr qasim':       'Maccabi Sektzia Kafr Qasim F.C.',
  'ms kfar qasim':       'Maccabi Sektzia Kafr Qasim F.C.',
  'מ.ס כפר קאסם':          'Maccabi Sektzia Kafr Qasim F.C.',
  'ironi tiberias':      'Ironi Tiberias F.C.',
  'עירוני טבריה':          'Ironi Tiberias F.C.',
  'ironi kiryat shmona': 'Hapoel Ironi Kiryat Shmona F.C.',
  'hapoel ironi kiryat shmona': 'Hapoel Ironi Kiryat Shmona F.C.',
  'kiryat shmona':       'Hapoel Ironi Kiryat Shmona F.C.',
  'עירוני קרית שמונה':      'Hapoel Ironi Kiryat Shmona F.C.',
  // Clubs sharing a name with their city — map to the club + its Hebrew page (which holds the logo)
  'sc ashdod':           'F.C. Ashdod',
  'מ.ס. אשדוד':           'F.C. Ashdod',
  'מועדון ספורט אשדוד':    'F.C. Ashdod',
  'hod hasharon':        'Hapoel Hod HaSharon F.C.',
  'hapoel hod hasharon': 'Hapoel Hod HaSharon F.C.',
  'הפועל הוד השרון':       'Hapoel Hod HaSharon F.C.',
  'ness ziona':          'Sektzia Ness Ziona F.C.',
  'sektzia ness ziona':  'Sektzia Ness Ziona F.C.',
  'סקציה נס ציונה':        'Sektzia Ness Ziona F.C.',
  // Kiryat Gat — the active men's club is Maccabi Ironi Kiryat Gat. (Do NOT map
  // to the city "קריית גת", whose page yields the municipality logo.)
  'kiryat gat':              'Maccabi Ironi Kiryat Gat F.C.',
  'hapoel kiryat gat':       'Maccabi Ironi Kiryat Gat F.C.',
  'maccabi ironi kiryat gat':'Maccabi Ironi Kiryat Gat F.C.',
  'מכבי עירוני קריית גת':      'Maccabi Ironi Kiryat Gat F.C.',
  'מכבי עירוני קריית גת (כדורגל)': 'Maccabi Ironi Kiryat Gat F.C.',
  // ── Clubs verified against he.wikipedia (exact infobox-logo page titles) ──
  // Maccabi Be'er Sheva  → מכבי באר שבע (MaccabiBeerShevaCrest2018.png)
  'maccabi beer sheva':  'Maccabi Be\'er Sheva F.C.',
  "maccabi be'er sheva": 'Maccabi Be\'er Sheva F.C.',
  'מכבי באר שבע':         'Maccabi Be\'er Sheva F.C.',
  // Ironi / Maccabi Kiryat Ata Bialik → עירוני קרית אתא (Maccabi_Kiryat_Ata_logo.png)
  'ironi kiryat ata':         'Ironi Kiryat Ata Bialik F.C.',
  'ironi kiryat ata bialik':  'Ironi Kiryat Ata Bialik F.C.',
  'maccabi kiryat ata':       'Ironi Kiryat Ata Bialik F.C.',
  'עירוני קרית אתא':           'Ironi Kiryat Ata Bialik F.C.',
  'מכבי קרית אתא':             'Ironi Kiryat Ata Bialik F.C.',
  // Hapoel Herzliya → הפועל הרצליה (Hapoel_herzlya.gif)
  'hapoel herzliya':     'Hapoel Herzliya F.C.',
  'הפועל הרצליה':         'Hapoel Herzliya F.C.',
  // Ironi Modi'in → עירוני מודיעין (IroniModiinFC.png)
  'ironi modiin':        'Ironi Modi\'in F.C.',
  "ironi modi'in":       'Ironi Modi\'in F.C.',
  'עירוני מודיעין':        'Ironi Modi\'in F.C.',
  // Ironi Nesher → עירוני נשר (Iron_Nesher_FC_New_Logo.png)
  'ironi nesher':        'Ironi Nesher F.C.',
  'עירוני נשר':           'Ironi Nesher F.C.',
  // Hakoah Amidar Ramat Gan → הכוח רמת גן (Hakoach_Ramat_Gan.png)
  'hakoach ramat gan':   'Hakoah Amidar Ramat Gan F.C.',
  'hakoah ramat gan':    'Hakoah Amidar Ramat Gan F.C.',
  'הכוח רמת גן':          'Hakoah Amidar Ramat Gan F.C.',
  'הכוח עמידר רמת גן':     'Hakoah Amidar Ramat Gan F.C.',
  // Kafr Qasim — exact HE title needs the period: מ.ס. כפר קאסם (FC_Kafr_Qasim_Logo.png)
  'kfar qasim':          'Maccabi Sektzia Kafr Qasim F.C.',
  'kafr qasim':          'Maccabi Sektzia Kafr Qasim F.C.',
  'מ.ס. כפר קאסם':         'Maccabi Sektzia Kafr Qasim F.C.',
  // Rishon Lezion (when stored without "Hapoel") → הפועל ראשון לציון (כדורגל) (Hap-rish.png)
  'rishon lezion':       'Hapoel Rishon LeZion F.C.',
  'rishon le zion':      'Hapoel Rishon LeZion F.C.',
  // SC Ashdod exact HE title (period): מ.ס. אשדוד (Ashdod.png)
  'מ.ס. אשדוד':           'F.C. Ashdod',
  // Shimshon Tel Aviv → שמשון תל אביב (Shimsho_Tel_Aviv.png — transparent crest)
  'shimshon tel aviv':   'Shimshon Tel Aviv F.C.',
  'shimshon tlv':        'Shimshon Tel Aviv F.C.',
  'שמשון תל אביב':        'Shimshon Tel Aviv F.C.',
  // Gadna Tel Aviv Yehuda — official crest exists ONLY on the Hebrew article
  'gadna tel aviv yehuda':'Gadna Tel Aviv Yehuda F.C.',
  'gadna tlv yehuda':    'Gadna Tel Aviv Yehuda F.C.',
  'גדנ"ע תל אביב יהודה':   'Gadna Tel Aviv Yehuda F.C.',
  // Beitar Nordia (Jerusalem) → בית"ר נורדיה ירושלים (Betar_Nordia_Jerusalem.png)
  'beitar nordia':       'Beitar Nordia Jerusalem F.C.',
  'betar nordia':        'Beitar Nordia Jerusalem F.C.',
  'בית"ר נורדיה ירושלים':  'Beitar Nordia Jerusalem F.C.',
  // Kiryat Yam → מועדון ספורט קריית ים (SC_Kiryat_Yam_Crest.png)
  'kiryat yam':          'F.C. Kiryat Yam',
  'מועדון ספורט קריית ים': 'F.C. Kiryat Yam',
};

// Expand common abbreviations and Hebrew→English markers
function expandAbbreviations(s) {
  let out = ' ' + s + ' ';
  const map = {
    '\\bTLV\\b':         'Tel Aviv',
    '\\bT\\.A\\.?\\b':   'Tel Aviv',
    '\\bTA\\b':          'Tel Aviv',
    '\\bJLM\\b':         'Jerusalem',
    '\\bJ\\.M\\.?\\b':   'Jerusalem',
    '\\bB"S\\b':         "Be'er Sheva",
    '\\bBS\\b':          "Be'er Sheva",
    '\\bB\\.S\\.?\\b':   "Be'er Sheva",
    '\\bPT\\b':          'Petah Tikva',
    '\\bP"T\\b':         'Petah Tikva',
    '\\bP\\.T\\.?\\b':   'Petah Tikva',
    '\\bKS\\b':          'Kfar Saba',
    '\\bRG\\b':          'Ramat Gan',
    '\\bRA\\b':          'Ra\'anana',
    '\\bH\\b\\.?':       'Hapoel',  // when alone
    '\\bM\\b\\.?':       'Maccabi', // when alone
  };
  for (const [pat, rep] of Object.entries(map)) {
    out = out.replace(new RegExp(pat, 'gi'), rep);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Strip "U19", "Youth", "Reserves", "B" suffixes for cleaner search
function stripSuffixes(s) {
  return s.replace(/\b(u\s*-?\s*\d{1,2}|under\s*\d{1,2}|youth|reserves?|academy|b\s*team)\b/gi, '').trim();
}

function normalizeKey(s) {
  return (s || '').trim().toLowerCase()
    .replace(/[".']/g, '')
    .replace(/\s+/g, ' ');
}

// Resolve a user-supplied club name to its canonical form (if known)
function canonicalName(name) {
  if (!name) return name;
  const raw = stripSuffixes(name.trim());
  const expanded = expandAbbreviations(raw);
  const variants = [raw, expanded, raw.toLowerCase(), expanded.toLowerCase()];
  for (const v of variants) {
    const k = normalizeKey(v);
    if (CLUB_ALIASES[k]) return CLUB_ALIASES[k];
    // try partial match (Hebrew or English)
    for (const aliasKey of Object.keys(CLUB_ALIASES)) {
      if (k && (k.includes(aliasKey) || aliasKey.includes(k)) && Math.min(k.length, aliasKey.length) >= 4) {
        return CLUB_ALIASES[aliasKey];
      }
    }
  }
  return expanded; // returns the abbreviation-expanded form for downstream search
}

// === Source 1: TheSportsDB ============================================
// Guard: only accept result if returned team name shares a meaningful token with our query.
// Prevents "Arsenal" being returned for "Hapoel Rishon LeZion" etc.
async function trySportsDB(name) {
  try {
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(name)}`);
    if (!r.ok) return null;
    const d = await r.json();
    const soccer = (d?.teams || []).filter(t => ['soccer', 'football'].includes((t.strSport || '').toLowerCase()));
    if (!soccer.length) return null;
    // Token overlap guard
    const STOP = new Set(['fc','f.c.','sc','ac','cf','club','football','soccer','the','of','la','le','de']);
    const tokensOf = (s) => (s || '').toLowerCase().replace(/[^a-z0-9֐-׿ ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t));
    const qTokens = new Set(tokensOf(name));
    if (qTokens.size === 0) return soccer[0]?.strTeamBadge || null;
    for (const t of soccer) {
      const teamTokens = new Set(tokensOf(t.strTeam));
      // require at least one shared meaningful token
      for (const tk of qTokens) {
        if (teamTokens.has(tk)) return t.strTeamBadge || null;
      }
    }
    return null;
  } catch {}
  return null;
}

// === Source 2: Country-language Wikipedia article (via Wikidata sitelinks) ===
// Resolve the club's Wikidata entity, then pull the crest from the article in
// the club's OWN country language (Israeli club → Hebrew article, Spanish club →
// Spanish, …), falling back to the English article, and finally to Wikidata's
// own logo (P154). This is the general rule; the explicit aliases above take
// precedence and run first.
const COUNTRY_LANG = {
  Q801:'he', Q29:'es', Q21:'en', Q145:'en', Q142:'fr', Q183:'de', Q38:'it',
  Q45:'pt', Q55:'nl', Q31:'nl', Q414:'es', Q155:'pt', Q96:'es', Q40:'de',
  Q39:'de', Q41:'el', Q43:'tr', Q213:'cs', Q36:'pl', Q34:'sv', Q20:'no',
};

// Find the Wikidata entity ID of the football CLUB named `name` (not a stadium,
// league or season). Searches Hebrew first, then English.
async function findFootballEntity(name) {
  for (const lang of ['he', 'en']) {
    const r = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=${lang}&uselang=${lang}&format=json&origin=*&type=item&limit=8`
    );
    if (!r.ok) throw new Error('wikidata search http ' + r.status);
    const d = await r.json();
    const cand = (d.search || []).find(e => {
      const desc = (e.description || '').toLowerCase();
      return /football|soccer|כדורגל|fútbol|calcio|futebol/.test(desc) &&
             !/stadium|אצטדיון|arena|league|ליגה|season|עונת/.test(desc);
    });
    if (cand) return cand.id;
  }
  return null;
}

async function tryCountryLangArticle(name) {
  const id = await findFootballEntity(name);
  if (!id) return null;
  const er = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`);
  if (!er.ok) throw new Error('wikidata entity http ' + er.status);
  const ed = await er.json();
  const ent = ed?.entities?.[id];
  if (!ent) return null;
  const sl = ent.sitelinks || {};
  const country = ent.claims?.P17?.[0]?.mainsnak?.datavalue?.value?.id;
  const lang = COUNTRY_LANG[country] || 'he';
  // Prefer the country-language article, then English.
  for (const l of Array.from(new Set([lang, 'en']))) {
    const title = sl[l + 'wiki']?.title;
    if (title) {
      const img = await tryWikipediaPageImage(title, l);
      if (img) return img;
    }
  }
  // Last resort: Wikidata's own logo property (P154).
  const logoClaim = ent.claims?.P154?.[0]?.mainsnak?.datavalue?.value;
  if (logoClaim) {
    return `https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/${encodeURIComponent(logoClaim)}&width=200`;
  }
  return null;
}

// === Source 3: Wikipedia REST summary - returns thumbnail if present
async function tryWikipediaSummary(slug, lang = 'en') {
  const r = await fetch(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug.replace(/ /g, '_'))}`,
    { headers: { Accept: 'application/json' } }
  );
  if (r.status === 404) return null;          // page genuinely missing
  if (!r.ok) throw new Error('wiki summary http ' + r.status);
  const d = await r.json();
  if (d?.type === 'disambiguation') return null;
  const text = ((d.description || '') + ' ' + (d.extract || '')).toLowerCase();
  const isClub = text.includes('football club') || text.includes('soccer club') ||
                 text.includes('association football') || text.includes('f.c.') ||
                 text.includes('sports club') || text.includes('כדורגל');
  if (!isClub) return null;
  return d?.originalimage?.source || d?.thumbnail?.source || null;
}

// === Source 4: Wikipedia pageimages API - infobox image (more reliable for logos)
async function tryWikipediaPageImage(title, lang = 'en') {
  const r = await fetch(
    `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages|pageprops|extracts&piprop=original|thumbnail&pithumbsize=300&exintro=1&explaintext=1&exchars=600&format=json&origin=*&redirects=1`,
    { headers: { Accept: 'application/json' } }
  );
  if (!r.ok) throw new Error('wiki pageimage http ' + r.status);
  const d = await r.json();
  const pages = d?.query?.pages || {};
  for (const pid of Object.keys(pages)) {
    if (pid === '-1') continue;
    const p = pages[pid];
    if (p?.pageprops?.disambiguation !== undefined) continue;
    const img = p?.original?.source || p?.thumbnail?.source;
    if (!img) continue;
    // Accept when EITHER (a) the image itself looks like a crest/logo, OR
    // (b) the page intro verifies it's a football club. This avoids rejecting
    // valid crests when "football" appears later than the short intro extract,
    // while still rejecting cities (whose pageimage is a .jpg photo and whose
    // intro never mentions football).
    const fname = decodeURIComponent(img).toLowerCase();
    const looksLikeLogo = /logo|crest|badge|emblem|\.svg(\?|$)/.test(fname);
    const text = ((p.title || '') + ' ' + (p.extract || '')).toLowerCase();
    const isFootball = /football|soccer|association football|f\.c\.|sports club|כדורגל|מועדון ספורט/.test(text);
    if (looksLikeLogo || isFootball) return img;
  }
  return null;
}

// Build reverse map: canonical English name -> list of Hebrew aliases
const HEBREW_FOR_CANONICAL = (() => {
  const m = {};
  for (const [k, v] of Object.entries(CLUB_ALIASES)) {
    if (/[֐-׿]/.test(k)) {
      if (!m[v]) m[v] = [];
      m[v].push(k);
    }
  }
  return m;
})();

// Concurrency limiter + in-flight dedup, so rendering many logos at once
// doesn't blast the Wikipedia/Wikidata APIs (which previously rate-limited
// and poisoned the cache with false "not found" results).
let _active = 0;
const _queue = [];
function _runNext() {
  if (_active >= 3 || !_queue.length) return;
  _active++;
  const { fn, resolve, reject } = _queue.shift();
  Promise.resolve().then(fn).then(resolve, reject).finally(() => { _active--; _runNext(); });
}
function _limit(fn) {
  return new Promise((resolve, reject) => { _queue.push({ fn, resolve, reject }); _runNext(); });
}
const _inflight = {};

async function fetchClubLogo(name) {
  const cacheKey = normalizeKey(name);
  if (!cacheKey || cacheKey.length < 2) return null;
  if (cacheKey in _logoCache) {
    const v = _logoCache[cacheKey];
    return v === NEG ? null : v;
  }
  if (_inflight[cacheKey]) return _inflight[cacheKey];
  const p = _limit(() => _doFetchClubLogo(name, cacheKey)).finally(() => { delete _inflight[cacheKey]; });
  _inflight[cacheKey] = p;
  return p;
}

async function _doFetchClubLogo(name, cacheKey) {
  const canonical = canonicalName(name);
  const base      = canonical;

  // English query variants
  const enVariants = Array.from(new Set([
    base,
    base.replace(/\s*F\.?C\.?$/i, '').trim(),
    base + ' FC',
    'FC ' + base,
    'Bnei ' + base,
    'Hapoel ' + base,
    'Maccabi ' + base,
    'Beitar ' + base,
    'Ironi ' + base,
  ].filter(v => v && v.length > 1)));

  // Hebrew variants — pulled from alias dict using canonical, plus the raw input if Hebrew
  // Also add "(כדורגל)" disambiguation suffix for clubs that share a name with other entities
  const baseHe = Array.from(new Set([
    ...(HEBREW_FOR_CANONICAL[canonical] || []),
    ...(/[֐-׿]/.test(name) ? [name.trim()] : []),
  ].filter(Boolean)));
  // Try the "(כדורגל)" (football) disambiguated page FIRST — multi-sport clubs
  // like Maccabi Tel Aviv/Haifa have an umbrella page (generic symbol) at the
  // plain name, but the current football crest lives on the "(כדורגל)" page.
  const heVariants = Array.from(new Set([
    ...baseHe.map(h => `${h} (כדורגל)`),
    ...baseHe,
  ]));

  const store = (url) => {
    _logoCache[cacheKey] = url || NEG;
    saveCache();
    return url;
  };

  // Run a lookup layer safely: a thrown error means a transient network/HTTP
  // failure (e.g. rate-limit), NOT a definitive "no logo". We record that so
  // we can avoid caching a false negative below.
  let hadError = false;
  const layer = async (fn) => {
    try { return await fn(); }
    catch { hadError = true; return null; }
  };

  // Layer 1: Wikipedia HE pageimages — verified most accurate for Israeli
  // clubs; tries the "(כדורגל)" disambiguated page first for the current crest.
  for (const v of heVariants) {
    const url = await layer(() => tryWikipediaPageImage(v, 'he'));
    if (url) return store(url);
  }

  // Layer 2: Country-language Wikipedia article (general language-aware rule —
  // Israeli club → Hebrew article, foreign club → its own language, else EN).
  for (const v of Array.from(new Set([name.trim(), base].filter(Boolean)))) {
    const url = await layer(() => tryCountryLangArticle(v));
    if (url) return store(url);
  }

  // Layer 3: Wikipedia HE summary
  for (const v of heVariants) {
    const url = await layer(() => tryWikipediaSummary(v, 'he'));
    if (url) return store(url);
  }

  // Layer 4: Wikipedia EN via pageimages — infobox image
  for (const v of enVariants) {
    const url = await layer(() => tryWikipediaPageImage(v, 'en'));
    if (url) return store(url);
  }
  for (const v of enVariants) {
    const url = await layer(() => tryWikipediaPageImage(v + ' F.C.', 'en'));
    if (url) return store(url);
  }

  // Layer 5: TheSportsDB (fallback — swallows its own network errors)
  for (const v of enVariants) {
    const url = await trySportsDB(v);
    if (url) return store(url);
  }

  // Layer 6: Wikipedia summary (last resort, only if it has a thumbnail)
  for (const v of enVariants) {
    const url = await layer(() => tryWikipediaSummary(v + ' F.C.', 'en'));
    if (url) return store(url);
    const url2 = await layer(() => tryWikipediaSummary(v, 'en'));
    if (url2) return store(url2);
  }

  // Nothing found. Only cache the negative when the lookup completed cleanly.
  // If a transient error occurred, leave it uncached so it retries on the next
  // render — this is what prevents a render-time request storm from poisoning
  // the cache with permanent false "no logo" results.
  if (hadError) return null;
  return store(null);
}

export function ClubLogoOrAvatar({ name, size = 28 }) {
  const [url, setUrl] = useState(() => {
    const k = (name || '').trim().toLowerCase();
    return k in _logoCache ? _logoCache[k] : undefined;
  });

  useEffect(() => {
    if (!name || name.trim().length < 2) { setUrl(null); return; }
    const k = name.trim().toLowerCase();
    if (k in _logoCache) { setUrl(_logoCache[k]); return; }
    fetchClubLogo(name).then(logo => setUrl(logo));
  }, [name]);

  if (url) {
    return (
      <img src={url} alt={name} title={name}
        style={{ width: size, height: size, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }}
        onError={() => setUrl(null)} />
    );
  }

  // Initials avatar fallback
  const words    = (name || '?').trim().split(/\s+/);
  const initials = words.length >= 2
    ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
    : (name || '?').slice(0, 2).toUpperCase();
  const hue = (name || '').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xFFFF, 0) % 360;
  return (
    <div style={{
      width: size, height: size, borderRadius: 6, flexShrink: 0,
      background: `hsl(${hue},45%,22%)`, border: `1px solid hsl(${hue},50%,35%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size <= 28 ? 9 : 11, fontWeight: 800,
      color: `hsl(${hue},70%,80%)`, letterSpacing: '0.04em', userSelect: 'none',
    }}>{initials}</div>
  );
}

// ── Youth U19 badge ──────────────────────────────────────────────
export const U19 = () => (
  <span style={{
    background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.3)',
    borderRadius: 4, color: '#4ADE80', fontSize: 9, fontWeight: 700,
    padding: '1px 5px', letterSpacing: '0.04em', whiteSpace: 'nowrap', flexShrink: 0,
  }}>U19</span>
);

// ── Requirement view card ────────────────────────────────────────
function RequirementView({ req, onClose }) {
  const Row = ({ label, value }) => value && value !== '—' ? (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <div className="view-row-label" style={{ width: 160, flexShrink: 0, color: 'var(--text-3)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ color: 'var(--text-1)', fontSize: 13 }}>{value}</div>
    </div>
  ) : null;

  const feeDisplay = req.transferFee && req.transferFee !== 'Not specified'
    ? `€${Number(req.transferFee).toLocaleString()}` : (req.transferFee || '—');
  const salDisplay = req.salary && req.salary !== 'Not specified'
    ? `€${Number(req.salary).toLocaleString()}/mo` : (req.salary || '—');
  const ageDisplay = req.ageNotSpecified ? 'Not specified'
    : (req.ageMin && req.ageMax ? `${req.ageMin}–${req.ageMax}` : req.ageMin || req.ageMax || '—');

  return (
    <Modal title={req.clubName} onClose={onClose} wide viewOnly>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <ClubLogoOrAvatar name={req.clubName} size={48} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--text-1)' }}>{req.clubName}</span>
            {req.clubIsYouth && <span style={{ background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: 4, color: '#4ADE80', fontSize: 10, fontWeight: 700, padding: '2px 7px' }}>Youth Team 🌱</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
            {req.league || 'League not set'}
            {req.clubIsYouth && <U19 />}
            {req.tablePosition ? ` · #${req.tablePosition} in table` : ''}
          </div>
        </div>
        {req.gender && <span className="badge" style={{ background: 'var(--surface-3)', color: 'var(--text-2)' }}>{req.gender}</span>}
      </div>

      <div className="view-grid-2">
        <div>
          <div className="form-section-title">Club</div>
          <Row label="League"     value={req.league} />
          <Row label="Table Pos." value={req.tablePosition ? `#${req.tablePosition}` : null} />

          <div className="form-section-title" style={{ marginTop: 16 }}>Contact</div>
          <Row label="Name" value={req.contactName} />
          <Row label="Role" value={req.contactRole} />
          {req.contactPhone && (
            <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="view-row-label" style={{ width: 160, flexShrink: 0, color: 'var(--text-3)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Phone</div>
              <PhoneDisplay phone={req.contactPhone} />
            </div>
          )}
        </div>
        <div>
          <div className="form-section-title">Profile Needed</div>
          <Row label="Position"     value={req.requiredPosition} />
          <Row label="Age Range"    value={ageDisplay} />
          <Row label="Max Transfer" value={feeDisplay} />
          <Row label="Max Salary"   value={salDisplay} />
        </div>
      </div>

      {req.notes && (
        <div style={{ marginTop: 16 }}>
          <div className="form-section-title">Notes</div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>{req.notes}</p>
        </div>
      )}
      {req.lastEditedByName && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-3)' }}>Last edited by {req.lastEditedByName}</div>
      )}
    </Modal>
  );
}

const EMPTY = {
  gender: '', leagueMode: 'select', leagueCountry: '', leagueTier: '', leagueManual: '',
  clubName: '', clubIsYouth: false, tablePosition: '', contactName: '', contactRole: '',
  contactPhone: '', requiredPosition: '', ageMin: '', ageMax: '', ageNotSpecified: false,
  transferFee: '', salary: '', notes: '',
};

async function clearAll_clubrequirements() {
  if (!window.confirm('Delete ALL requirements? This cannot be undone.')) return;
  const snap = await getDocs(collection(db, 'club_requirements'));
  for (const d of snap.docs) await deleteDoc(d.ref);
  window.location.reload();
}

export default function Requirements() {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(null);
  const [viewReq, setViewReq] = useState(null);
  const [form, setForm]       = useState(EMPTY);
  const [saving, setSaving]   = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [search, setSearch]   = useState('');
  const [filters, setFilters] = useState({});
  const [sort, setSort]       = useState({ field: 'clubName', dir: 'asc' });
  const { confirm, dialog }   = useConfirm();
  const { canEdit }           = useRole();

  useEffect(() => {
    return listenCollection(PATHS.CLUB_REQUIREMENTS, data => {
      setItems(data); setLoading(false);
    }, 'clubName');
  }, []);

  const s = k => v => { setForm(p => ({ ...p, [k]: v })); setIsDirty(true); };
  const f = k => form[k] ?? '';

  const league = form.leagueMode === 'manual' ? form.leagueManual
    : (form.leagueCountry && form.leagueTier
        ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ', '')}`
        : '');

  const openAdd  = () => { setForm({ ...EMPTY }); setModal('add'); setIsDirty(false); };
  const openEdit = p  => { setForm({ ...EMPTY, ...p }); setModal({ edit: p }); setIsDirty(false); };
  const openDup  = p  => { const { id: _, ...rest } = p; setForm({ ...EMPTY, ...rest }); setModal('add'); setIsDirty(false); };

  const validate = () => {
    if (!form.clubName.trim()) return 'Club name is required.';
    if (!form.gender)          return 'Gender is required.';
    const existing = items.filter(p => modal?.edit?.id !== p.id);
    // Only block when EVERY detail is identical to an existing requirement.
    // Similar requirements (same club/position but any other difference) are allowed.
    const norm = v => {
      if (v === undefined || v === null) return '';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return String(v).trim().toLowerCase();
    };
    const FIELDS = Object.keys(EMPTY);
    const allIdentical = p => FIELDS.every(k => norm(p[k]) === norm(form[k]));
    if (existing.some(allIdentical))
      return 'An identical requirement already exists (every detail matches). Change at least one detail.';
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const data = { ...form, league };
      if (modal === 'add') {
        await addDoc_(PATHS.CLUB_REQUIREMENTS, data);
        toast.success(`Requirement for "${form.clubName}" added!`);
      } else {
        await updateDoc_(PATHS.CLUB_REQUIREMENTS, modal.edit.id, data);
        toast.success('Updated.');
      }
      setModal(null);
    } catch (e) {
      toast.error(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const del = async p => {
    const ok = await confirm(`Delete requirement for "${p.clubName}"?`);
    if (!ok) return;
    await deleteDoc_(PATHS.CLUB_REQUIREMENTS, p.id);
    toast.success('Deleted.');
  };

  let data = items.filter(p => {
    if (search && !`${p.clubName} ${p.contactName} ${p.league}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filters.gender   && p.gender           !== filters.gender)   return false;
    if (filters.position && p.requiredPosition !== filters.position) return false;
    return true;
  });
  data = data.sort((a, b) => {
    const av = a[sort.field] || '', bv = b[sort.field] || '';
    return sort.dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });

  return (
    <div className="page-table">
      <PageHeader
        title="Club Requirements"
        subtitle={`${items.length} active requirement${items.length !== 1 ? 's' : ''}`}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {canEdit && <button className="btn btn-primary" onClick={openAdd} style={{ height: 36 }}>+ Add Requirement</button>}
            <ExportMenu
              filename="Club Requirements"
              title="Club Requirements"
              subtitle={[
                search && `search: "${search}"`,
                filters.gender && `gender: ${filters.gender}`,
                filters.position && `position: ${filters.position}`,
              ].filter(Boolean).join('  ·  ')}
              columns={[
                { key: 'gender',           label: 'G',     pdfLabel: 'G' },
                { key: 'clubName',         label: '🔰',   pdfLabel: 'Club',
                  format: (v, r) => v ? `${v}${r.league ? `  ·  ${r.league}` : ''}` : '' },
                { key: 'jersey',           label: '#',     pdfLabel: '#' },
                { key: 'contactName',      label: '👤',   pdfLabel: 'Contact' },
                { key: 'requiredPosition', label: '📍',   pdfLabel: 'Position' },
                { key: 'deadline',         label: '🗓️',   pdfLabel: 'Deadline' },
                { key: 'transferFee',      label: '💰',   pdfLabel: 'Fee' },
                { key: 'salary',           label: '💵',   pdfLabel: 'Salary' },
                { key: 'contactRole',      label: 'Role',  pdfLabel: 'Role' },
                { key: 'contactPhone',     label: '📞',   pdfLabel: 'Phone' },
                { key: 'notes',            label: 'Notes', pdfLabel: 'Notes' },
              ]}
              rows={data}
            />
            <div style={{ height: 36, display: 'flex', alignItems: 'center' }}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search..." />
            </div>
            {canEdit && <button className="btn btn-danger btn-sm" onClick={clearAll_clubrequirements}
              style={{ height: 36, opacity: 0.45, whiteSpace: 'nowrap' }} title="Clear all"
              onMouseEnter={e => e.currentTarget.style.opacity = '1'}
              onMouseLeave={e => e.currentTarget.style.opacity = '0.45'}>
              🗑 Clear All
            </button>}
          </div>
        }
      >
        <div style={{ marginTop: 14 }}>
          <FilterBar filters={filters} setFilters={setFilters} options={[
            { key: 'gender',   label: 'Gender',   values: ['Men', 'Women'] },
            { key: 'position', label: 'Position', values: POSITIONS },
          ]} />
        </div>
      </PageHeader>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
      ) : data.length === 0 ? (
        <Empty icon="📋"
          message={search || Object.values(filters).some(Boolean) ? 'No club requirements match your search.' : 'No club requirements added yet.'}
          action={canEdit && !search && !Object.values(filters).some(Boolean) && <button className="btn btn-primary" onClick={openAdd}>+ Add Requirement</button>} />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th></th>{/* Actions — first */}
                  <th>G</th>
                  <SortTh label="🔰" field="clubName" sort={sort} setSort={setSort} />
                  <th>#</th>
                  <th>👤</th>
                  <th>📍</th>
                  <th>🗓️</th>
                  <th>💰</th>
                  <th>💵</th>
                </tr>
              </thead>
              <tbody>
                {data.map(p => (
                  <tr key={p.id} onClick={() => setViewReq(p)} style={{ cursor: 'pointer' }}>

                    {/* Actions — first column, stop propagation only here */}
                    <td onClick={e => e.stopPropagation()} style={{padding:'8px 4px 8px 8px'}}>
                      {canEdit && (
                        <RowActions
                          onDelete={() => del(p)}
                          onEdit={() => openEdit(p)}
                          onDuplicate={() => openDup(p)}
                        />
                      )}
                    </td>

                    {/* Gender */}
                    <td>
                      <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 500 }}>
                        {p.gender ? p.gender.charAt(0) : '—'}
                      </span>
                    </td>

                    {/* Club name + logo + league + youth badge */}
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <ClubLogoOrAvatar name={p.clubName} size={26} />
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 500 }}>{p.clubName}</span>
                            {p.clubIsYouth && <U19 />}
                          </div>
                          {p.league && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>{p.league}</div>}
                        </div>
                      </div>
                    </td>

                    {/* Table position */}
                    <td style={{ color: 'var(--text-2)', fontSize: 12, textAlign: 'center' }}>{p.tablePosition || '—'}</td>

                    {/* Contact — name + role + call/WhatsApp */}
                    <td>
                      {(p.contactName || p.contactPhone) ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>{p.contactName || '—'}</div>
                            {p.contactRole && <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{p.contactRole}</div>}
                          </div>
                          <span onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>
                            {p.contactPhone && <PhoneActions phone={p.contactPhone} />}
                          </span>
                        </div>
                      ) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>

                    {/* Required position */}
                    <td style={{ fontWeight: 500, textAlign: 'center' }}>{p.requiredPosition || '—'}</td>

                    {/* Age range */}
                    <td style={{ color: 'var(--text-2)', fontSize: 12, textAlign: 'center' }}>
                      {p.ageNotSpecified ? '—' : (p.ageMin && p.ageMax ? `${p.ageMin}–${p.ageMax}` : p.ageMin || p.ageMax || '—')}
                    </td>

                    {/* Max transfer fee */}
                    <td style={{ color: 'var(--text-2)', fontSize: 12 }}>
                      {p.transferFee && p.transferFee !== 'Not specified'
                        ? `€${Number(p.transferFee).toLocaleString()}`
                        : (p.transferFee === 'Not specified' ? '—' : p.transferFee || '—')}
                    </td>

                    {/* Max salary */}
                    <td style={{ color: 'var(--text-2)', fontSize: 12 }}>
                      {p.salary && p.salary !== 'Not specified'
                        ? `€${Number(p.salary).toLocaleString()}/mo`
                        : (p.salary === 'Not specified' ? '—' : p.salary || '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* View modal — opened by row click */}
      {viewReq && <RequirementView req={viewReq} onClose={() => setViewReq(null)} />}

      {/* Add/Edit modal */}
      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Club Requirement' : `Edit: ${form.clubName}`}
          onClose={() => setModal(null)} wide isDirty={isDirty} onSave={save}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Saving…</> : 'Save Requirement'}
            </button>
          </>}
        >
          <div className="form-section-title">Club Information</div>
          <div className="form-grid-2">
            <Field label="Gender" required>
              <ChipGroup options={['Men', 'Women']} value={f('gender')} onChange={s('gender')} />
            </Field>
            <Field label="Club Name" required>
              <input value={f('clubName')} onChange={e => s('clubName')(e.target.value)} placeholder="Club name" />
              <button type="button" className={`chip${form.clubIsYouth ? ' active' : ''}`}
                onClick={() => s('clubIsYouth')(!form.clubIsYouth)}
                style={{ fontSize: 11, padding: '4px 10px', marginTop: 6 }}>🌱 Youth Team</button>
            </Field>
          </div>
          <Field label="League">
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button type="button" className={`chip${form.leagueMode === 'select' ? ' active' : ''}`} onClick={() => s('leagueMode')('select')}>By Country + Tier</button>
              <button type="button" className={`chip${form.leagueMode === 'manual' ? ' active' : ''}`} onClick={() => s('leagueMode')('manual')}>Manual</button>
            </div>
            {form.leagueMode === 'select' ? (
              <div className="form-grid-2">
                <select value={f('leagueCountry')} onChange={e => s('leagueCountry')(e.target.value)}>
                  <option value="">Country...</option>
                  {COUNTRIES.map(c => <option key={c}>{c}</option>)}
                </select>
                <ChipGroup options={['1st', '2nd', '3rd', '4th', '5th+']} value={f('leagueTier')} onChange={s('leagueTier')} />
              </div>
            ) : (
              <input value={f('leagueManual')} onChange={e => s('leagueManual')(e.target.value)} placeholder="e.g. Premier League" />
            )}
            {league && (
              <div className="form-hint">
                League: <strong>{league}</strong>
                {form.clubIsYouth && <span style={{ marginLeft: 8 }}>· <strong>🌱 Youth League</strong></span>}
              </div>
            )}
          </Field>
          <Field label="Current Table Position">
            <input type="number" min={1} max={45} value={f('tablePosition')}
              onChange={e => { const v = parseInt(e.target.value); if (!e.target.value) { s('tablePosition')(''); return; } if (v >= 1 && v <= 45) s('tablePosition')(String(v)); }}
              placeholder="1–45" style={{ maxWidth: 120 }} />
          </Field>

          <hr className="divider" />
          <div className="form-section-title">Contact</div>
          <div className="form-grid-2">
            <Field label="Contact Name">
              <input value={f('contactName')} onChange={e => s('contactName')(e.target.value)} placeholder="Full name" />
            </Field>
            <Field label="Contact Role">
              <select value={f('contactRole')} onChange={e => s('contactRole')(e.target.value)}>
                <option value="">Select role...</option>
                {CONTACT_ROLES.map(r => <option key={r}>{r}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Contact Phone">
            <input value={f('contactPhone')} onChange={e => s('contactPhone')(e.target.value.replace(/[^0-9+]/g, ''))} placeholder="+972..." />
          </Field>

          <hr className="divider" />
          <div className="form-section-title">Profile Required</div>
          <Field label="Required Position">
            <select value={f('requiredPosition')} onChange={e => s('requiredPosition')(e.target.value)}>
              <option value="">Select...</option>
              {POSITIONS.map(p => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <div className="form-grid-2">
            <Field label="Min Age">
              <input type="number" min={14} max={48} value={form.ageNotSpecified ? '' : f('ageMin')}
                onChange={e => s('ageMin')(e.target.value)} disabled={form.ageNotSpecified} placeholder="Min" />
            </Field>
            <Field label="Max Age">
              <input type="number" min={14} max={48} value={form.ageNotSpecified ? '' : f('ageMax')}
                onChange={e => s('ageMax')(e.target.value)} disabled={form.ageNotSpecified} placeholder="Max" />
            </Field>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-2)' }}>
              <input type="checkbox" checked={!!form.ageNotSpecified} onChange={e => s('ageNotSpecified')(e.target.checked)} style={{ accentColor: 'var(--gold)' }} />
              Age: Not specified
            </label>
          </div>
          <div className="form-grid-2">
            <Field label="Max Transfer Fee (€)">
              <NumberInput value={f('transferFee')} onChange={s('transferFee')} placeholder="e.g. 500,000" allowNotSpecified />
            </Field>
            <Field label="Max Salary (€/month)">
              <NumberInput value={f('salary')} onChange={s('salary')} placeholder="e.g. 8,000" allowNotSpecified />
            </Field>
          </div>
          <Field label="Notes">
            <textarea value={f('notes')} onChange={e => s('notes')(e.target.value)} placeholder="Additional notes..." rows={3} />
          </Field>
        </Modal>
      )}

      {dialog}
    </div>
  );
}
