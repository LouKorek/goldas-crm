// Money through Golda: the payments on deals (deal.payments, shape and rules
// in packages/domain/src/engines/finance.ts), for admins only (can(role, 'money')).
//
// 1. payments: who owes what. Rows with their status and the totals per
//    currency (due this month, late now, paid this year), never added across
//    currencies and never converted. Filters: status, month, player, club, deal.
// 2. payment_set: add a payment to a deal, change it, mark it paid (fully or
//    in part), delete it. The deal is found first (by id, or by the player and
//    the club); when several deals fit, nothing is written and the candidates
//    come back; when none does, she says so and offers to open the deal. The
//    write goes through wa-agent's own `update` (the whole payments list of
//    the deal), so it is audited like any edit and undo_last restores the list.
const { can, israelDate, cleanPayment, paymentRows, financeTotals, filterPayments, cashFlow, describePayment, paymentsOf,
  paymentStatus, paidSoFar, currenciesIn, CURRENCIES, PAYER_KINDS } = require('@goldas/domain');

const APP = 'https://goldas-crm.netlify.app';
const MAX_ROWS = 100;
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const has = (hay, q) => { const words = norm(q).split(' ').filter(Boolean); const h = norm(hay); return words.every((w) => h.includes(w)); };
const dealLink = (id) => `${APP}/market/deals?deal=${id}`;

const PAYMENTS_TOOL_DEFS = [
  {
    name: 'payments',
    description: "Money the agency is owed on deals (admins only). Returns payments with their status (paid, partial, late, due_soon = within 7 days, scheduled), what is still owed, and the totals per currency: still owed this month, late now, paid this year. Never add amounts of different currencies and never convert them. Filters: status, month (YYYY-MM: payments due that month, plus that month's cash flow), player, club, dealId. Use for \"מי חייב לנו\", \"מה באיחור\", \"כמה צפוי להיכנס החודש\", \"כמה נכנס השנה\".",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['late', 'due_soon', 'upcoming', 'unpaid', 'paid', 'all'], description: 'upcoming = owed and not yet due; unpaid = anything still owed. Default all.' },
        month: { type: 'string', description: 'YYYY-MM; "החודש" = the current month in Israel.' },
        player: { type: 'string' }, club: { type: 'string' }, dealId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'payment_set',
    description: "Add, change, mark paid or delete one payment on a deal (admins only). Find the deal by dealId, or pass player and/or club and the tool finds it: several fitting deals → nothing is saved and the candidates come back (ask which); none → nothing is saved (say there is no such deal and offer to open it). Amounts, currencies and dates only as the writer said them: never invent or convert. mark_paid: paidAt defaults to today; a partial payment with paidNow (this installment) or paidAmount (the total paid so far). delete needs confirmed=true after the writer's yes. Audited; undo_last restores the deal's payments.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'mark_paid', 'delete'] },
        dealId: { type: 'string' },
        player: { type: 'string', description: 'To find the deal when dealId is not known.' },
        club: { type: 'string', description: 'To find the deal when dealId is not known.' },
        paymentId: { type: 'string', description: 'Which payment (from payments or a previous answer). Not needed when the deal has only one that fits.' },
        label: { type: 'string', description: 'What it is for, short: "עמלה", "תשלום ראשון", "בונוס חתימה".' },
        amount: { type: 'number' },
        currency: { type: 'string', enum: [...CURRENCIES] },
        dueDate: { type: 'string', description: 'YYYY-MM-DD. "עד סוף ינואר" = the last day of January.' },
        payerKind: { type: 'string', enum: [...PAYER_KINDS] },
        payerName: { type: 'string', description: 'Who pays: the club, the player or someone else, by name.' },
        paidAt: { type: 'string', description: 'YYYY-MM-DD; default today.' },
        paidAmount: { type: 'number', description: 'Total paid so far, for a partial payment.' },
        paidNow: { type: 'number', description: 'This installment, added to what was paid before.' },
        note: { type: 'string' },
        confirmed: { type: 'boolean', description: 'delete only: true after the writer said yes.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

/** A row as Golda reads it. */
const rowOut = (r) => ({
  dealId: r.dealId, player: r.playerName, club: r.clubName, paymentId: r.payment.id, label: r.payment.label,
  amount: r.payment.amount, currency: r.payment.currency, dueDate: r.payment.dueDate, payer: r.payment.payer,
  status: r.status, paid: r.paid, outstanding: r.outstanding, partial: r.partial, daysLate: r.daysLate, daysLeft: r.daysLeft,
  paidAt: r.payment.paidAt, ...(r.excluded ? { dealNotRelevant: true } : {}), line: describePayment(r).he, link: dealLink(r.dealId),
});

const STATUS_FILTER = {
  late: (r) => !r.excluded && r.status === 'late',
  due_soon: (r) => !r.excluded && r.status === 'due_soon',
  upcoming: (r) => !r.excluded && r.outstanding > 0 && r.days >= 0,
  unpaid: (r) => !r.excluded && r.outstanding > 0,
  paid: (r) => r.paid > 0,
  all: () => true,
};

/**
 * financeTools({ db, identity, role, update })
 *   update  wa-agent's own update tool, so the write is audited and undoable like any other.
 */
function financeTools({ db, identity = {}, role, update }) {
  const need = () => { if (!can(role, 'money')) throw new Error(`${identity.name || 'the writer'} is a ${role || 'viewer'}; money is for admins only`); };
  const liveDeals = async () => (await db.collection('deals').get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => !d.deletedAt);

  async function findDeal({ dealId, player, club }) {
    if (dealId) {
      const s = await db.collection('deals').doc(String(dealId)).get();
      if (!s.exists || s.data().deletedAt) throw new Error('deal not found');
      return { deal: { id: s.id, ...s.data() } };
    }
    if (!player && !club) throw new Error('pass dealId, or the player and/or the club of the deal');
    const fit = (await liveDeals()).filter((d) => (!player || has(d.playerName, player)) && (!club || has(d.clubName, club)));
    // A deal closed as Not Relevant is a candidate only when nothing else fits.
    const live = fit.filter((d) => d.stage !== 'Not Relevant');
    const pool = live.length ? live : fit;
    if (pool.length === 1) return { deal: pool[0] };
    if (!pool.length) return { none: true };
    return { candidates: pool.map((d) => ({ dealId: d.id, player: d.playerName || '', club: d.clubName || '', stage: d.stage || '', link: dealLink(d.id) })) };
  }

  /** Which payment of the deal: by id, or the only one that fits. */
  function pick(list, paymentId, fits = () => true) {
    if (paymentId) {
      const p = list.find((x) => x.id === paymentId);
      if (!p) throw new Error(`no payment ${paymentId} on this deal; its payments: ${list.map((x) => `${x.id} (${x.label || x.dueDate})`).join(', ') || 'none'}`);
      return { payment: p };
    }
    const options = list.filter(fits);
    if (options.length === 1) return { payment: options[0] };
    return { choose: options.map((p) => ({ paymentId: p.id, label: p.label, amount: p.amount, currency: p.currency, dueDate: p.dueDate, status: paymentStatus(p).status })) };
  }

  const fields = (input) => {
    const out = {};
    for (const k of ['label', 'amount', 'currency', 'dueDate', 'paidAt', 'paidAmount', 'note']) if (input[k] !== undefined && input[k] !== '') out[k] = input[k];
    if (input.payerKind !== undefined || input.payerName !== undefined) out.payer = { kind: input.payerKind, name: input.payerName };
    return out;
  };

  async function save(deal, payments, action, payment) {
    await update({ collection: 'deals', id: deal.id, data: { payments } });
    const row = payment ? paymentRows([{ ...deal, payments: [payment] }])[0] : null;
    return {
      saved: true, action, dealId: deal.id, deal: `${deal.playerName || ''} ↔ ${deal.clubName || ''}`,
      ...(row ? { payment: rowOut(row) } : {}), paymentsOnDeal: payments.length, link: dealLink(deal.id),
      note: 'Confirm in one line what you saved (amount with its currency, from whom, when, status). undo_last reverses it.',
    };
  }

  return {
    payments: async (input = {}) => {
      need();
      const now = new Date();
      let deals = await liveDeals();
      if (input.dealId) deals = deals.filter((d) => d.id === input.dealId);
      if (input.player) deals = deals.filter((d) => has(d.playerName, input.player));
      if (input.club) deals = deals.filter((d) => has(d.clubName, input.club));
      const all = paymentRows(deals, now);
      let rows = all.filter(STATUS_FILTER[input.status] || STATUS_FILTER.all);
      if (input.month) {
        if (!/^\d{4}-\d{2}$/.test(String(input.month))) throw new Error('month is YYYY-MM');
        rows = rows.filter((r) => r.payment.dueDate.slice(0, 7) === input.month);
      }
      const selected = Object.fromEntries(currenciesIn(rows).map((c) => {
        const mine = rows.filter((r) => r.payment.currency === c && !r.excluded);
        return [c, { owed: mine.reduce((n, r) => n + r.outstanding, 0), paid: mine.reduce((n, r) => n + r.paid, 0), count: mine.length }];
      }));
      return {
        today: israelDate(now), count: rows.length, rows: rows.slice(0, MAX_ROWS).map(rowOut), ...(rows.length > MAX_ROWS ? { more: rows.length - MAX_ROWS } : {}),
        totalsOfThese: selected,
        totals: financeTotals(all, now),
        ...(input.month ? { cashFlow: cashFlow(all, { from: input.month, months: 1, now })[0].byCurrency } : {}),
        rule: 'Totals are per currency. Never add different currencies together and never convert.',
        ...(rows.length ? {} : { note: filterPayments(all, 'all', now).length ? 'Nothing matches these filters.' : 'No payments are recorded yet. A payment is added to a deal (payment_set add) or on the deal in the app.' }),
      };
    },

    payment_set: async (input = {}) => {
      need();
      if (typeof update !== 'function') throw new Error('payment_set is not wired');
      const { action } = input;
      if (!['add', 'update', 'mark_paid', 'delete'].includes(action)) throw new Error('action is add, update, mark_paid or delete');
      const found = await findDeal(input);
      if (found.none) {
        return { noDeal: true, instruction: `There is no deal on record${input.player ? ` for ${input.player}` : ''}${input.club ? ` with ${input.club}` : ''}. Nothing was saved. Say so, and offer to open the deal (create in deals: playerId and clubName) and then add the payment. Never invent a deal.` };
      }
      if (found.candidates) {
        return { ambiguous: true, candidates: found.candidates, instruction: 'Several deals fit; nothing was saved. Ask which one (player, club, stage), then call payment_set again with its dealId.' };
      }
      const deal = found.deal;
      const list = paymentsOf(deal);
      const by = identity.email || '';

      if (action === 'add') {
        const c = cleanPayment({ ...fields(input), payer: { kind: input.payerKind || 'other', name: input.payerName || '' } }, { by });
        if (!c.ok) throw new Error(`not saved: ${c.errors.join('; ')}. Ask the writer for what is missing; never guess it.`);
        return save(deal, [...list, c.payment], 'added', c.payment);
      }

      const chosen = pick(list, input.paymentId, action === 'mark_paid' ? (p) => paidSoFar(p) < p.amount : () => true);
      if (chosen.choose) {
        return chosen.choose.length
          ? { needsChoice: true, payments: chosen.choose, instruction: 'Several payments on this deal fit; ask which one, then call again with its paymentId.' }
          : { nothing: true, instruction: action === 'mark_paid' ? 'Every payment on this deal is already paid.' : 'This deal has no payments yet.' };
      }
      const before = chosen.payment;

      if (action === 'delete') {
        if (input.confirmed !== true) {
          return { needsConfirmation: true, wouldDelete: rowOut(paymentRows([{ ...deal, payments: [before] }])[0]), instruction: 'Show the writer the payment and ask once; after the yes in a new message, call again with confirmed=true.' };
        }
        return { ...(await save(deal, list.filter((p) => p.id !== before.id), 'deleted', null)), deleted: { paymentId: before.id, label: before.label, amount: before.amount, currency: before.currency, dueDate: before.dueDate } };
      }

      let next;
      if (action === 'mark_paid') {
        const paidAt = input.paidAt || israelDate(new Date());
        const sofar = before.paidAt ? (before.paidAmount ?? before.amount) : 0;
        const total = input.paidNow !== undefined ? sofar + Number(input.paidNow) : input.paidAmount;
        if (input.paidNow !== undefined && !(Number(input.paidNow) > 0)) throw new Error('paidNow must be a number above 0');
        next = { ...before, paidAt, paidAmount: total === undefined ? null : total };
      } else {
        const f = fields(input);
        next = { ...before, ...f, payer: f.payer ? { kind: f.payer.kind || before.payer.kind, name: f.payer.name ?? before.payer.name } : before.payer };
      }
      const c = cleanPayment(next, { by });
      if (!c.ok) throw new Error(`not saved: ${c.errors.join('; ')}`);
      return save(deal, list.map((p) => (p.id === before.id ? c.payment : p)), action === 'mark_paid' ? 'marked paid' : 'updated', c.payment);
    },
  };
}

/** Her line about money in the system prompt: the whole of it for an admin, one sentence for anyone else. */
function financeSection(role) {
  if (!can(role, 'money')) return '- Money (payments on deals, what clubs or players owe the agency) is for admins only: you do not see it for this writer; if asked, say only Lou can see it.';
  return '- Money on deals (admins only): "מי חייב לנו" / "מה באיחור" / "כמה צפוי להיכנס החודש" / "כמה נכנס השנה" → payments (status late, month YYYY-MM for this month, player or club when named) and answer per currency, never adding currencies together and never converting. "מכבי חייבת לנו 5,000 אירו עד סוף ינואר על העסקה של X" / "תוסיפי תשלום…" → payment_set action=add with the player and the club (or the dealId) as said: amount, currency, dueDate (resolve "סוף ינואר" to the last day of the coming January), payerKind and payerName. "מכבי שילמה את ה-5,000" → payment_set action=mark_paid (paidAt today unless a date was said; part of it → paidNow). The tool finds the deal: ask only when it returns several candidates. When it says there is no such deal, say so and offer to open the deal (create in deals), then add the payment; never invent a deal. Never invent an amount, a currency or a date: ask for the missing one in one short question. Deleting a payment needs the writer\'s yes (confirmed=true in a later message). After saving, confirm in one line what you saved (e.g. "שמרתי: €5,000 ממכבי חיפה עד 31/1, עמלה על העסקה של X") with the link to the deal.';
}

module.exports = { financeTools, financeSection, PAYMENTS_TOOL_DEFS };
