// Phone notifications (lib/push.js): the sealed key pair, the devices, and the
// morning push: urgent only, by role, each once, never at night, gone devices
// removed. The encryption is checked end to end: what would go to the push
// service decrypts with the phone's own key into the Hebrew text.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
const { fakeDb, stubFirestore } = require('./fake-firestore.js');
stubFirestore(() => null);

const webpush = require('web-push');
const ece = require('http_ece');
const push = require('../push.js');
const { isSealed } = require('../seal.js');
const { OWNER_EMAIL: OWNER } = require('../firestore.js');
const { computeAlerts, mergeSettings, israelDate, addDays } = require('@goldas/domain');

const DANI = 'dani@x.com';
const DAY = new Date('2026-11-25T08:00:00Z');     // 10:00 in Israel
const NIGHT = new Date('2026-11-25T21:00:00Z');   // 23:00 in Israel
const today = israelDate(DAY);
const settings = mergeSettings(null);

/** A phone: its own key pair, as a browser makes one. */
function phone(host = 'fcm.googleapis.com', n = 1) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    sub: { endpoint: `https://${host}/fcm/send/device-${n}-${crypto.randomBytes(6).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}

/** Stands in for the push service: records each request, answers with `status(endpoint)`. */
function service(status = () => 201) {
  const got = [];
  const send = async (sub, body, opts) => {
    got.push({ endpoint: sub.endpoint, payload: JSON.parse(body), opts });
    const code = status(sub.endpoint);
    if (code >= 400) throw Object.assign(new Error(`push service ${code}`), { statusCode: code });
    return { statusCode: code };
  };
  return { got, send };
}

const seed = () => fakeDb({
  app_users: {
    [DANI]: { email: DANI, role: 'manager', active: true },
    'gone@x.com': { email: 'gone@x.com', role: 'manager', active: false },
  },
});

function alertsFor() {
  const players = [
    { id: 'p1', fullName: 'Avi Cohen', currentClub: 'Maccabi Haifa', contractEnd: addDays(today, 5) },
    { id: 'p2', fullName: 'Ben Levi', contractEnd: addDays(today, 20) },                // a warning, not urgent
    { id: 'p3', fullName: 'Dor Mor', reprEnd: addDays(today, -2) },                      // passed: urgent
  ];
  const deals = [
    { id: 'd1', playerName: 'Avi Cohen', clubName: 'Hapoel Tel Aviv', stage: 'Negotiation', enteredStageAt: new Date(DAY.getTime() - 40 * 864e5).toISOString(),
      payments: [{ id: 'pay1', label: 'עמלה', amount: 50000, currency: 'EUR', dueDate: addDays(today, -3), paidAt: null }] },
  ];
  const tasks = [
    { id: 't1', title: 'להתקשר לסוכן 054-1234567 על 20,000 ₪', dueDate: addDays(today, -2), owner: DANI },
    { id: 't2', title: 'חוזה חדש', dueDate: addDays(today, -1), owner: OWNER },
  ];
  return computeAlerts({ players, deals, tasks, settings, now: DAY, money: true }).alerts;
}

test('the key pair is made once, the private half sealed, and the public half handed out', async () => {
  push._resetKeysForTests();
  const db = seed();
  let made = 0;
  const k1 = await push.vapidKeys(db, { generate: () => { made++; return webpush.generateVAPIDKeys(); } });
  push._resetKeysForTests();
  const k2 = await push.vapidKeys(db, { generate: () => { made++; return webpush.generateVAPIDKeys(); } });
  assert.equal(made, 1);
  assert.equal(k1.publicKey, k2.publicKey);
  assert.equal(k1.privateKey, k2.privateKey);
  const stored = db.read('app_secrets', 'push');
  assert.ok(isSealed(stored.privateKey), 'private key sealed');
  assert.ok(!JSON.stringify(stored).includes(k1.privateKey), 'never stored in the clear');
});

test('only a real push service is accepted, and devices are listed without addresses or keys', async () => {
  const db = seed();
  const user = { email: OWNER, role: 'admin' };
  const bad = phone('evil.example.com');
  await assert.rejects(push.subscribe(db, user, bad.sub), /push service/);
  await assert.rejects(push.subscribe(db, user, { endpoint: phone().sub.endpoint, keys: {} }), /keys/);
  const a = phone('fcm.googleapis.com', 1), b = phone('web.push.apple.com', 2);
  await push.subscribe(db, user, a.sub, { ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile', now: 1 });
  await push.subscribe(db, user, b.sub, { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/604.1', installed: true, now: 2 });
  const list = await push.devicesOf(db, OWNER, b.sub.endpoint);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((d) => d.device), ['iPhone', 'Android · Chrome']);
  assert.ok(list[0].thisDevice && !list[1].thisDevice);
  assert.ok(!JSON.stringify(list).includes('googleapis') && !JSON.stringify(list).includes(a.sub.keys.p256dh));
  const stored = db.read('push_subscriptions', push.subId(a.sub.endpoint));
  assert.equal(stored.email, OWNER);
  assert.equal(stored.role, 'admin');
});

test('a user removes his own device, never someone else\'s', async () => {
  const db = seed();
  const p = phone();
  await push.subscribe(db, { email: DANI, role: 'manager' }, p.sub);
  const id = push.subId(p.sub.endpoint);
  await assert.rejects(push.unsubscribe(db, OWNER, id), /someone else/);
  assert.equal(await push.unsubscribe(db, DANI, id), true);
  assert.equal(db.read('push_subscriptions', id), undefined);
});

test('the morning push: urgent only, by role, tasks to their owner, each once', async () => {
  push._resetKeysForTests();
  const db = seed();
  const lou = phone('fcm.googleapis.com', 1), dani = phone('web.push.apple.com', 2);
  await push.subscribe(db, { email: OWNER, role: 'admin' }, lou.sub);
  await push.subscribe(db, { email: DANI, role: 'manager' }, dani.sub);
  const svc = service();
  const alerts = alertsFor();
  const r = await push.pushUrgent(db, alerts, { settings, now: DAY, send: svc.send });
  assert.equal(r.people, 2);

  const to = (p) => svc.got.filter((g) => g.endpoint === p.sub.endpoint).map((g) => g.payload);
  const louGot = to(lou), daniGot = to(dani);
  // The owner: the contract within a week, the passed representation, the stuck
  // deal, the late payment and his own task: five, so one summary instead of five.
  assert.equal(louGot.length, 1);
  assert.equal(louGot[0].title, '5 דברים דחופים');
  assert.equal(louGot[0].url, '/notifications');
  // Dani (manager): no payment, only his own task: contract, repr, deal, task.
  assert.equal(daniGot.length, 1);
  assert.equal(daniGot[0].title, '4 דברים דחופים');
  const keys = Object.keys(db.read('app_meta', 'pushSent').keys);
  assert.ok(keys.some((k) => k.startsWith(`${OWNER}|payment_late|d1|pay1`)), 'late payment to the admin');
  assert.ok(!keys.some((k) => k.startsWith(`${DANI}|payment_late`)), 'no money to a manager');
  assert.ok(keys.some((k) => k.startsWith(`${DANI}|task_overdue|t1`)) && !keys.some((k) => k.startsWith(`${DANI}|task_overdue|t2`)));
  assert.ok(!keys.some((k) => k.includes('|contract|p2|')), 'a contract 20 days away is not urgent');
  assert.ok(svc.got.every((g) => g.opts.vapidDetails && g.opts.urgency === 'high'));

  // Again the same morning (or the next one): nothing new, nothing sent.
  const again = service();
  const r2 = await push.pushUrgent(db, alerts, { settings, now: DAY, send: again.send });
  assert.equal(again.got.length, 0);
  assert.equal(r2.sent, 0);
});

test('three or fewer go one by one, with the page to open and no money or phone numbers', async () => {
  push._resetKeysForTests();
  const db = seed();
  const dani = phone();
  await push.subscribe(db, { email: DANI, role: 'manager' }, dani.sub);
  const svc = service();
  const only = alertsFor().filter((a) => ['task_overdue', 'contract', 'payment_late'].includes(a.type));
  await push.pushUrgent(db, only, { settings, now: DAY, send: svc.send });
  const got = svc.got.map((g) => g.payload);
  assert.equal(got.length, 2, 'the contract and his task; never the payment');
  const contract = got.find((p) => p.url === '/players/p1');
  assert.deepEqual({ title: contract.title, body: contract.body }, { title: 'חוזה מסתיים', body: 'Avi Cohen · Maccabi Haifa · בעוד 5 ימים' });
  const task = got.find((p) => p.url === '/tasks');
  assert.equal(task.title, 'משימה באיחור');
  assert.ok(!/\d{3}.?\d{4}|20,000|₪/.test(task.body), `no phone or sum: ${task.body}`);
  assert.match(task.body, /באיחור של 2 ימים$/);
});

test('never between 22:00 and 08:00 Israel time; the morning after still sends', async () => {
  push._resetKeysForTests();
  const db = seed();
  const p = phone();
  await push.subscribe(db, { email: OWNER, role: 'admin' }, p.sub);
  const svc = service();
  const r = await push.pushUrgent(db, alertsFor(), { settings, now: NIGHT, send: svc.send });
  assert.equal(r.quiet, true);
  assert.equal(svc.got.length, 0);
  assert.equal(push.isQuiet(new Date('2026-11-25T05:30:00Z')), true, '07:30 in winter is still quiet');
  assert.equal(push.isQuiet(new Date('2026-11-25T06:00:00Z')), false, 'the 06:00 UTC run is 08:00 in winter');
  assert.equal(push.isQuiet(new Date('2026-07-01T06:00:00Z')), false, 'and 09:00 in summer');
  await push.pushUrgent(db, alertsFor(), { settings, now: DAY, send: svc.send });
  assert.equal(svc.got.length, 1);
});

test('a device the service reports gone is deleted; a failing one is kept and tried again', async () => {
  push._resetKeysForTests();
  const db = seed();
  const gone = phone('fcm.googleapis.com', 1), flaky = phone('fcm.googleapis.com', 2);
  await push.subscribe(db, { email: OWNER, role: 'admin' }, gone.sub);
  await push.subscribe(db, { email: DANI, role: 'manager' }, flaky.sub);
  const svc = service((e) => (e === gone.sub.endpoint ? 410 : 503));
  const r = await push.pushUrgent(db, alertsFor(), { settings, now: DAY, send: svc.send });
  assert.equal(r.gone, 1);
  assert.equal(r.failed, 1);
  assert.equal(db.read('push_subscriptions', push.subId(gone.sub.endpoint)), undefined);
  assert.ok(db.read('push_subscriptions', push.subId(flaky.sub.endpoint)).lastError);
  assert.deepEqual(db.read('app_meta', 'pushSent').keys, {}, 'nothing marked: tomorrow tries again');
  const ok = service();
  await push.pushUrgent(db, alertsFor(), { settings, now: DAY, send: ok.send });
  assert.equal(ok.got.length, 1);
  assert.ok(db.read('push_subscriptions', push.subId(flaky.sub.endpoint)).lastOkAt);
});

test('a user who left (inactive) loses his devices and gets nothing', async () => {
  push._resetKeysForTests();
  const db = seed();
  const p = phone();
  await push.subscribe(db, { email: 'gone@x.com', role: 'manager' }, p.sub);
  const svc = service();
  await push.pushUrgent(db, alertsFor(), { settings, now: DAY, send: svc.send });
  assert.equal(svc.got.length, 0);
  assert.equal(db.read('push_subscriptions', push.subId(p.sub.endpoint)), undefined);
});

test('what goes to the push service decrypts on the phone into the Hebrew text', async () => {
  push._resetKeysForTests();
  const db = seed();
  const p = phone('web.push.apple.com');
  await push.subscribe(db, { email: OWNER, role: 'admin' }, p.sub);
  const requests = [];
  // The real library builds the request (encryption + VAPID); only the network is replaced.
  const send = async (sub, body, opts) => { requests.push(webpush.generateRequestDetails(sub, body, opts)); return { statusCode: 201 }; };
  const r = await push.sendTest(db, OWNER, { send });
  assert.equal(r.ok, 1);
  const req = requests[0];
  assert.match(req.endpoint, /web\.push\.apple\.com/);
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.match(req.headers.Authorization, /^vapid t=.+, k=.+$/);
  const plain = ece.decrypt(req.body, { version: 'aes128gcm', privateKey: p.ecdh, authSecret: p.auth.toString('base64url') });
  const payload = JSON.parse(plain.toString('utf8'));
  assert.equal(payload.title, 'Gold A&S');
  assert.match(payload.body, /התראות לטלפון פועלות/);
  // The VAPID token names this site and is signed by the key the browser was given.
  const jwt = req.headers.Authorization.match(/t=([^,]+)/)[1];
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.match(claims.sub, /^https:\/\//);
  assert.equal(req.headers.Authorization.match(/k=(.+)$/)[1], (await push.vapidKeys(db)).publicKey);
});

test('clean() keeps names and drops phone numbers and sums', () => {
  assert.equal(push.clean('Avi Cohen'), 'Avi Cohen');
  assert.equal(push.clean('להתקשר ל-+972 54-123-4567 היום'), 'להתקשר ל-… היום');
  assert.equal(push.clean('עמלה €50,000 ועוד 20,000 ₪ ו-1.5M'), 'עמלה … ועוד … ו-…');
  assert.equal(push.clean('משחק ב-19:30 מחזור 12'), 'משחק ב-19:30 מחזור 12');
});

test('the alert page a tap opens', () => {
  const { alertPath } = require('@goldas/domain');
  assert.equal(alertPath({ subject: { kind: 'player', id: 'p1' } }), '/players/p1');
  assert.equal(alertPath({ subject: { kind: 'deal', id: 'd1' } }), '/market/deals?deal=d1');
  assert.equal(alertPath({ subject: { kind: 'task', id: 't1' } }), '/tasks');
});
