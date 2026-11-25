import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  paymentRows, financeTotals, cashFlow, currenciesIn, filterPayments, addMonths, formatMoney, israelDate, PAYMENT_FILTERS,
} from '@goldas/domain';
import { listenDeals } from 'data/deals';
import { useCan } from 'lib/roleContext';
import { fmtDate } from 'lib/constants';
import { t, getLang } from 'lib/i18n';
import { MultiLine, PALETTE } from 'lib/charts/Charts';
import { PageHeader, Empty, Skeleton, ChipGroup, SortTh } from 'components/ui/UI';
import { PayStatus, rowMoney } from 'components/finance/PaymentBits';

// Finance (admin only): what is expected this month, what is late, what came
// in this year, the cash flow by month and every payment on every deal. The
// numbers come from engines/finance.ts; payments live on the deal record and
// are added from the deal's dialog on the Deals board.

const MONTHS_BACK = 3;
const MONTHS_AHEAD = 6;
const FILTER_LABEL = { late: 'Late', month: 'This month', upcoming: 'Upcoming', paid: 'Paid', all: 'All' };

const monthLabel = (month, lang) =>
  new Date(`${month}-01T12:00:00Z`).toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

// The chart's axis and legend: €12k rather than €12,000, so it fits a phone.
const THOUSAND = 1000;
const compact = (v, cur) => (Math.abs(v) >= THOUSAND
  ? `${formatMoney(Math.round((v / THOUSAND) * 10) / 10, cur)}k`
  : formatMoney(v, cur));

const usePhone = () => {
  const q = '(max-width: 768px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = (e) => setPhone(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
};

const dealLink = (r) => `/market/deals?deal=${encodeURIComponent(r.dealId)}`;
const countLine = (n) => (n === 1 ? t('1 payment') : t('{n} payments', { n }));

function Kpi({ label, value, sub, tone }) {
  return (
    // The card stacks bottom-up (column-reverse): label, figure, then the line under it.
    <div className="kpi-card">
      {sub && <div className="m-sub">{sub}</div>}
      <div className="kpi-value" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

export default function Finance() {
  const money = useCan('money');
  const navigate = useNavigate();
  const [deals, setDeals] = useState(null);
  const [currency, setCurrency] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState({ field: 'dueDate', dir: 'asc' });
  const lang = getLang();
  const phone = usePhone();
  useEffect(() => (money ? listenDeals({}, setDeals) : undefined), [money]);

  const now = useMemo(() => new Date(), [deals]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => paymentRows(deals, now), [deals, now]);
  const currencies = useMemo(() => currenciesIn(rows), [rows]);
  const totals = useMemo(() => financeTotals(rows, now), [rows, now]);
  // Until one is picked, the currency with the most payments.
  const busiest = currencies.reduce((best, c) => (rows.filter((r) => r.payment.currency === c).length > rows.filter((r) => r.payment.currency === best).length ? c : best), currencies[0]);
  const cur = currencies.includes(currency) ? currency : busiest;
  const tot = totals[cur];
  const others = (key) => currencies.filter((c) => c !== cur && totals[c]?.[key]).map((c) => formatMoney(totals[c][key], c)).join(' · ');

  const counts = useMemo(() => Object.fromEntries(PAYMENT_FILTERS.map((f) => [f, filterPayments(rows, f, now).length])), [rows, now]);
  const active = filter || (counts.late ? 'late' : 'upcoming');
  const list = useMemo(() => {
    const out = filterPayments(rows, active, now);
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = (r) => (sort.field === 'paidAt' ? r.payment.paidAt || '' : r.payment.dueDate);
    return [...out].sort((a, b) => dir * key(a).localeCompare(key(b)));
  }, [rows, active, now, sort]);

  const series = useMemo(() => {
    if (!cur) return [];
    const from = addMonths(israelDate(now).slice(0, 7), -MONTHS_BACK);
    const months = cashFlow(rows, { from, months: MONTHS_BACK + MONTHS_AHEAD + 1, now });
    const line = (id, he, en, color) => {
      const points = months.map((m) => ({ key: m.month, label: { he: monthLabel(m.month, 'he'), en: monthLabel(m.month, 'en') }, value: m.byCurrency[cur]?.[id] || 0 }));
      return { id, label: { he, en }, color, total: points.reduce((n, p) => n + p.value, 0), points };
    };
    return [
      line('expected', 'צפוי', 'Expected', PALETTE[0]),
      line('paid', 'שולם', 'Paid', PALETTE[2]),
      line('late', 'באיחור', 'Late', PALETTE[5]),
    ];
  }, [rows, cur, now]);

  if (!money) return <Navigate to="/home" replace />;
  if (!deals) return <Skeleton rows={6} />;

  const header = (
    <PageHeader title={t('Finance')} subtitle={rows.length ? t('{n} payments on {d} deals', { n: rows.length, d: new Set(rows.map((r) => r.dealId)).size }) : ''}>
      {currencies.length > 1 && (
        <div style={{ marginTop: 12 }}>
          <ChipGroup options={currencies} labels={currencies} value={cur} onChange={setCurrency} required />
        </div>
      )}
    </PageHeader>
  );

  if (!rows.length) {
    return (
      <div>
        {header}
        <Empty message={t('No payments yet. Open a deal on the Deals board and press "Add payment" in its Payments section: one row for each sum that should come in, with its amount, currency and due date.')}
          action={<Link className="btn btn-primary" to="/market/deals">{t('Go to deals')}</Link>} />
      </div>
    );
  }

  return (
    <div>
      {header}

      <div className="kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
        <Kpi label={t('Expected this month')} value={formatMoney(tot?.expectedThisMonth || 0, cur)}
          sub={[tot?.dueThisMonthCount ? countLine(tot.dueThisMonthCount) : '', others('expectedThisMonth')].filter(Boolean).join(' · ')} />
        <Kpi label={t('Late now')} value={formatMoney(tot?.lateNow || 0, cur)} tone={tot?.lateNow ? 'var(--red)' : undefined}
          sub={[tot?.lateCount ? countLine(tot.lateCount) : '', others('lateNow')].filter(Boolean).join(' · ')} />
        <Kpi label={t('Paid this year')} value={formatMoney(tot?.paidThisYear || 0, cur)} tone={tot?.paidThisYear ? 'var(--green-ok)' : undefined}
          sub={others('paidThisYear')} />
      </div>

      <div className="card card-body" style={{ padding: 14, marginBottom: 18 }}>
        <div className="section-label" style={{ marginBottom: 8 }}>{t('Cash flow by month')} · {cur}</div>
        <MultiLine series={series} lang={lang === 'he' ? 'he' : 'en'} title={t('Cash flow by month')} format={(v) => compact(v, cur)}
          width={phone ? 400 : 760} height={phone ? 240 : 220} />
        <div className="form-hint" style={{ marginTop: 6 }}>{t('Expected: what falls due in the month. Paid: what came in that month. Late: what fell due and is still owed.')}</div>
      </div>

      <div style={{ marginBottom: 12, overflowX: 'auto' }}>
        <div className="chip-group" style={{ flexWrap: 'nowrap' }}>
          {PAYMENT_FILTERS.map((f) => (
            <button key={f} type="button" className={`chip${active === f ? ' active' : ''}`} onClick={() => setFilter(f)} style={{ flex: '0 0 auto' }}>
              {t(FILTER_LABEL[f])}<span className="chip-count">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? <Empty message={t('Nothing here.')} /> : (<>
        <div className="mobile-cards">
          {list.map((r) => (
            <Link key={`${r.dealId}-${r.payment.id}`} to={dealLink(r)} className="m-card" style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.playerName} ↔ {r.clubName}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{rowMoney(r)}</span>
              </div>
              <div className="m-meta" style={{ marginTop: 6 }}>
                <span>{t('Due')} {fmtDate(r.payment.dueDate)}</span>
                {(r.payment.label || r.payment.payer.name) && <span className="m-sub">{[r.payment.label, r.payment.payer.name].filter(Boolean).join(' · ')}</span>}
                <PayStatus row={r} />
              </div>
            </Link>
          ))}
        </div>
        <div className="card desktop-table" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortTh label={t('Due date')} field="dueDate" sort={sort} setSort={setSort} />
                  <th>{t('Deal')}</th>
                  <th>{t('What')}</th>
                  <th>{t('Amount')}</th>
                  <SortTh label={t('Paid on')} field="paidAt" sort={sort} setSort={setSort} />
                  <th>{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={`${r.dealId}-${r.payment.id}`} onClick={() => navigate(dealLink(r))} style={{ cursor: 'pointer' }}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.payment.dueDate)}</td>
                    <td><Link to={dealLink(r)} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit' }}>{r.playerName} ↔ {r.clubName}</Link></td>
                    <td>{r.payment.label || '—'}{r.payment.payer.name && <span style={{ color: 'var(--text-3)' }}> · {r.payment.payer.name}</span>}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      {rowMoney(r)}
                      {r.partial && <div className="m-sub">{t('{x} of {y} received', { x: formatMoney(r.paid, r.payment.currency), y: formatMoney(r.payment.amount, r.payment.currency) })}</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.payment.paidAt ? fmtDate(r.payment.paidAt) : '—'}</td>
                    <td><PayStatus row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>)}
    </div>
  );
}
