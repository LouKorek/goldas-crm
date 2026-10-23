// Golda's morning briefing and her urgent alerts, as WhatsApp text. Built
// from the same alerts engine the Home screen, Notifications and the daily
// email use, so everyone reads the same facts; no model call is needed.
const { israelDate } = require('@goldas/domain');

const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : String(s || ''); };
const APP = 'https://goldas-crm.netlify.app';

const SECTION = {
  job_failed: 'נכשל בלילה',
  sync_mismatch: 'הסנכרון לא קישר משחקים',
  deal_stale: 'עסקאות שמחכות יותר מדי',
  contract: 'חוזים שמסתיימים',
  repr: 'הסכמי ייצוג שמסתיימים',
  passport: 'דרכונים שפגים',
  requirement_expired: 'דרישות מועדון שפגו',
  task_overdue: 'משימות',
  birthday: 'ימי הולדת',
};
const ORDER = ['job_failed', 'sync_mismatch', 'deal_stale', 'contract', 'repr', 'passport', 'requirement_expired', 'task_overdue', 'birthday'];

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

/**
 * Operations alerts for the admins, from what the system already records:
 *   - a job whose last two runs both failed (one failure is an ordinary alert);
 *   - the ScraperAPI quota at 80% or more;
 *   - the IFA browser sync (Lou's computer) silent for 36 hours.
 * Each has a key that repeats once a day at most.
 */
const IFA_QUIET_HOURS = require('./ifa-exa.js').quietHours();

function opsAlerts({ jobs = [], ifaSync = null, scraper = null, now = new Date() }) {
  const out = [];
  const today = israelDate(now);
  const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v ? Date.parse(v) || 0 : 0);
  const byName = {};
  for (const j of [...jobs].sort((a, b) => ms(b.startedAt) - ms(a.startedAt))) (byName[j.name] = byName[j.name] || []).push(j);
  for (const [name, runs] of Object.entries(byName)) {
    if (name === 'golda') continue;
    if (runs.length >= 2 && runs[0].status === 'error' && runs[1].status === 'error') {
      out.push({ key: `job2|${name}|${today}`, text: `• העבודה "${name}" נכשלה פעמיים ברצף: ${String(runs[0].error || '').slice(0, 100)}. כדאי לבדוק במסך הניהול ← בריאות.` });
    }
  }
  if (scraper && scraper.requestLimit && scraper.requestCount / scraper.requestLimit >= 0.8) {
    const pct = Math.round((scraper.requestCount / scraper.requestLimit) * 100);
    out.push({ key: `scraper80|${scraper.nextReset || today.slice(0, 7)}`, text: `• מכסת ScraperAPI ב-${pct}% (${scraper.requestCount}/${scraper.requestLimit})${scraper.nextReset ? `, מתאפסת ב-${fmtDate(scraper.nextReset)}` : ''}. מעקב TM ייעצר לבד כשיישארו 200 קרדיטים לסנכרון המשחקים.` });
  }
  // The Israeli fixtures are read by the server every morning (lib/ifa-exa.js)
  // and, as a fallback, by Chrome on Lou's computer. Either one updates
  // app_meta/ifaBrowserSync; quiet means neither published.
  const last = ifaSync ? Math.max(ms(ifaSync.lastRunAt), ms(ifaSync.lastSuccessAt)) : 0;
  if (ifaSync && last && now.getTime() - last > IFA_QUIET_HOURS * 3600000) {
    const hours = Math.round((now.getTime() - last) / 3600000);
    const why = ifaSync.lastRefused?.summary?.refused ? ` הסיבה האחרונה: ${String(ifaSync.lastRefused.summary.refused[0] || '').slice(0, 80)}.` : '';
    out.push({ key: `ifa36|${today}`, text: `• סנכרון ההתאחדות לא פורסם ${hours} שעות (לא מהשרת ולא מהמחשב).${why} פרטים במסך הניהול ← בריאות.` });
  }
  return out;
}

function buildOps(name, items) {
  return [`*${name}, עדכון תפעולי* 🔧`, ...items.map((i) => i.text), '', `${APP}/admin`].join('\n');
}

module.exports = { buildBriefing, urgentAlerts, buildUrgent, opsAlerts, buildOps, fmtDate };
