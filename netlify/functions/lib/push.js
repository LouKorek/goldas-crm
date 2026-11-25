// Real notifications on the phone (standard Web Push).
//
// The keys: the server makes one key pair (VAPID) the first time it is needed
// and keeps it in app_secrets/push, the private half sealed (lib/seal.js), the
// way the YouTube token is kept. Nothing to configure; the private key never
// leaves the functions. The browser gets the public half from functions/push.
//
// The devices: push_subscriptions/{id}, one per browser that said yes, id =
// a hash of the push service's address. Only functions read and write it (the
// app never reads it directly). A device belongs to the signed-in user who
// turned it on and carries his role; a device the push service reports gone
// (404 / 410) is deleted.
//
// What is pushed (pushUrgent, from the morning alerts job, send-alerts.js):
// the alerts engine's critical alerts of five kinds:
//   contract       a contract (or a dated clause in it) within 7 days or passed
//   repr           a representation agreement within 7 days or passed
//   deal_stale     a deal stuck twice as long as the "waiting too long" setting
//   task_overdue   a task past its day, to the task's owner only
//   payment_late   a payment past its day, to admins only (splitByRole)
// each once per alert key and user (app_meta/pushSent), never between 22:00
// and 08:00 Israel time. The text is short Hebrew with the name and what is
// due, never an amount of money or a phone number (a lock screen is public).
// Tapping it opens the page of the thing it is about (alertPath).
const crypto = require('crypto');
const webpush = require('web-push');
const { seal, unseal } = require('./seal.js');
const { siteUrl } = require('./site.js');
const { dedupeKey, splitByRole } = require('./alert-keys.js');
const { OWNER_EMAIL } = require('./firestore.js');
const { alertPath, israelDate, daysBetween, normalizeRole, toDateStr } = require('@goldas/domain');

const SUBS = 'push_subscriptions';
const KEYS = ['app_secrets', 'push'];
const SENT = ['app_meta', 'pushSent'];
const KEEP_DAYS = 400;
/** More new urgent alerts than this for one person become one summary notification. */
const MAX_SINGLE = 3;
const TTL_SECONDS = 12 * 3600;

const PUSH_TYPES = new Set(['contract', 'repr', 'deal_stale', 'task_overdue', 'payment_late']);
const isUrgent = (a) => a.severity === 'critical' && PUSH_TYPES.has(a.type);

const israelHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(now)) % 24;
const isQuiet = (now) => { const h = israelHour(now); return h < 8 || h >= 22; };

// ── Keys ─────────────────────────────────────────────────────────────
let _keys = null;
/** The server's key pair, made and sealed on first use. */
async function vapidKeys(db, { generate = () => webpush.generateVAPIDKeys(), now = Date.now() } = {}) {
  if (_keys) return _keys;
  const ref = db.collection(KEYS[0]).doc(KEYS[1]);
  const read = async () => {
    const snap = await ref.get();
    const d = snap.exists ? snap.data() || {} : {};
    return d.publicKey && d.privateKey ? { publicKey: d.publicKey, privateKey: unseal(d.privateKey) } : null;
  };
  let k = await read();
  if (!k) {
    const made = generate();
    // In a transaction, so two first callers at once still end up with one pair.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() || {} : {};
      if (d.publicKey && d.privateKey) return;
      tx.set(ref, { publicKey: made.publicKey, privateKey: seal(made.privateKey), createdAt: now }, { merge: true });
    });
    k = await read();
  }
  _keys = k;
  return k;
}

// ── Devices ──────────────────────────────────────────────────────────
const subId = (endpoint) => crypto.createHash('sha256').update(String(endpoint || '')).digest('hex').slice(0, 40);

// The push services of Chrome / Android, Firefox, Safari / iPhone and Edge.
// The server posts to the address a browser hands it, so nothing else is accepted.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
/** An error the person caused (shown to him as is), not a fault of the server. */
const bad = (message) => Object.assign(new Error(message), { status: 400 });

function validSubscription(sub) {
  const endpoint = String(sub?.endpoint || '');
  let url;
  try { url = new URL(endpoint); } catch { throw bad('not a push subscription'); }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.test(url.hostname) || endpoint.length > 1000) throw bad('not a push service this app knows');
  const p256dh = String(sub?.keys?.p256dh || ''), auth = String(sub?.keys?.auth || '');
  if (!B64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100 || !B64URL.test(auth) || auth.length < 16 || auth.length > 32) throw bad('the subscription keys are missing');
  return { endpoint, keys: { p256dh, auth } };
}

/** "iPhone", "Android · Chrome", "Windows · Edge": enough to tell one's devices apart. */
function deviceLabel(ua = '') {
  const s = String(ua);
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /SamsungBrowser/.test(s) ? 'Samsung' : /Firefox|FxiOS/.test(s) ? 'Firefox' : /Chrome|CriOS/.test(s) ? 'Chrome' : /Safari/.test(s) ? 'Safari' : '';
  if (os === 'iPhone' || os === 'iPad') return os;
  return [os, br].filter(Boolean).join(' · ') || 'Browser';
}

async function subscribe(db, user, sub, { ua = '', installed = false, now = Date.now() } = {}) {
  const s = validSubscription(sub);
  const id = subId(s.endpoint);
  const ref = db.collection(SUBS).doc(id);
  const prev = await ref.get();
  const same = prev.exists && (prev.data() || {}).email === user.email;
  // The same browser signed in as someone else now belongs to the newer user.
  await ref.set({
    email: user.email, role: normalizeRole(user.role), endpoint: s.endpoint, keys: s.keys,
    device: deviceLabel(ua), installed: !!installed,
    createdAt: same ? (prev.data().createdAt || now) : now, updatedAt: now,
    lastOkAt: same ? (prev.data().lastOkAt || null) : null, lastError: null,
  });
  return id;
}

/** Removes one of the user's own devices; someone else's is refused. */
async function unsubscribe(db, email, id) {
  if (!/^[a-f0-9]{40}$/.test(String(id || ''))) throw bad('unknown device');
  const ref = db.collection(SUBS).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if ((snap.data() || {}).email !== email) throw bad('that device belongs to someone else');
  await ref.delete();
  return true;
}

/** The user's devices for the screen: no push addresses or keys leave the server. */
async function devicesOf(db, email, currentEndpoint = '') {
  const here = currentEndpoint ? subId(currentEndpoint) : '';
  const snap = await db.collection(SUBS).where('email', '==', email).get();
  return snap.docs.map((d) => {
    const v = d.data() || {};
    return { id: d.id, device: v.device || 'Browser', installed: !!v.installed, createdAt: v.createdAt || null, lastOkAt: v.lastOkAt || null, failing: !!v.lastError, thisDevice: d.id === here };
  }).sort((a, b) => (b.thisDevice - a.thisDevice) || ((b.createdAt || 0) - (a.createdAt || 0)));
}

/**
 * One notification to one device. 'ok', 'gone' (deleted: the service no
 * longer knows it) or 'failed' (kept; tried again next time).
 */
async function deliver(db, sub, payload, { keys, send = webpush.sendNotification, now = Date.now() }) {
  const ref = db.collection(SUBS).doc(sub.id);
  try {
    await send({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
      vapidDetails: { subject: siteUrl(), publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: TTL_SECONDS, urgency: 'high', timeout: 10000,
    });
    await ref.set({ lastOkAt: now, lastError: null }, { merge: true }).catch(() => {});
    return 'ok';
  } catch (e) {
    const status = Number(e && e.statusCode) || 0;
    if (status === 404 || status === 410) { await ref.delete().catch(() => {}); return 'gone'; }
    await ref.set({ lastError: { at: now, status } }, { merge: true }).catch(() => {});
    return 'failed';
  }
}

// ── The text ─────────────────────────────────────────────────────────
// Typed text (a task title, a club name) may hold a phone number or a sum;
// neither belongs on a lock screen.
const MONEY = /(?:[₪$€£]\s?\d[\d,.']*(?:\s?(?:[kKmM]\b|אלף|מיליון))?)|(?:\d[\d,.']*\s?(?:[kKmM]\b|₪|€|\$|£|ש["״]ח|שקל\S*|אלף|מיליון|יורו|דולר|EUR\b|USD\b|ILS\b|NIS\b))/g;
const PHONE = /\+?\d[\d\s\-().]{6,}\d/g;
function clean(s, max = 80) {
  const out = String(s ?? '').replace(MONEY, '…').replace(PHONE, '…').replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
const when = (d) => (d === 0 ? 'היום' : d === 1 ? 'מחר' : d === -1 ? 'אתמול' : d < 0 ? `לפני ${-d} ימים` : `בעוד ${d} ימים`);
const late = (d) => (d === -1 ? 'באיחור של יום' : `באיחור של ${-d} ימים`);

/** { title, body } in Hebrew for one alert. */
function pushText(a) {
  const name = clean(a.subject?.name, 60) || 'ללא שם';
  const d = Number(a.days) || 0;
  switch (a.type) {
    case 'contract': {
      const clause = a.dueDate && a.record && a.dueDate !== toDateStr(a.record.contractEnd);
      if (clause) return { title: 'מועד בחוזה', body: `${name}: ${clean(a.proof?.he, 90)}` };
      const club = clean(a.record?.currentClub, 40);
      return { title: a.overdue ? 'חוזה הסתיים' : 'חוזה מסתיים', body: `${name}${club ? ` · ${club}` : ''} · ${when(d)}` };
    }
    case 'repr': return { title: a.overdue ? 'הסכם ייצוג הסתיים' : 'הסכם ייצוג מסתיים', body: `${name} · ${when(d)}` };
    case 'deal_stale': return { title: 'עסקה תקועה', body: `${name} · ${-d} ימים בלי התקדמות` };
    case 'task_overdue': return { title: 'משימה באיחור', body: `${name} · ${late(d)}` };
    case 'payment_late': return { title: 'תשלום באיחור', body: `${name} · ${late(d)}` };
    default: return { title: 'התראה דחופה', body: name };
  }
}

const payloadOf = (a, key) => ({ ...pushText(a), url: alertPath(a), tag: key.slice(0, 120) });
function summaryOf(list) {
  const names = [...new Set(list.map((x) => clean(x.a.subject?.name, 30)).filter(Boolean))];
  const shown = names.slice(0, 3).join(' · ');
  return { title: `${list.length} דברים דחופים`, body: names.length > 3 ? `${shown} ועוד` : shown, url: '/notifications', tag: 'urgent-summary' };
}

// ── The morning push ─────────────────────────────────────────────────
/** One key per alert, as the email's, except a late payment: told once, not every day. */
function pushKey(a, settings, today) {
  if (a.type === 'payment_late') return `payment_late|${a.subject.id}|${a.payment?.id || ''}`;
  return dedupeKey(a, settings, today);
}

async function loadUsers(db) {
  const roles = new Map([[OWNER_EMAIL, 'admin']]);
  const snap = await db.collection('app_users').get();
  for (const d of snap.docs) {
    const u = d.data() || {};
    const email = String(u.email || d.id).toLowerCase();
    if (email === OWNER_EMAIL) continue;
    roles.set(email, u.active === false ? null : normalizeRole(u.role));
  }
  return roles;
}

async function loadSent(db) {
  const s = await db.collection(SENT[0]).doc(SENT[1]).get();
  return s.exists ? (s.data() || {}).keys || {} : {};
}
function pruneSent(keys, today) {
  const out = {};
  for (const [k, v] of Object.entries(keys)) if (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) && daysBetween(String(v), today) <= KEEP_DAYS) out[k] = v;
  return out;
}

/**
 * Pushes the urgent ones among `alerts` (the full set, computed with money:
 * true and every user's tasks) to every device that asked for them.
 * → { quiet } at night, else { sent, people, devices, gone, failed }.
 */
async function pushUrgent(db, alerts, { settings, now = new Date(), send, job = { note() {} } } = {}) {
  if (isQuiet(now)) return { quiet: true, sent: 0 };
  const today = israelDate(now);
  const subs = (await db.collection(SUBS).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const out = { sent: 0, people: 0, devices: subs.length, gone: 0, failed: 0 };
  if (!subs.length) return out;
  const roles = await loadUsers(db);
  const byEmail = new Map();
  for (const s of subs) {
    // The role that counts is the one the person has today, not the one he had when he said yes.
    const role = roles.has(s.email) ? roles.get(s.email) : null;
    if (!role) { await db.collection(SUBS).doc(s.id).delete().catch(() => {}); out.gone++; continue; }
    if (!byEmail.has(s.email)) byEmail.set(s.email, { role, devices: [] });
    byEmail.get(s.email).devices.push(s);
  }
  const urgent = alerts.filter(isUrgent);
  const visible = new Map();
  for (const g of splitByRole(urgent, [...byEmail].map(([email, v]) => ({ email, role: v.role })))) for (const e of g.to) visible.set(e, g.alerts);
  const sent = await loadSent(db);
  const keys = urgent.length ? await vapidKeys(db) : null;
  for (const [email, { devices }] of byEmail) {
    const mine = (visible.get(email) || [])
      .filter((a) => a.type !== 'task_overdue' || String(a.record?.owner || OWNER_EMAIL).toLowerCase() === email)
      .map((a) => ({ a, key: `${email}|${pushKey(a, settings, today)}` }))
      .filter((x) => !sent[x.key]);
    if (!mine.length) continue;
    const payloads = mine.length > MAX_SINGLE ? [summaryOf(mine)] : mine.map((x) => payloadOf(x.a, x.key.slice(email.length + 1)));
    let reached = false;
    for (const dev of devices) {
      for (const p of payloads) {
        const r = await deliver(db, dev, p, { keys, send, now: now.getTime() });
        if (r === 'ok') { reached = true; out.sent++; }
        if (r === 'gone') { out.gone++; break; }
        if (r === 'failed') { out.failed++; break; }
      }
    }
    // Not reached (every device failed): nothing is marked, so tomorrow morning tries again.
    if (reached) { mine.forEach((x) => { sent[x.key] = today; }); out.people++; }
    job.note(`push ${email}: ${mine.length} urgent → ${reached ? 'sent' : 'not reached'}`);
  }
  await db.collection(SENT[0]).doc(SENT[1]).set({ keys: pruneSent(sent, today), updatedAt: now.getTime() });
  return out;
}

/** "Send a test" from the Notifications screen: every device of the user (or one), now, quiet hours or not. */
async function sendTest(db, email, { id = '', send, now = Date.now() } = {}) {
  const snap = await db.collection(SUBS).where('email', '==', email).get();
  const devices = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => !id || d.id === id);
  if (!devices.length) return { ok: 0, gone: 0, failed: 0, devices: 0 };
  const keys = await vapidKeys(db);
  const payload = { title: 'Gold A&S', body: 'התראות לטלפון פועלות. כך תגיע התראה דחופה.', url: '/notifications', tag: 'push-test' };
  const r = { ok: 0, gone: 0, failed: 0, devices: devices.length };
  for (const dev of devices) r[await deliver(db, dev, payload, { keys, send, now })]++;
  return r;
}

module.exports = {
  vapidKeys, subscribe, unsubscribe, devicesOf, deliver, pushUrgent, sendTest,
  subId, validSubscription, deviceLabel, pushText, pushKey, clean, isUrgent, isQuiet, israelHour, summaryOf,
  PUSH_TYPES, MAX_SINGLE, SUBS,
  _resetKeysForTests: () => { _keys = null; },
};
