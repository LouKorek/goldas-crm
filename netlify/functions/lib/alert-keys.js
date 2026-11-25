// One key per alert per threshold, shared by the daily email and Golda's
// WhatsApp alerts, so the same contract warns at 60, 30 and 7 days and then
// once more when it has passed, and a renewed contract (new date) starts over.
function dedupeKey(a, settings, today) {
  const dateTypes = { contract: 'contractDays', repr: 'reprDays', passport: 'passportDays' };
  if (dateTypes[a.type]) {
    const bucket = a.overdue ? 'overdue' : Math.min(...settings[dateTypes[a.type]].filter((t) => a.days <= t));
    return `${a.type}|${a.subject.id}|${a.dueDate}|${bucket}`;
  }
  if (a.type === 'birthday') return `birthday|${a.subject.id}|${today.slice(0, 4)}|${Math.min(...settings.birthdayDays.filter((t) => a.days <= t))}`;
  if (a.type === 'match') return `match|${a.subject.id}|${a.dueDate}`;
  if (a.type === 'deal_stale') return `deal_stale|${a.subject.id}|${a.record.enteredStageAt || ''}|${Math.floor(-a.days / settings.dealStaleDays)}`;
  if (a.type === 'requirement_expired') return `requirement_expired|${a.subject.id}|${a.dueDate}`;
  if (a.type === 'task_overdue') return `task_overdue|${a.subject.id}|${a.dueDate}|${a.overdue ? 'overdue' : 'due'}`;
  if (a.type === 'job_failed') return `job_failed|${a.subject.id}`;
  if (a.type === 'sync_mismatch') return `sync_mismatch|${a.subject.id}|${a.record?.autoFetch?.ifaFail?.teamId || ''}`;
  // Money owed: a late payment is told again every day until it is paid; a coming
  // one a week before and on the day. The key follows the payment, not the deal.
  if (a.type === 'payment_late') return `payment_late|${a.subject.id}|${a.payment?.id || ''}|${today}`;
  if (a.type === 'payment_due') return `payment_due|${a.subject.id}|${a.payment?.id || ''}|${a.dueDate}|${a.days === 0 ? 0 : 7}`;
  return `${a.type}|${a.subject.id}|${a.dueDate || ''}`;
}

const { can } = require('@goldas/domain');
const MONEY_TYPES = new Set(['payment_late', 'payment_due']);
/**
 * Money is for admins only: those who may see it get every alert, the others
 * the same list without the payment alerts. recipients: [{ email, role }] ->
 * [{ to: [emails], alerts }], one group per kind of reader that has something.
 * The daily email and the phone notifications (lib/push.js) both split here.
 */
function splitByRole(alerts, recipients) {
  const money = recipients.filter((r) => can(r.role, 'money')).map((r) => r.email);
  const others = recipients.filter((r) => !can(r.role, 'money')).map((r) => r.email);
  const plain = alerts.filter((a) => !MONEY_TYPES.has(a.type));
  return [{ to: money, alerts }, { to: others, alerts: plain }].filter((g) => g.to.length && g.alerts.length);
}

module.exports = { dedupeKey, splitByRole, MONEY_TYPES };
