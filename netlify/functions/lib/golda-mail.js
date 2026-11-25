// Golda's read-only look at the agency's mail (lib/mail-store.js):
// "מה האחרון שכתבנו עם מכבי חיפה?" answers from the stored mail, with the
// subject, the date, who wrote to whom and Gmail's snippet. Admins and
// managers only, never the player role; mail linked to a deal only for those
// who see money (admins), as on the screens. She never sends, and never reads
// a mailbox herself: what the sync kept is all she sees.
const { clubKey, can, normalizeEmail } = require('@goldas/domain');
const store = require('./mail-store.js');
const gmailAuth = require('./gmail-auth.js');
const { normName } = require('./gcal-sync.js');

const MAX = 15;
const live = (x) => x && !x.deletedAt;
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

const MAIL_TOOL_DEF = {
  name: 'mail_recent',
  description: 'The agency\'s latest e-mails with a club, a contact person or (admins) about a deal\'s player, from the mail the CRM keeps from Lou\'s Gmail: date, who wrote to whom, subject, a short snippet, attachment names and a link that opens the message in Gmail. about = the club\'s name, the contact\'s name or address, or the player\'s name. Read-only: you cannot send, answer or change mail. Only mail with addresses saved in the CRM (a contact\'s e-mail, a club\'s e-mail domain) is there; when nothing is found, say so and say that adding the address on the contact or the domain on the club brings it in.',
  input_schema: { type: 'object', properties: {
    about: { type: 'string', description: 'A club, a contact (name or e-mail address) or a player with a deal' },
    n: { type: 'integer', description: 'How many messages, newest first (default 5, at most 15)' },
  }, required: ['about'], additionalProperties: false },
};

const israel = (ms) => new Date(ms).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const person = (p) => (p ? (p.name ? `${p.name} <${p.email}>` : p.email) : '');

/** What the name points at: a club, else a contact, else (money only) the deals of a player. */
async function resolve(db, about, money) {
  const q = String(about || '').trim();
  const key = clubKey(q);
  const n = normName(q);
  const clubs = rows(await db.collection('clubs').get()).filter(live);
  const club = clubs.find((c) => [c.key, c.name, ...(c.aliases || [])].some((x) => clubKey(x) === key))
    || clubs.find((c) => key && [c.name, ...(c.aliases || [])].some((x) => clubKey(x).includes(key)));
  if (club) return { kind: 'club', id: club.id, label: club.name };
  const email = normalizeEmail(q);
  const contacts = rows(await db.collection('contacts').get()).filter(live);
  const contact = contacts.find((c) => email && normalizeEmail(c.contactEmail) === email)
    || contacts.find((c) => n && normName(c.contactName) === n)
    || contacts.find((c) => n && normName(c.contactName).includes(n));
  if (contact) return { kind: 'contact', id: contact.id, label: contact.contactName || contact.contactEmail };
  if (money) {
    const deals = rows(await db.collection('deals').get()).filter(live).filter((d) => n && normName(d.playerName).includes(n));
    if (deals.length) return { kind: 'deal', ids: deals.map((d) => d.id), label: deals[0].playerName };
  }
  return null;
}

function mailTools({ db, identity, role }) {
  return {
    mail_recent: async ({ about, n }) => {
      if (identity.role === 'player' || !can(role, 'edit')) throw new Error('mail is for admins and managers only');
      const money = can(role, 'money');
      const pub = await gmailAuth.publicStatus(db);
      if (!pub.connected) return { connected: false, note: 'The Gmail mailbox is not connected to the CRM yet (System › Email, admin).' };
      const target = await resolve(db, about, money);
      if (!target) return { found: false, note: `No club, contact${money ? ' or deal' : ''} in the CRM matches "${about}".` };
      const lists = target.kind === 'deal'
        ? await Promise.all(target.ids.map((id) => store.messagesFor(db, 'deal', id, { money })))
        : [await store.messagesFor(db, target.kind, target.id, { money })];
      const seen = new Set();
      const all = lists.flat().filter((m) => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => (b.at || 0) - (a.at || 0));
      const take = Math.max(1, Math.min(Number(n) || 5, MAX));
      const account = pub.address ? `?authuser=${encodeURIComponent(pub.address)}` : '';
      return {
        about: { kind: target.kind, name: target.label }, total: all.length, lastSyncAt: pub.lastSyncAt ? israel(pub.lastSyncAt) : null,
        messages: all.slice(0, take).map((m) => ({
          date: israel(m.at), direction: m.direction === 'out' ? 'we wrote' : 'they wrote',
          from: person(m.from), to: (m.to || []).map(person).join(', '), subject: m.subject, snippet: m.snippet,
          attachments: m.attachments || [], gmail: `https://mail.google.com/mail/${account}#all/${m.threadId}`,
        })),
        ...(all.length ? {} : { note: 'Nothing kept with this record. Mail is linked only when the contact\'s e-mail or the club\'s e-mail domain is saved in the CRM.' }),
      };
    },
  };
}

module.exports = { mailTools, MAIL_TOOL_DEF };
