// The daily alerts email. The alert set comes from the same domain engine the
// app's Home and Notifications screens use (packages/domain/src/engines/
// alerts.ts), so what lands in the inbox is exactly what the screen shows.
// Each alert is emailed once per threshold it crosses; the dedupe keys live
// in app_meta/sentAlerts.
//
// The same morning run then sends the urgent ones to the phones that asked
// for them (lib/push.js): each once per person, by role, never at night.
//
// Required Netlify environment variables:
//   FIREBASE_SERVICE_ACCOUNT_KEY  — the Firebase service account JSON.
//   GMAIL_APP_PASSWORD            — a Gmail App Password for the owner mailbox.

const { schedule } = require('@netlify/functions');
const { admin, getDb, OWNER_EMAIL, listRepresented, isLive } = require('./lib/firestore.js');
const { internalHeaders } = require('./lib/auth.js');
const { pushUrgent } = require('./lib/push.js');
const { computeAlerts, mergeSettings, israelDate, daysBetween, normalizeRole } = require('@goldas/domain');
const nodemailer = require('nodemailer');

// Matches are emailed one day ahead only; the screen shows the whole week.
const EMAIL_SETTINGS = { matchDays: [0, 1] };
const KEEP_DAYS = 400;

const pad = (n) => ('0' + n).slice(-2);
const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || ''); };

const { dedupeKey, splitByRole } = require('./lib/alert-keys.js');

const SECTIONS = [
  ['job_failed', 'עבודות לילה שנכשלו', 'Failed night jobs', '⚠️'],
  ['payment_late', 'תשלומים באיחור', 'Late payments', '💶'],
  ['payment_due', 'תשלומים שצפויים השבוע', 'Payments due this week', '💶'],
  ['sync_mismatch', 'הסנכרון מצא קבוצה מפוקפקת', 'Sync found a doubtful squad', '🔍'],
  ['deal_stale', 'עסקאות שמחכות יותר מדי', 'Deals waiting too long', '⏳'],
  ['contract', 'סיום חוזה', 'Contract Expiry', '📋'],
  ['repr', 'סיום הסכם ייצוג', 'Representation Expiry', '🤝'],
  ['passport', 'תוקף דרכון', 'Passport Expiry', '🛂'],
  ['requirement_expired', 'דרישות מועדון שפגו', 'Expired requirements', '📌'],
  ['task_overdue', 'משימות באיחור', 'Overdue tasks', '✅'],
  ['birthday', 'ימי הולדת', 'Birthdays', '🎂'],
  ['match', 'משחקים קרובים', 'Upcoming Matches', '⚽'],
];

// Hebrew, right-to-left, the same look as before.
function buildEmailHtml(alerts, total) {
  const gold = '#C9A84C', dark = '#16201A', text = '#1c1c1c';
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (a) => {
    const urgent = a.severity === 'critical' || a.severity === 'gold';
    const sub = [a.proof.he, a.dueDate ? fmtDate(a.dueDate) : ''].filter(Boolean).join(' &middot; ');
    return `<div style="border-right:3px solid ${urgent ? '#E74C3C' : gold};background:#faf8f2;border-radius:6px;padding:10px 14px;margin:6px 0;text-align:right"><div style="font:600 14px Arial;color:${text}">${esc(a.subject.name)}</div><div style="font:13px Arial;color:#666;margin-top:2px">${sub}</div></div>`;
  };
  let html = `<div dir="rtl" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;text-align:right"><div style="background:${dark};padding:22px 24px;border-radius:12px 12px 0 0"><div style="font:700 22px Georgia,serif;color:${gold}">Gold A&amp;S</div><div style="font:12px Arial;color:#9bbf9d;letter-spacing:.06em;margin-top:2px">התראות &middot; ${total} חדשות &middot; ${fmtDate(israelDate())}</div></div><div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:8px 24px 24px"><table width="100%" cellpadding="0" cellspacing="0">`;
  for (const [type, he, , icon] of SECTIONS) {
    const list = alerts.filter((a) => a.type === type);
    if (!list.length) continue;
    html += `<tr><td style="padding:18px 0 6px;font:700 13px Arial;color:${gold};letter-spacing:.04em">${icon} ${he} (${list.length})</td></tr><tr><td>${list.map(row).join('')}</td></tr>`;
  }
  html += `</table><div style="font:12px Arial;color:#888;margin-top:18px">הרשימה המלאה: <a href="https://goldas-crm.netlify.app/notifications" style="color:${gold}">goldas-crm.netlify.app/notifications</a></div></div><div style="text-align:center;font:11px Arial;color:#aaa;padding:14px">Gold A&amp;S Football Agency &middot; gold-as.com</div></div>`;
  return html;
}

async function fetchSettings(db) {
  try { const s = await db.collection('settings').doc('notifications').get(); return mergeSettings({ ...(s.exists ? s.data() : {}), ...EMAIL_SETTINGS }); }
  catch (e) { console.error('fetchSettings error:', e); return mergeSettings(EMAIL_SETTINGS); }
}

// An empty list is a deliberate "nobody wants these" and is honoured.
// [{ email, role }]: the role decides whether money is in the email.
async function fetchRecipients(db) {
  const owner = [{ email: OWNER_EMAIL, role: 'admin' }];
  try {
    const snap = await db.collection('app_users').get();
    if (snap.empty) return owner;
    return snap.docs.map((d) => d.data()).filter((u) => u.active !== false && u.emailAlerts !== false && u.email)
      .map((u) => ({ email: u.email, role: String(u.email).toLowerCase() === OWNER_EMAIL ? 'admin' : normalizeRole(u.role) }));
  } catch (e) { console.error('fetchRecipients error, falling back to owner:', e); return owner; }
}

// Dedupe state: { key: 'YYYY-MM-DD' } (the day it was sent). Older entries
// used the value 1; they are kept as if sent today and age out normally.
async function loadSent(db) {
  try { const s = await db.collection('app_meta').doc('sentAlerts').get(); return s.exists ? (s.data().keys || {}) : {}; }
  catch (e) { console.error('loadSent error:', e); return {}; }
}
function pruneSent(keys, today) {
  const out = {};
  for (const [k, v] of Object.entries(keys)) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : today;
    if (daysBetween(d, today) <= KEEP_DAYS) out[k] = d;
  }
  return out;
}
async function saveSent(db, keys, today) {
  await db.collection('app_meta').doc('sentAlerts').set({ keys: pruneSent(keys, today), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: false });
}

async function sendDigest(job) {
  const db = getDb();
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(isLive);
  const [players, matches, deals, requirements, tasks, jobs, settings, recipients, sent] = await Promise.all([
    listRepresented(db),
    db.collection('matches').get().then(rows),
    db.collection('deals').get().then(rows),
    db.collection('club_requirements').get().then(rows),
    db.collection('tasks').get().then(rows),
    db.collection('jobs').orderBy('startedAt', 'desc').limit(40).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    fetchSettings(db),
    fetchRecipients(db),
    loadSent(db),
  ]);
  const now = new Date();
  const today = israelDate(now);
  // money: true here; splitByRole keeps the payment alerts to the admins' copy.
  // Every user's tasks: the email carries the owner's, a phone gets its own user's.
  const r = computeAlerts({ players, matches, deals, requirements, tasks, jobs, settings, now, money: true });
  const ownerTask = (a) => a.type !== 'task_overdue' || String(a.record?.owner || OWNER_EMAIL).toLowerCase() === OWNER_EMAIL;
  // One failing never holds back the other; the run is marked failed if either did.
  let emailed, pushed, failed = false;
  try { emailed = await emailDigest(db, r.alerts.filter(ownerTask), { settings, recipients, sent, today, job }); }
  catch (e) { failed = true; emailed = `email failed: ${e.message}`; console.error('[send-alerts] email failed:', e.message); }
  // Then the phones: the urgent ones only, each once per person (lib/push.js).
  try { pushed = await pushUrgent(db, r.alerts, { settings, now, job }); }
  catch (e) { failed = true; pushed = { error: e.message }; console.error('[send-alerts] phones failed:', e.message); }
  if (failed) throw new Error(`${emailed}; ${pushed.error ? `phones failed: ${pushed.error}` : 'phones ok'}`);
  const phones = pushed.quiet ? 'phones: quiet hours' : `phones: ${pushed.sent} sent to ${pushed.people} people${pushed.gone ? `, ${pushed.gone} gone devices removed` : ''}${pushed.failed ? `, ${pushed.failed} failed` : ''}`;
  return { statusCode: 200, body: `${emailed}; ${phones}` };
}

async function emailDigest(db, alerts, { settings, recipients, sent, today, job }) {
  const fresh = [];
  const newKeys = [];
  for (const a of alerts) {
    const k = dedupeKey(a, settings, today);
    if (sent[k]) continue;
    fresh.push(a); newKeys.push(k);
  }
  job.note(`${alerts.length} alerts, ${fresh.length} new`);
  if (!fresh.length) return 'no new alerts';
  if (!recipients.length) return 'no recipients';

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: OWNER_EMAIL, pass: process.env.GMAIL_APP_PASSWORD } });
  for (const g of splitByRole(fresh, recipients)) {
    await transporter.sendMail({
      from: `"Gold A&S" <${OWNER_EMAIL}>`,
      to: g.to.join(','),
      subject: `Gold A&S · ${g.alerts.length === 1 ? 'התראה חדשה' : `${g.alerts.length} התראות חדשות`}`,
      html: buildEmailHtml(g.alerts, g.alerts.length),
    });
  }
  const newSent = { ...sent };
  newKeys.forEach((k) => { newSent[k] = today; });
  await saveSent(db, newSent, today);
  return `sent ${fresh.length} alerts to ${recipients.length}`;
}

// 06:00 UTC = 08:00 (winter) / 09:00 (summer) in Israel: after the night run,
// and never inside the phones' quiet hours (22:00 to 08:00). The work runs in
// ops-background (task 'send-alerts'): a scheduled function is cut after
// seconds, and the email and the phone notifications take longer than that.
exports.handler = schedule('0 6 * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/ops-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('send-alerts')) }, body: JSON.stringify({ task: 'send-alerts', trigger: 'schedule' }),
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    console.error('send-alerts trigger failed:', e);
    return { statusCode: 500, body: String(e) };
  }
});
exports._internal = { dedupeKey, buildEmailHtml, pruneSent, sendDigest, emailDigest, splitByRole, fetchRecipients };
