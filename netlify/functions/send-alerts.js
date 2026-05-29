// Daily alert emails — runs on Netlify's scheduler instead of the Apps Script
// trigger. Same behaviour as the old Code.gs: reads players/matches and the
// notification thresholds from Firestore, then emails each alert ONCE the day
// it crosses a threshold the user configured.
//
// Required Netlify environment variables:
//   FIREBASE_SERVICE_ACCOUNT_KEY  — the full JSON of a Firebase service
//                                   account (Project settings → Service
//                                   accounts → Generate new private key),
//                                   pasted minified onto one line.
//   GMAIL_APP_PASSWORD            — a Gmail App Password for lou.korek@gmail.com
//                                   (Google Account → Security → 2-Step
//                                   Verification → App passwords).

const { schedule } = require('@netlify/functions');
const admin        = require('firebase-admin');
const nodemailer   = require('nodemailer');

// ────────────────── Config ──────────────────
const OWNER_EMAIL     = 'lou.korek@gmail.com';
const MATCH_LEAD_DAYS = 1;
const DEFAULT_SETTINGS = {
  contractDays: [7, 30, 60],
  reprDays:     [7, 30, 60],
  passportDays: [30, 90, 180],
  birthdayDays: [0, 3, 7],
};

// ────────────────── Firebase Admin (cached) ──────────────────
let _db;
function getDb() {
  if (_db) return _db;
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  _db = admin.firestore();
  return _db;
}

// ────────────────── Date helpers ──────────────────
function parseDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return new Date(+y, +m - 1, +d);
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return new Date(+y, +m - 1, +d);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
const stripTime = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function daysUntil(s, now) {
  const d = parseDate(s); if (!d) return null;
  return Math.ceil((d - now) / 86400000);
}
function daysUntilBirthday(dob, now) {
  const b = parseDate(dob); if (!b) return null;
  const next = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  if (next < stripTime(now)) next.setFullYear(now.getFullYear() + 1);
  return Math.ceil((next - stripTime(now)) / 86400000);
}
function ageOnNextBirthday(dob, now) {
  const b = parseDate(dob); if (!b) return '';
  let age = now.getFullYear() - b.getFullYear();
  const thisYear = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  if (thisYear < stripTime(now)) age += 1;
  return age;
}
const pad = (n) => ('0' + n).slice(-2);
function fmtDate(s) {
  const d = parseDate(s); if (!d) return s || '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
const dayLabel = (d) => (d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`);

// ────────────────── Alert computation (mirrors Code.gs / the app) ──────────────────
function computeNewAlerts(players, matches, settings, sent, now) {
  const out = { contract: [], repr: [], passport: [], birthday: [], matches: [] };
  const newKeys = [];

  function handleDate(p, field, cat, thresholds, makeItem) {
    if (!p[field]) return;
    const d = daysUntil(p[field], now);
    if (d === null || d < 0) return;
    const satisfied = thresholds.filter((t) => d <= t);
    if (!satisfied.length) return;
    const anyUnsent = satisfied.some((t) => !sent[`${p.id}|${cat}|${t}`]);
    if (!anyUnsent) return;
    out[cat].push(makeItem(p, d));
    satisfied.forEach((t) => {
      const k = `${p.id}|${cat}|${t}`;
      if (!sent[k]) newKeys.push(k);
    });
  }

  players.forEach((p) => {
    handleDate(p, 'contractEnd',    'contract', settings.contractDays,
      (p, d) => ({ name: p.fullName, days: d, date: p.contractEnd, club: p.currentClub }));
    handleDate(p, 'reprEnd',        'repr',     settings.reprDays,
      (p, d) => ({ name: p.fullName, days: d, date: p.reprEnd }));
    handleDate(p, 'passportExpiry', 'passport', settings.passportDays,
      (p, d) => ({ name: p.fullName, days: d, date: p.passportExpiry }));

    const bd = daysUntilBirthday(p.dob, now);
    if (bd !== null && bd >= 0) {
      const yr = now.getFullYear();
      const bsat = settings.birthdayDays.filter((t) => bd <= t);
      if (bsat.length && bsat.some((t) => !sent[`b|${p.id}|${t}|${yr}`])) {
        out.birthday.push({ name: p.fullName, days: bd, age: ageOnNextBirthday(p.dob, now) });
        bsat.forEach((t) => {
          const k = `b|${p.id}|${t}|${yr}`;
          if (!sent[k]) newKeys.push(k);
        });
      }
    }
  });

  matches.forEach((m) => {
    const d = daysUntil(m.date, now);
    if (d === null || d < 0 || d > MATCH_LEAD_DAYS) return;
    const k = `m|${m.id || `${m.homeTeam}_${m.awayTeam}_${m.date}`}`;
    if (sent[k]) return;
    out.matches.push({ home: m.homeTeam, away: m.awayTeam, days: d, date: m.date, time: m.time, stadium: m.stadiumName });
    newKeys.push(k);
  });

  ['contract', 'repr', 'passport', 'birthday', 'matches'].forEach((k) => {
    out[k].sort((a, b) => a.days - b.days);
  });
  const total = out.contract.length + out.repr.length + out.passport.length + out.birthday.length + out.matches.length;
  return { alerts: out, newKeys, total };
}

// ────────────────── Email body (identical look to the old script) ──────────────────
function buildEmailHtml(a, total) {
  const gold = '#C9A84C', dark = '#16201A', text = '#1c1c1c';
  function section(title, icon, rows) {
    if (!rows.length) return '';
    return `<tr><td style="padding:18px 0 6px;font:700 13px Arial;color:${gold};letter-spacing:.04em;text-transform:uppercase">${icon} ${title} (${rows.length})</td></tr><tr><td>${rows.join('')}</td></tr>`;
  }
  function row(main, sub, urgent) {
    const bar = urgent ? '#E74C3C' : gold;
    return `<div style="border-left:3px solid ${bar};background:#faf8f2;border-radius:6px;padding:10px 14px;margin:6px 0"><div style="font:600 14px Arial;color:${text}">${main}</div>${sub ? `<div style="font:13px Arial;color:#666;margin-top:2px">${sub}</div>` : ''}</div>`;
  }
  let html = `<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><div style="background:${dark};padding:22px 24px;border-radius:12px 12px 0 0"><div style="font:700 22px Georgia,serif;color:${gold}">Gold A&amp;S</div><div style="font:12px Arial;color:#9bbf9d;letter-spacing:.1em;text-transform:uppercase;margin-top:2px">Alerts &middot; ${total} new</div></div><div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:8px 24px 24px"><table width="100%" cellpadding="0" cellspacing="0">`;
  html += section('Contract Expiry', '📋', a.contract.map((x) =>
    row(`${x.name} - contract expires in ${dayLabel(x.days)}`,
        `Expires: ${fmtDate(x.date)}${x.club ? ' &middot; ' + x.club : ''}`, x.days <= 7)));
  html += section('Representation Expiry', '🤝', a.repr.map((x) =>
    row(`${x.name} - representation expires in ${dayLabel(x.days)}`,
        `Expires: ${fmtDate(x.date)}`, x.days <= 7)));
  html += section('Passport Expiry', '🛂', a.passport.map((x) =>
    row(`${x.name} - passport expires in ${dayLabel(x.days)}`,
        `Expires: ${fmtDate(x.date)}`, x.days <= 30)));
  html += section('Birthdays', '🎂', a.birthday.map((x) =>
    row(`${x.name}${x.age === 18 ? ' - Turning 18!' : ''}`,
        `${x.days === 0 ? 'Birthday is today!' : 'Birthday in ' + dayLabel(x.days)} &middot; Turning ${x.age}`,
        x.age === 18)));
  html += section('Upcoming Matches', '⚽', a.matches.map((x) =>
    row(`${x.home} vs ${x.away}`,
        `${fmtDate(x.date)}${x.time ? ' &middot; ' + x.time : ''}${x.stadium ? ' &middot; ' + x.stadium : ''}`,
        x.days <= 1)));
  html += `</table></div><div style="text-align:center;font:11px Arial;color:#aaa;padding:14px">Gold A&amp;S Football Agency &middot; gold-as.com</div></div>`;
  return html;
}

// ────────────────── Firestore reads ──────────────────
const arr = (v, fallback) => (v && v.length ? v.map(Number) : fallback);

async function fetchSettings(db) {
  try {
    const s = await db.collection('settings').doc('notifications').get();
    if (!s.exists) return DEFAULT_SETTINGS;
    const d = s.data();
    return {
      contractDays: arr(d.contractDays, DEFAULT_SETTINGS.contractDays),
      reprDays:     arr(d.reprDays,     DEFAULT_SETTINGS.reprDays),
      passportDays: arr(d.passportDays, DEFAULT_SETTINGS.passportDays),
      birthdayDays: arr(d.birthdayDays, DEFAULT_SETTINGS.birthdayDays),
    };
  } catch (e) {
    console.error('fetchSettings error:', e);
    return DEFAULT_SETTINGS;
  }
}

async function fetchRecipients(db) {
  try {
    const snap = await db.collection('app_users').get();
    const emails = snap.docs
      .map((d) => d.data())
      .filter((u) => u.active !== false && u.emailAlerts !== false && u.email)
      .map((u) => u.email);
    return emails.length ? emails : [OWNER_EMAIL];
  } catch (e) {
    console.error('fetchRecipients error, falling back to owner:', e);
    return [OWNER_EMAIL];
  }
}

// Dedup state lives in Firestore (replaces Apps Script PropertiesService).
async function loadSent(db) {
  try {
    const s = await db.collection('app_meta').doc('sentAlerts').get();
    return s.exists ? (s.data().keys || {}) : {};
  } catch (e) {
    console.error('loadSent error:', e);
    return {};
  }
}
async function saveSent(db, keys) {
  await db.collection('app_meta').doc('sentAlerts').set({
    keys,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ────────────────── Main routine ──────────────────
async function sendDigest() {
  const db = getDb();
  const [playersSnap, matchesSnap, settings, recipients, sent] = await Promise.all([
    db.collection('players').get(),
    db.collection('matches').get(),
    fetchSettings(db),
    fetchRecipients(db),
    loadSent(db),
  ]);
  const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const matches = matchesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const r = computeNewAlerts(players, matches, settings, sent, new Date());
  if (r.total === 0) {
    console.log('No new alerts due — nothing sent.');
    return { statusCode: 200, body: 'no alerts' };
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: OWNER_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const subject = `Gold A&S - ${r.total === 1 ? 'New alert' : `${r.total} new alerts`}`;
  await transporter.sendMail({
    from: `"Gold A&S Alerts" <${OWNER_EMAIL}>`,
    to: recipients.join(','),
    subject,
    html: buildEmailHtml(r.alerts, r.total),
  });
  console.log(`Email sent to ${recipients.join(',')} (${r.total} alerts).`);

  const newSent = { ...sent };
  r.newKeys.forEach((k) => { newSent[k] = 1; });
  await saveSent(db, newSent);

  return { statusCode: 200, body: `sent ${r.total} alerts` };
}

// 06:00 UTC = 08:00 (winter) / 09:00 (summer) in Israel.
exports.handler = schedule('0 6 * * *', async () => {
  try { return await sendDigest(); }
  catch (e) {
    console.error('sendDigest failed:', e);
    return { statusCode: 500, body: String(e) };
  }
});
