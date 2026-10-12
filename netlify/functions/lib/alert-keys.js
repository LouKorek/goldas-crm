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
  return `${a.type}|${a.subject.id}|${a.dueDate || ''}`;
}

module.exports = { dedupeKey };
