/**
 * Gold A&S CRM - Alert emails (mirrors the app's Notifications)
 *
 * Reads the SAME notification settings you configure in the app
 * (settings/notifications in Firestore) and the players/matches data,
 * then emails each alert ONCE, the day it becomes due. It is NOT a daily
 * digest: an alert is sent a single time when it first becomes relevant
 * (and again only when it crosses a smaller threshold you configured).
 *
 * Auth: uses YOUR OWN Google account (no service account, no key).
 * The account that owns this script must have read access to the
 * gold-as-crm Firestore project.
 *
 * --- ONE-TIME SETUP ---
 *  1. Run `sendDigest` once and click "Allow" on the permissions screen.
 *  2. Run `setupDailyTrigger` once. It runs a daily check (08:00); each
 *     alert still emails only once, when it is due.
 *  (Optional) Set WhatsApp via Green API (GREENAPI_ID/TOKEN + WHATSAPP_PHONE).
 */

// ====================== CONFIG ======================
var PROJECT_ID = 'gold-as-crm';

// Permanent owner — always receives if no other recipients are configured.
var OWNER_EMAIL = 'lou.korek@gmail.com';

// WhatsApp via Green API (free tier) - leave GREENAPI_ID empty to disable.
var WHATSAPP_PHONE  = '';      // your number, e.g. '972501234567'
var GREENAPI_ID     = '';      // idInstance from green-api.com
var GREENAPI_TOKEN  = '';      // apiTokenInstance from green-api.com

// Match reminder: how many days before a match to send the email (once).
var MATCH_LEAD_DAYS = 1;

// Fallback thresholds - used ONLY if the app hasn't saved settings yet.
// These match the app's defaults, so behaviour is identical out of the box.
var DEFAULT_SETTINGS = {
  contractDays: [7, 30, 60],
  reprDays:     [7, 30, 60],
  passportDays: [30, 90, 180],
  birthdayDays: [0, 3, 7],
};
// ====================================================


/** Entry point - call this from the trigger. */
function sendDigest() {
  var settings = fetchSettings();
  var players  = fetchCollection('players');
  var matches  = fetchCollection('matches');
  var sent     = loadSent();

  var r = computeNewAlerts(players, matches, settings, sent, new Date());

  if (r.total === 0) {
    Logger.log('No new alerts due - nothing sent.');
    return;
  }

  // Email — recipients come from the Team screen (app_users in Firestore).
  // Each user has an emailAlerts flag; missing means enabled.
  var recipients = fetchEmailRecipients();
  if (!recipients) {
    Logger.log('No users have emailAlerts enabled — skipping send.');
    return;
  }
  var subject = 'Gold A&S - ' + (r.total === 1 ? 'New alert' : r.total + ' new alerts');
  MailApp.sendEmail({
    to: recipients,
    subject: subject,
    htmlBody: buildEmailHtml(r.alerts, r.total),
  });
  Logger.log('Email sent to ' + recipients + ' (' + r.total + ' alerts)');

  // WhatsApp (optional)
  if (GREENAPI_ID && GREENAPI_TOKEN && WHATSAPP_PHONE) {
    sendWhatsApp(buildWhatsAppText(r.alerts, r.total));
  }

  // Only mark as sent AFTER a successful send, so nothing is lost on error.
  markSent(r.newKeys);
}


// ---------------- Recipients (from the Team screen) ----------------
// Reads the app_users collection (managed in-app from the Team screen) and
// returns a comma-separated list of every user whose `emailAlerts` is not
// explicitly false and who is not deactivated. If the read fails or no one is
// configured, falls back to the owner so the system never silently goes dark.
function fetchEmailRecipients() {
  try {
    var token = getAccessToken();
    var url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
              '/databases/(default)/documents/app_users?pageSize=300';
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      Logger.log('fetchEmailRecipients HTTP ' + res.getResponseCode() + ' — falling back to owner.');
      return OWNER_EMAIL;
    }
    var docs = (JSON.parse(res.getContentText()).documents || []).map(parseDoc);
    var emails = docs
      .filter(function (d) { return d.active !== false && d.emailAlerts !== false && d.email; })
      .map(function (d) { return d.email; });
    if (!emails.length) return OWNER_EMAIL;
    return emails.join(',');
  } catch (e) {
    Logger.log('fetchEmailRecipients error, falling back to owner: ' + e);
    return OWNER_EMAIL;
  }
}


// ---------------- Settings (from the app) ----------------
function fetchSettings() {
  try {
    var token = getAccessToken();
    var url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
              '/databases/(default)/documents/settings/notifications';
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return DEFAULT_SETTINGS;
    var parsed = parseDoc(JSON.parse(res.getContentText()));
    return {
      contractDays: arr(parsed.contractDays, DEFAULT_SETTINGS.contractDays),
      reprDays:     arr(parsed.reprDays,     DEFAULT_SETTINGS.reprDays),
      passportDays: arr(parsed.passportDays, DEFAULT_SETTINGS.passportDays),
      birthdayDays: arr(parsed.birthdayDays, DEFAULT_SETTINGS.birthdayDays),
    };
  } catch (e) {
    Logger.log('fetchSettings fell back to defaults: ' + e);
    return DEFAULT_SETTINGS;
  }
}

function arr(v, fallback) {
  return (v && v.length) ? v.map(Number) : fallback;
}


// ---------------- Alert computation (mirrors the app) ----------------
// For each player+category, an alert fires when daysUntil <= one of the
// configured thresholds. Each (player, category, threshold) is emailed at
// most once. When several thresholds are already passed at first sight
// (e.g. an existing player), they collapse into a single email and the
// passed thresholds are marked sent, so future runs only fire on the next
// smaller threshold crossing.
function computeNewAlerts(players, matches, settings, sent, now) {
  var out = { contract: [], repr: [], passport: [], birthday: [], matches: [] };
  var newKeys = [];

  function handleDate(p, dateField, cat, thresholds, makeItem) {
    if (!p[dateField]) return;
    var d = daysUntil(p[dateField], now);
    if (d === null || d < 0) return;
    var satisfied = thresholds.filter(function (t) { return d <= t; });
    if (!satisfied.length) return;
    var anyUnsent = satisfied.some(function (t) { return !sent[p.id + '|' + cat + '|' + t]; });
    if (!anyUnsent) return;
    out[cat].push(makeItem(p, d));
    satisfied.forEach(function (t) {
      var k = p.id + '|' + cat + '|' + t;
      if (!sent[k]) newKeys.push(k);
    });
  }

  players.forEach(function (p) {
    handleDate(p, 'contractEnd', 'contract', settings.contractDays,
      function (p, d) { return { name: p.fullName, days: d, date: p.contractEnd, club: p.currentClub }; });
    handleDate(p, 'reprEnd', 'repr', settings.reprDays,
      function (p, d) { return { name: p.fullName, days: d, date: p.reprEnd }; });
    handleDate(p, 'passportExpiry', 'passport', settings.passportDays,
      function (p, d) { return { name: p.fullName, days: d, date: p.passportExpiry }; });

    // Birthday - keyed by year so it fires again next year.
    var bd = daysUntilBirthday(p.dob, now);
    if (bd !== null && bd >= 0) {
      var yr = now.getFullYear();
      var bsat = settings.birthdayDays.filter(function (t) { return bd <= t; });
      if (bsat.length && bsat.some(function (t) { return !sent['b|' + p.id + '|' + t + '|' + yr]; })) {
        out.birthday.push({ name: p.fullName, days: bd, age: ageOnNextBirthday(p.dob, now) });
        bsat.forEach(function (t) {
          var k = 'b|' + p.id + '|' + t + '|' + yr;
          if (!sent[k]) newKeys.push(k);
        });
      }
    }
  });

  // Matches - one reminder, MATCH_LEAD_DAYS before kickoff.
  matches.forEach(function (m) {
    var d = daysUntil(m.date, now);
    if (d === null || d < 0 || d > MATCH_LEAD_DAYS) return;
    var k = 'm|' + (m.id || (m.homeTeam + '_' + m.awayTeam + '_' + m.date));
    if (sent[k]) return;
    out.matches.push({ home: m.homeTeam, away: m.awayTeam, days: d, date: m.date, time: m.time, stadium: m.stadiumName });
    newKeys.push(k);
  });

  ['contract', 'repr', 'passport', 'birthday', 'matches'].forEach(function (k) {
    out[k].sort(function (a, b) { return a.days - b.days; });
  });

  var total = out.contract.length + out.repr.length + out.passport.length +
              out.birthday.length + out.matches.length;
  return { alerts: out, newKeys: newKeys, total: total };
}

function daysUntil(dateStr, now) {
  if (!dateStr) return null;
  var d = parseDate(dateStr);
  if (!d) return null;
  return Math.ceil((d - now) / 86400000);
}

function daysUntilBirthday(dob, now) {
  if (!dob) return null;
  var b = parseDate(dob);
  if (!b) return null;
  var next = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  if (next < stripTime(now)) next.setFullYear(now.getFullYear() + 1);
  return Math.ceil((next - stripTime(now)) / 86400000);
}

function ageOnNextBirthday(dob, now) {
  var b = parseDate(dob);
  if (!b) return '';
  var age = now.getFullYear() - b.getFullYear();
  var thisYear = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  if (thisYear < stripTime(now)) age += 1;
  return age;
}

function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function parseDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    var p = s.split('-'); return new Date(+p[0], +p[1]-1, +p[2]);
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    var q = s.split('/'); return new Date(+q[2], +q[1]-1, +q[0]);
  }
  var d = new Date(s);
  return isNaN(d) ? null : d;
}

function fmtDate(s) {
  var d = parseDate(s);
  if (!d) return s || '';
  function pad(n){ return ('0'+n).slice(-2); }
  return pad(d.getDate()) + '/' + pad(d.getMonth()+1) + '/' + d.getFullYear();
}


// ---------------- Dedup state (Script Properties) ----------------
function loadSent() {
  var raw = PropertiesService.getScriptProperties().getProperty('sentAlerts');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function markSent(keys) {
  if (!keys || !keys.length) return;
  var sent = loadSent();
  keys.forEach(function (k) { sent[k] = 1; });
  PropertiesService.getScriptProperties().setProperty('sentAlerts', JSON.stringify(sent));
}

// Utility: clear all dedup state (run manually to "resend everything").
function resetSentState() {
  PropertiesService.getScriptProperties().deleteProperty('sentAlerts');
  Logger.log('Sent-state cleared.');
}


// ---------------- Email body ----------------
function buildEmailHtml(a, total) {
  var gold = '#C9A84C', dark = '#16201A', text = '#1c1c1c';
  function section(title, icon, rows) {
    if (!rows.length) return '';
    return '<tr><td style="padding:18px 0 6px;font:700 13px Arial;color:' + gold + ';letter-spacing:.04em;text-transform:uppercase">' +
      icon + ' ' + title + ' (' + rows.length + ')</td></tr>' +
      '<tr><td>' + rows.join('') + '</td></tr>';
  }
  function row(main, sub, urgent) {
    var bar = urgent ? '#E74C3C' : gold;
    return '<div style="border-left:3px solid ' + bar + ';background:#faf8f2;border-radius:6px;padding:10px 14px;margin:6px 0">' +
      '<div style="font:600 14px Arial;color:' + text + '">' + main + '</div>' +
      (sub ? '<div style="font:13px Arial;color:#666;margin-top:2px">' + sub + '</div>' : '') +
      '</div>';
  }

  var html = '<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif">' +
    '<div style="background:' + dark + ';padding:22px 24px;border-radius:12px 12px 0 0">' +
      '<div style="font:700 22px Georgia,serif;color:' + gold + '">Gold A&amp;S</div>' +
      '<div style="font:12px Arial;color:#9bbf9d;letter-spacing:.1em;text-transform:uppercase;margin-top:2px">Alerts &middot; ' + total + ' new</div>' +
    '</div>' +
    '<div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:8px 24px 24px"><table width="100%" cellpadding="0" cellspacing="0">';

  html += section('Contract Expiry', '📋', a.contract.map(function (x) {
    return row(x.name + ' - contract expires in ' + dayLabel(x.days),
               'Expires: ' + fmtDate(x.date) + (x.club ? ' &middot; ' + x.club : ''), x.days <= 7);
  }));
  html += section('Representation Expiry', '🤝', a.repr.map(function (x) {
    return row(x.name + ' - representation expires in ' + dayLabel(x.days), 'Expires: ' + fmtDate(x.date), x.days <= 7);
  }));
  html += section('Passport Expiry', '🛂', a.passport.map(function (x) {
    return row(x.name + ' - passport expires in ' + dayLabel(x.days), 'Expires: ' + fmtDate(x.date), x.days <= 30);
  }));
  html += section('Birthdays', '🎂', a.birthday.map(function (x) {
    return row(x.name + (x.age === 18 ? ' - Turning 18!' : ''),
               (x.days === 0 ? 'Birthday is today!' : 'Birthday in ' + dayLabel(x.days)) + ' &middot; Turning ' + x.age, x.age === 18);
  }));
  html += section('Upcoming Matches', '⚽', a.matches.map(function (x) {
    return row(x.home + ' vs ' + x.away,
               fmtDate(x.date) + (x.time ? ' &middot; ' + x.time : '') + (x.stadium ? ' &middot; ' + x.stadium : ''), x.days <= 1);
  }));

  html += '</table></div>' +
    '<div style="text-align:center;font:11px Arial;color:#aaa;padding:14px">Gold A&amp;S Football Agency &middot; gold-as.com</div></div>';
  return html;
}

function dayLabel(d) { return d === 0 ? 'today' : (d === 1 ? '1 day' : d + ' days'); }

// ---------------- WhatsApp body ----------------
function buildWhatsAppText(a, total) {
  var lines = ['*Gold A&S - ' + total + ' new alert' + (total === 1 ? '' : 's') + '*', ''];
  if (a.contract.length) {
    lines.push('*Contracts*');
    a.contract.forEach(function (x){ lines.push('- ' + x.name + ' - ' + dayLabel(x.days) + ' (' + fmtDate(x.date) + ')'); });
    lines.push('');
  }
  if (a.repr.length) {
    lines.push('*Representation*');
    a.repr.forEach(function (x){ lines.push('- ' + x.name + ' - ' + dayLabel(x.days) + ' (' + fmtDate(x.date) + ')'); });
    lines.push('');
  }
  if (a.passport.length) {
    lines.push('*Passports*');
    a.passport.forEach(function (x){ lines.push('- ' + x.name + ' - ' + dayLabel(x.days) + ' (' + fmtDate(x.date) + ')'); });
    lines.push('');
  }
  if (a.birthday.length) {
    lines.push('*Birthdays*');
    a.birthday.forEach(function (x){ lines.push('- ' + x.name + ' - ' + (x.days === 0 ? 'today' : dayLabel(x.days)) + ' (turning ' + x.age + ')'); });
    lines.push('');
  }
  if (a.matches.length) {
    lines.push('*Matches*');
    a.matches.forEach(function (x){ lines.push('- ' + x.home + ' vs ' + x.away + ' - ' + fmtDate(x.date) + (x.time ? ' ' + x.time : '')); });
  }
  return lines.join('\n').trim();
}

function sendWhatsApp(text) {
  var url = 'https://api.green-api.com/waInstance' + GREENAPI_ID + '/sendMessage/' + GREENAPI_TOKEN;
  var payload = { chatId: WHATSAPP_PHONE + '@c.us', message: text };
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    Logger.log('WhatsApp: ' + res.getResponseCode() + ' ' + res.getContentText());
  } catch (e) {
    Logger.log('WhatsApp error: ' + e);
  }
}


// ---------------- Firestore access ----------------
function fetchCollection(name) {
  var token = getAccessToken();
  var url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
            '/databases/(default)/documents/' + name + '?pageSize=300';
  var docs = [];
  var pageToken = null;
  do {
    var u = url + (pageToken ? '&pageToken=' + pageToken : '');
    var res = UrlFetchApp.fetch(u, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    var data = JSON.parse(res.getContentText());
    if (data.documents) data.documents.forEach(function (d) { docs.push(parseDoc(d)); });
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return docs;
}

function parseDoc(doc) {
  var out = {};
  out.id = (doc.name || '').split('/').pop();
  var f = doc.fields || {};
  Object.keys(f).forEach(function (k) { out[k] = parseValue(f[k]); });
  return out;
}

function parseValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(parseValue);
  if (v.mapValue !== undefined) {
    var o = {}; var fields = v.mapValue.fields || {};
    Object.keys(fields).forEach(function (k){ o[k] = parseValue(fields[k]); });
    return o;
  }
  return null;
}

// Use the OAuth token of the account running the script (the script's owner).
// The 'datastore' scope is declared in appsscript.json so it is granted on Allow.
function getAccessToken() {
  return ScriptApp.getOAuthToken();
}


// ---------------- Trigger setup ----------------
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDigest').timeBased().everyDays(1).atHour(8).create();
  Logger.log('Daily check scheduled for 08:00 (each alert still emails once, when due).');
}
