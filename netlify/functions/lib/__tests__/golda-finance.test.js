// Money through Golda: payments (read) and payment_set (write) are for admins
// only; the write goes through her audited update so undo_last restores the
// deal's payments; the deal is found first and an ambiguous one is refused
// with the candidates. The alert destinations keep payment alerts to admins.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
delete process.env.SCRAPER_API_KEY;
const { fakeDb, stubFirestore } = require('./fake-firestore.js');

const admin = stubFirestore(() => null);
const { createTools, toolsFor, systemPrompt } = require('../wa-agent.js');
const { financeSection } = require('../golda-finance.js');
const { dedupeKey } = require('../alert-keys.js');
const { buildBriefing } = require('../golda-briefing.js');
const { computeAlerts, mergeSettings, israelDate, addDays } = require('@goldas/domain');
const { splitByRole } = require(path.join(__dirname, '..', '..', 'send-alerts.js'))._internal;

const LOU = { email: 'lou.korek@gmail.com', name: 'לו', role: 'admin', phone: '972500000001' };
const DANI = { email: 'dani@x.com', name: 'דני', role: 'manager', phone: '972500000002' };
const tools = (db, identity = LOU) => createTools({ db, admin, identity, media: null, session: { turn: 1 }, assistantName: 'גולדה', channel: 'whatsapp' });

const today = israelDate(new Date());
const P1 = { id: 'p1', label: 'עמלה', amount: 5000, currency: 'EUR', dueDate: addDays(today, -3), payer: { kind: 'club', name: 'מכבי חיפה' }, paidAt: null, paidAmount: null, note: '', createdBy: 'lou.korek@gmail.com', createdAt: '2026-11-01T00:00:00Z' };
const P2 = { ...P1, id: 'p2', label: 'תשלום שני', amount: 20000, currency: 'ILS', dueDate: addDays(today, 20), payer: { kind: 'player', name: 'Avi' } };
const seed = () => fakeDb({
  deals: {
    d1: { playerId: 'a', playerName: 'Avi Cohen', clubName: 'Maccabi Haifa', stage: 'Contract Signed', payments: [P1, P2] },
    d2: { playerId: 'b', playerName: 'Ben Levi', clubName: 'Maccabi Haifa', stage: 'Negotiation' },
    d3: { playerId: 'b', playerName: 'Ben Levi', clubName: 'Hapoel Tel Aviv', stage: 'Offered to Club' },
    d4: { playerId: 'c', playerName: 'Chen Gold', clubName: 'Beitar', stage: 'Not Relevant', payments: [{ ...P1, id: 'p9' }] },
    gone: { playerId: 'a', playerName: 'Avi Cohen', clubName: 'Bin FC', stage: 'Negotiation', deletedAt: 'x' },
  },
});

test('money is for admins only: the tools, the prompt and the deal records', async () => {
  const names = (role) => toolsFor(role).map((x) => x.name);
  assert.ok(names('admin').includes('payments'));
  assert.ok(names('admin').includes('payment_set'));
  for (const role of ['manager', 'viewer']) {
    assert.ok(!names(role).includes('payments'), `${role} has no payments tool`);
    assert.ok(!names(role).includes('payment_set'), `${role} has no payment_set tool`);
  }
  const db = seed();
  await assert.rejects(tools(db, DANI).run('payments', {}), /money is for admins only/);
  await assert.rejects(tools(db, DANI).run('payment_set', { action: 'add', dealId: 'd2', amount: 1, currency: 'EUR', dueDate: '2027-01-31' }), /money is for admins only/);
  // A manager reading a deal does not see its payments, and cannot write them with update.
  const g = await tools(db, DANI).run('get', { collection: 'deals', id: 'd1' });
  assert.equal(g.payments, undefined);
  assert.equal(g.playerName, 'Avi Cohen');
  const l = await tools(db, DANI).run('list', { collection: 'deals', fields: ['*'] });
  assert.ok(l.rows.every((r) => r.payments === undefined));
  await assert.rejects(tools(db, DANI).run('update', { collection: 'deals', id: 'd2', data: { payments: [P1] } }), /nothing to change/);
  assert.equal(db.read('deals', 'd2').payments, undefined);
  // The admin sees them.
  assert.equal((await tools(db).run('get', { collection: 'deals', id: 'd1' })).payments.length, 2);
  assert.match(systemPrompt('גולדה', LOU), /payment_set action=add/);
  assert.ok(!/payment_set/.test(systemPrompt('גולדה', DANI)));
  assert.match(financeSection('viewer'), /only Lou can see it/);
});

test('payments: rows with status and totals per currency, never added across currencies', async () => {
  const r = await tools(seed()).run('payments', {});
  assert.equal(r.count, 3);
  assert.deepEqual(r.rows.map((x) => [x.paymentId, x.status]), [['p1', 'late'], ['p9', 'late'], ['p2', 'scheduled']]);
  assert.equal(r.rows[1].dealNotRelevant, true);
  assert.deepEqual(Object.keys(r.totals).sort(), ['EUR', 'ILS']);
  assert.equal(r.totals.EUR.lateNow, 5000, 'the Not Relevant deal is out of the totals');
  assert.equal(r.totals.ILS.lateNow, 0);
  const late = await tools(seed()).run('payments', { status: 'late' });
  assert.deepEqual(late.rows.map((x) => x.paymentId), ['p1']);
  assert.deepEqual(late.totalsOfThese, { EUR: { owed: 5000, paid: 0, count: 1 } });
  assert.match(late.rows[0].line, /^€5,000 ממכבי חיפה \(עמלה\) באיחור של 3 ימים$/);
  const byClub = await tools(seed()).run('payments', { club: 'maccabi', status: 'unpaid' });
  assert.deepEqual(byClub.rows.map((x) => x.paymentId), ['p1', 'p2']);
  const month = await tools(seed()).run('payments', { month: P2.dueDate.slice(0, 7) });
  assert.ok(month.rows.some((x) => x.paymentId === 'p2'));
  assert.ok(month.cashFlow.ILS.expected >= 20000);
});

test('payment_set add: finds the deal by player and club, saves through the audited update, undo removes it', async () => {
  const db = seed();
  const t = tools(db);
  const r = await t.run('payment_set', { action: 'add', player: 'ben', club: 'maccabi', label: 'עמלה', amount: 5000, currency: 'EUR', dueDate: '2027-01-31', payerKind: 'club', payerName: 'מכבי חיפה' });
  assert.equal(r.saved, true);
  assert.equal(r.dealId, 'd2');
  assert.equal(r.payment.status, 'scheduled');
  assert.match(r.link, /\/market\/deals\?deal=d2$/);
  const saved = db.read('deals', 'd2').payments;
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].amount, saved[0].currency, saved[0].dueDate, saved[0].payer, saved[0].createdBy], [5000, 'EUR', '2027-01-31', { kind: 'club', name: 'מכבי חיפה' }, 'lou.korek@gmail.com']);
  const audit = db.all('audit');
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].collection, audit[0].docId, audit[0].fields, audit[0].via], ['update', 'deals', 'd2', ['payments'], 'golda']);
  assert.equal(audit[0].before.payments, null);
  const u = await t.run('undo_last', {});
  assert.equal(u.undone, 'update');
  assert.equal(db.read('deals', 'd2').payments, undefined);
});

test('payment_set never invents: a missing amount, currency or date is refused', async () => {
  const db = seed();
  await assert.rejects(tools(db).run('payment_set', { action: 'add', dealId: 'd2', currency: 'EUR', dueDate: '2027-01-31' }), /amount must be a number above 0/);
  await assert.rejects(tools(db).run('payment_set', { action: 'add', dealId: 'd2', amount: 5000, dueDate: '2027-01-31' }), /currency must be one of/);
  await assert.rejects(tools(db).run('payment_set', { action: 'add', dealId: 'd2', amount: 5000, currency: 'EUR' }), /dueDate must be YYYY-MM-DD/);
  assert.equal(db.all('audit').length, 0);
});

test('an ambiguous deal is refused with the candidates; no deal on record says so', async () => {
  const db = seed();
  const amb = await tools(db).run('payment_set', { action: 'add', player: 'Ben Levi', amount: 1000, currency: 'EUR', dueDate: '2027-01-31' });
  assert.equal(amb.ambiguous, true);
  assert.deepEqual(amb.candidates.map((c) => [c.dealId, c.club]).sort(), [['d2', 'Maccabi Haifa'], ['d3', 'Hapoel Tel Aviv']]);
  const none = await tools(db).run('payment_set', { action: 'add', player: 'Nobody', club: 'Maccabi', amount: 1000, currency: 'EUR', dueDate: '2027-01-31' });
  assert.equal(none.noDeal, true);
  assert.match(none.instruction, /offer to open the deal/);
  // A deal in the recycle bin is not a candidate.
  const bin = await tools(db).run('payment_set', { action: 'add', player: 'Avi', club: 'Bin', amount: 1, currency: 'EUR', dueDate: '2027-01-31' });
  assert.equal(bin.noDeal, true);
  assert.equal(db.all('audit').length, 0);
  assert.equal(db.read('deals', 'd2').payments, undefined);
});

test('mark paid in full, then undo restores the payment as it was', async () => {
  const db = seed();
  const t = tools(db);
  // Both payments on the deal are unpaid, so without a paymentId it asks which one.
  const ask = await t.run('payment_set', { action: 'mark_paid', dealId: 'd1' });
  assert.equal(ask.needsChoice, true);
  assert.deepEqual(ask.payments.map((p) => p.paymentId), ['p1', 'p2']);
  const r = await t.run('payment_set', { action: 'mark_paid', dealId: 'd1', paymentId: 'p1' });
  assert.equal(r.payment.status, 'paid');
  assert.equal(r.payment.paidAt, today, 'paid today by default');
  const after = db.read('deals', 'd1').payments.find((p) => p.id === 'p1');
  assert.deepEqual([after.paidAt, after.paidAmount], [today, null]);
  assert.equal(db.read('deals', 'd1').payments.find((p) => p.id === 'p2').paidAt, null, 'the other payment is untouched');
  await t.run('undo_last', {});
  assert.deepEqual(db.read('deals', 'd1').payments, [P1, P2]);
});

test('a partial payment, then the rest with paidNow', async () => {
  const db = seed();
  const t = tools(db);
  const r = await t.run('payment_set', { action: 'mark_paid', dealId: 'd1', paymentId: 'p1', paidNow: 2000, paidAt: today });
  assert.deepEqual([r.payment.status, r.payment.paid, r.payment.outstanding, r.payment.partial], ['late', 2000, 3000, true]);
  const second = await t.run('payment_set', { action: 'mark_paid', dealId: 'd1', paymentId: 'p1', paidNow: 3000 });
  assert.equal(second.payment.status, 'paid');
  assert.equal(db.read('deals', 'd1').payments.find((p) => p.id === 'p1').paidAmount, null, 'all of it came in');
  await assert.rejects(t.run('payment_set', { action: 'mark_paid', dealId: 'd1', paymentId: 'p2', paidNow: -1 }), /paidNow must be a number above 0/);
});

test('update and delete: delete waits for the yes, and undo brings it back', async () => {
  const db = seed();
  const t = tools(db);
  const u = await t.run('payment_set', { action: 'update', dealId: 'd1', paymentId: 'p2', dueDate: '2027-03-31', amount: 25000 });
  assert.deepEqual([u.payment.dueDate, u.payment.amount, u.payment.currency, u.payment.payer.name], ['2027-03-31', 25000, 'ILS', 'Avi']);
  const db2 = seed();
  const t2 = tools(db2);
  const ask = await t2.run('payment_set', { action: 'delete', dealId: 'd1', paymentId: 'p2' });
  assert.equal(ask.needsConfirmation, true);
  assert.equal(db2.read('deals', 'd1').payments.length, 2);
  const del = await t2.run('payment_set', { action: 'delete', dealId: 'd1', paymentId: 'p2', confirmed: true });
  assert.equal(del.deleted.paymentId, 'p2');
  assert.deepEqual(db2.read('deals', 'd1').payments.map((p) => p.id), ['p1']);
  await t2.run('undo_last', {});
  assert.deepEqual(db2.read('deals', 'd1').payments, [P1, P2]);
  await assert.rejects(t2.run('payment_set', { action: 'update', dealId: 'd1', paymentId: 'zz', amount: 1 }), /no payment zz/);
});

test('alerts_today: the admin hears about money, a manager does not', async () => {
  const db = seed();
  const lou = await tools(db).run('alerts_today', {});
  assert.ok(lou.alerts.some((a) => a.type === 'payment_late' && a.id === 'd1'));
  const dani = await tools(db, DANI).run('alerts_today', {});
  assert.ok(!dani.alerts.some((a) => a.type.startsWith('payment')));
});

test('the email: payment alerts only in the admins\' copy; keys repeat a late payment daily', () => {
  const deals = [{ id: 'd1', playerName: 'Avi', clubName: 'Maccabi', stage: 'Contract Signed', payments: [P1, { ...P2, id: 'soon', dueDate: today }] }];
  const players = [{ id: 'a', fullName: 'Avi', contractEnd: addDays(today, 5), contractStatus: 'Under Contract' }];
  const r = computeAlerts({ deals, players, money: true });
  assert.deepEqual(r.alerts.map((a) => a.type).sort(), ['contract', 'payment_due', 'payment_late']);
  const groups = splitByRole(r.alerts, [{ email: 'lou@x.com', role: 'admin' }, { email: 'dani@x.com', role: 'manager' }, { email: 'v@x.com', role: 'viewer' }]);
  assert.deepEqual(groups.map((g) => [g.to, g.alerts.map((a) => a.type).sort()]), [
    [['lou@x.com'], ['contract', 'payment_due', 'payment_late']],
    [['dani@x.com', 'v@x.com'], ['contract']],
  ]);
  // Only money, only managers: no email at all.
  assert.deepEqual(splitByRole(r.alerts.filter((a) => a.type.startsWith('payment')), [{ email: 'dani@x.com', role: 'manager' }]), []);
  const settings = mergeSettings({});
  const late = r.alerts.find((a) => a.type === 'payment_late');
  assert.equal(dedupeKey(late, settings, '2026-11-25'), 'payment_late|d1|p1|2026-11-25');
  assert.notEqual(dedupeKey(late, settings, '2026-11-25'), dedupeKey(late, settings, '2026-11-26'), 'told again the next day');
  const due = r.alerts.find((a) => a.type === 'payment_due');
  assert.equal(dedupeKey(due, settings, today), `payment_due|d1|soon|${today}|0`);
});

test('the briefing lists late payments for an admin only', () => {
  const deals = [{ id: 'd1', playerName: 'Avi', clubName: 'Maccabi', stage: 'Contract Signed', payments: [P1] }];
  const forLou = buildBriefing({ name: 'לו', alerts: computeAlerts({ deals, money: true }).alerts });
  assert.match(forLou, /_תשלומים באיחור_\n• Avi ↔ Maccabi: €5,000 ממכבי חיפה \(עמלה\) באיחור של 3 ימים/);
  const forDani = buildBriefing({ name: 'דני', alerts: computeAlerts({ deals, money: false }).alerts });
  assert.ok(!/תשלומים/.test(forDani));
});
