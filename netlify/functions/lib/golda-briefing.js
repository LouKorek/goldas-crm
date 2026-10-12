// Golda's morning briefing and her urgent alerts, as WhatsApp text. Built
// from the same alerts engine the Home screen, Notifications and the daily
// email use, so everyone reads the same facts; no model call is needed.
const { israelDate } = require('@goldas/domain');

const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : String(s || ''); };
const APP = 'https://goldas-crm.netlify.app';

const SECTION = {
  job_failed: 'נכשל בלילה',
  deal_stale: 'עסקאות שמחכות יותר מדי',
  contract: 'חוזים שמסתיימים',
  repr: 'הסכמי ייצוג שמסתיימים',
  passport: 'דרכונים שפגים',
  requirement_expired: 'דרישות מועדון שפגו',
  task_overdue: 'משימות',
  birthday: 'ימי הולדת',
};
const ORDER = ['job_failed', 'deal_stale', 'contract', 'repr', 'passport', 'requirement_expired', 'task_overdue', 'birthday'];

const line = (a) => `• ${a.subject.name}: ${a.proof.he}${a.dueDate && a.type !== 'birthday' ? ` (${fmtDate(a.dueDate)})` : ''}`;

/**
 * buildBriefing({ name, alerts, games, goldaActions, now })
 *   alerts        the engine's alert list (matches included; they go under "today")
 *   games         [{ date, time, title, sub }] today's matches and trainings, sorted
 *   goldaActions  how many changes Golda made in the last 24 hours
 */
function buildBriefing({ name = 'לו', alerts = [], games = [], goldaActions = 0, now = new Date() }) {
  const today = israelDate(now);
  const out = [`*בוקר טוב, ${name}* ☀️ ${fmtDate(today)}`];
  const todays = games.filter((g) => g.date === today);
  out.push('');
  out.push(todays.length ? `*היום:*` : '*היום:* אין משחקים או אימונים.');
  for (const g of todays.slice(0, 8)) out.push(`• ${g.time ? `${g.time} · ` : ''}${g.title}${g.sub ? ` · ${g.sub}` : ''}`);
  if (todays.length > 8) out.push(`…ועוד ${todays.length - 8}`);

  const rest = alerts.filter((a) => a.type !== 'match');
  if (!rest.length) out.push('', '*דורש פעולה:* כלום. יום שקט 🙂');
  else {
    out.push('', `*דורש פעולה (${rest.length}):*`);
    for (const type of ORDER) {
      const list = rest.filter((a) => a.type === type);
      if (!list.length) continue;
      out.push(`_${SECTION[type]}_`);
      for (const a of list.slice(0, 5)) out.push(line(a));
      if (list.length > 5) out.push(`…ועוד ${list.length - 5}`);
    }
  }
  out.push('', goldaActions ? `ב-24 השעות האחרונות ביצעתי ${goldaActions === 1 ? 'שינוי אחד' : `${goldaActions} שינויים`} במערכת.` : 'ב-24 השעות האחרונות לא ביצעתי שינויים במערכת.');
  out.push(`הכל בבית: ${APP}/home/today`);
  return out.join('\n');
}

/** The alerts worth a message of their own, the hour they appear. */
function urgentAlerts(alerts) {
  return alerts.filter((a) => a.type === 'job_failed'
    || ((a.type === 'contract' || a.type === 'repr' || a.type === 'passport') && (a.overdue || a.days <= 7))
    || (a.type === 'birthday' && a.age === 18 && a.days === 0));
}

function buildUrgent(name, alerts) {
  const head = alerts.length === 1 ? `*${name}, שימי לב* ⚠️` : `*${name}, ${alerts.length} דברים שדורשים תשומת לב* ⚠️`;
  return [head, ...alerts.map(line), '', `פרטים: ${APP}/notifications`].join('\n').replace('שימי לב', name === 'לו' ? 'שים לב' : 'שימו לב');
}

module.exports = { buildBriefing, urgentAlerts, buildUrgent, fmtDate };
