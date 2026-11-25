// Outreach drafts in the writer's own style, opened in his WhatsApp, and logged.
//
// "מבקשים הודעה למנהל ספורטיבי על שחקן, וגולדה כותבת אותה בסגנון שלך, בעברית
// או באנגלית. כפתור אחד פותח את וואטסאפ עם ההודעה מוכנה, אתה שולח, והפנייה
// נרשמת אצל איש הקשר."
//
// Golda never sends anything to anyone outside the agency. She drafts; the
// writer sends from his own WhatsApp through a wa.me link (a real "פתיחה
// בוואטסאפ" button on WhatsApp, a link in the app). She cannot know he pressed
// send, so she asks; only his yes in a LATER message records the touch on the
// contact (outreach_log refuses a draft armed in the same turn, like delete).
//
// The style is taught, on the long-term memory (golda_memory): examples of
// messages he sent ("ככה אני כותב") and rules learned from his corrections,
// kept as personal memories with kind 'style' (lib/golda-memory.js leaves them
// out of "What you remember"; they are read here, for drafts only).
//
// Touches: contacts/{id}.touches [{ id, at, channel, by, playerId, dealId, note }]
// (packages/domain/src/schemas.ts touchSchema; the relationship map reads it too).
const { playerName, lastTouch } = require('@goldas/domain');

const APP = 'https://goldas-crm.netlify.app';
const STYLE_EXAMPLES = 8;            // newest examples shown to the drafter
const STYLE_RULES = 25;
const EXAMPLE_MAX = 1500;
const RULE_MAX = 300;
const DRAFT_MAX = 3000;              // a wa.me link stays well under URL limits
const PENDING_MAX = 5;
const PENDING_DAYS = 7;
const OPEN_LABEL = 'פתיחה בוואטסאפ';

const ownerKey = (identity = {}) => identity.email || identity.phone || '';
const metaId = (owner) => `style_meta_${String(owner).replace(/[^A-Za-z0-9]/g, '_').slice(0, 120)}`;

/**
 * The international digits wa.me wants, or '' when the number is unusable.
 * Israeli local numbers (050…, 03…) get 972; "00" prefixes are dropped.
 */
function waDigits(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length >= 9 && d.length <= 10) d = `972${d.slice(1)}`;
  return d.length >= 8 && d.length <= 15 ? d : '';
}

/** https://wa.me/<digits>?text=… ; without a number WhatsApp lets him pick the chat. */
function waLink(phone, text) {
  const d = waDigits(phone);
  return `https://wa.me/${d}?text=${encodeURIComponent(String(text || ''))}`;
}

/** Hebrew for an Israeli club (or an unknown country), English for a club abroad. */
function draftLanguage(contact = {}, club = null) {
  const country = String(contact.leagueCountry || (club && club.country) || '').trim();
  if (!country) return 'he';
  return /^israel$|^ישראל$/i.test(country) ? 'he' : 'en';
}

/** The style memories of one writer: { examples, rules }, newest first. */
function styleOf(rows, identity) {
  const me = ownerKey(identity);
  const mine = (rows || []).filter((m) => m && m.kind === 'style' && m.text && me && m.owner === me)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const pick = (k, n) => mine.filter((m) => m.styleKind === k).slice(0, n).map((m) => ({ id: m.id, text: m.text, ...(m.lang ? { lang: m.lang } : {}) }));
  return { examples: pick('example', STYLE_EXAMPLES), rules: pick('rule', STYLE_RULES) };
}

/** Drafts still waiting for "did it go out?": recent, at most PENDING_MAX. */
function livePending(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((p) => p && p.id && now - (p.createdAt || 0) < PENDING_DAYS * 86400000).slice(-PENDING_MAX);
}

/** The prompt lines for drafts and touches. */
function outreachSection(channel = 'whatsapp') {
  return `- Messages to people outside the agency (a sporting director, a coach, an agent, a club): you NEVER send anything to anyone outside the agency. You draft; the writer sends it himself from his own WhatsApp. "תכתבי הודעה ל<איש קשר> על <שחקן>" / "תנסחי פנייה ל…" → find the contact (contacts; if he is not there, say so and offer to add him) and the player, then outreach_prepare (the facts, the language and the writer's style), write the message in his style (his examples and rules first; nothing learned yet → plain, short and polite, and when outreach_prepare says sayOnce, add one line that you will learn from examples he sends, "ככה אני כותב: …"), in the language it gives unless he asked for another, then outreach_link with the full text. ${channel === 'app' ? 'Show the draft in full, then the link on its own line (it opens WhatsApp with the message ready),' : 'Show the draft in full; the "פתיחה בוואטסאפ" button that opens his WhatsApp with the message ready goes out by itself right after your text, so never paste the wa.me link,'} and end with the question whether it went out as its own last paragraph, with buttons [[כפתורים: נשלח | לא נשלח]] (only when outreach_link says canLog). Only on his yes in a later message: outreach_log (it records the touch on the contact). "לא נשלח" → outreach_log sent=false. Never record a touch he did not confirm.
- His style: "ככה אני כותב" / a message he pasted that he sent → writing_style action=example with the message as it is. When he corrects a draft ("יותר קצר", "בלי 'שלום רב'", "תפני בשם הפרטי"), write it again and save the lesson as one short rule with writing_style action=rule. "איך אני כותב" → action=list. A wrong rule → forget with its id.`;
}

const OUTREACH_TOOL_DEFS = [
  { name: 'outreach_prepare', description: "Everything needed to draft a message to a contact outside the agency about a player: the contact (name, role, club, whether a phone is known), the language to write in (by the club's country), the player's facts, the deal, the last touch, and the writer's own style (his example messages and his rules). Call before writing any outreach draft.",
    input_schema: { type: 'object', properties: {
      contactId: { type: 'string', description: 'The contact (find with search in contacts first)' },
      playerId: { type: 'string', description: 'The player or prospect the message is about' },
      dealId: { type: 'string' },
    }, additionalProperties: false } },
  { name: 'outreach_link', description: 'Turn the finished draft into the link that opens the writer\'s own WhatsApp with the message ready (to the contact\'s number, or a chat he picks when no number is known). Nothing is sent by you, ever. The draft waits for his "did it go out?" answer, which outreach_log records in a later message.',
    input_schema: { type: 'object', properties: {
      text: { type: 'string', description: 'The whole message, exactly as it should be sent' },
      contactId: { type: 'string' },
      phone: { type: 'string', description: 'Only when the number is not on the contact (the writer gave it)' },
      playerId: { type: 'string' }, dealId: { type: 'string' },
      about: { type: 'string', description: 'One short line for the contact\'s history: what the message is about (e.g. "הצעת אבי כהן לבלם")' },
    }, required: ['text'], additionalProperties: false } },
  { name: 'outreach_log', description: 'After the writer said in a LATER message that the drafted message went out: record the touch on the contact (date, WhatsApp, about whom, one line). sent=false drops the draft without recording. Refused for a draft made in the same message.',
    input_schema: { type: 'object', properties: {
      draftId: { type: 'string', description: 'Which draft; defaults to the latest one' },
      sent: { type: 'boolean', description: 'true (default): it went out; false: it did not' },
    }, additionalProperties: false } },
  { name: 'writing_style', description: "The writer's own way of writing messages, which drafts follow: add an example of a message he sent (action=example), a rule learned from his correction (action=rule, one short sentence), or list what you learned (action=list). Personal to the writer.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['example', 'rule', 'list'] },
      text: { type: 'string' },
      lang: { type: 'string', enum: ['he', 'en'] },
    }, required: ['action'], additionalProperties: false } },
];

/**
 * outreachTools({ db, identity, role, channel, session, state, can })
 *   state  wa-agent's per-answer state: pendingOutreach (persisted on the
 *          session by the worker) and outLinks (the WhatsApp open buttons).
 */
function outreachTools({ db, admin, identity = {}, role = 'viewer', channel = 'whatsapp', session = {}, state = {}, can }) {
  const me = ownerKey(identity);
  const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
  const turn = session.turn;
  if (!Array.isArray(state.pendingOutreach)) state.pendingOutreach = livePending(session.pendingOutreach);
  if (!Array.isArray(state.outLinks)) state.outLinks = [];
  const live = (d) => d && !d.deletedAt;

  async function readContact(id) {
    if (!id) return null;
    const s = await db.collection('contacts').doc(String(id)).get();
    if (!s.exists || !live(s.data())) throw new Error('contact not found');
    return { id: s.id, ...s.data() };
  }
  async function clubOf(contact) {
    if (!contact) return null;
    try {
      if (contact.clubId) { const s = await db.collection('clubs').doc(contact.clubId).get(); if (s.exists) return s.data(); }
      if (contact.clubName) {
        const want = String(contact.clubName).trim().toLowerCase();
        const hit = (await db.collection('clubs').get()).docs.map((d) => d.data())
          .find((c) => c && !c.deletedAt && [c.name, ...(c.aliases || [])].some((n) => String(n || '').trim().toLowerCase() === want));
        if (hit) return hit;
      }
    } catch { /* the language falls back to Hebrew */ }
    return null;
  }
  async function readStyle() {
    const rows = (await db.collection('golda_memory').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    return styleOf(rows, identity);
  }

  async function prepare({ contactId, playerId, dealId }) {
    const contact = await readContact(contactId);
    const club = await clubOf(contact);
    let player = null, deal = null;
    if (playerId) {
      const s = await db.collection('players').doc(String(playerId)).get();
      if (!s.exists || !live(s.data())) throw new Error('player not found');
      const p = s.data();
      player = { id: s.id, name: playerName(p) || p.fullName || p.playerName, dob: p.dob || '', position: p.primaryPosition || '', secondary: p.secondaryPositions || [],
        foot: p.foot || '', club: p.currentClub || '', contractStatus: p.contractStatus || '', contractEnd: p.contractEnd || '', nationalities: p.nationalities || [],
        height: p.height || '', videoLink: p.videoLink || '', profileLink: p.profileLink || '', link: `${APP}/players/${s.id}` };
    }
    if (dealId) {
      const s = await db.collection('deals').doc(String(dealId)).get();
      if (s.exists && live(s.data())) deal = { id: s.id, clubName: s.data().clubName || '', stage: s.data().stage || '' };
    }
    const style = await readStyle();
    const learned = style.examples.length + style.rules.length > 0;
    // "With nothing learned yet she says once that she will learn": once per writer.
    let sayOnce = false;
    if (!learned && me) {
      const ref = db.collection('golda_memory').doc(metaId(me));
      const s = await ref.get().catch(() => null);
      if (!s || !s.exists) { sayOnce = true; await ref.set({ kind: 'style_meta', owner: me, hintAt: Date.now() }).catch(() => {}); }
    }
    const last = contact ? lastTouch(contact) : null;
    return {
      contact: contact ? { id: contact.id, name: contact.contactName || '', role: contact.contactRole || '', club: contact.clubName || '', country: contact.leagueCountry || (club && club.country) || '', phoneKnown: Boolean(waDigits(contact.contactPhone)) } : null,
      language: draftLanguage(contact || {}, club),
      player, deal,
      lastTouch: last ? { at: last.at, channel: last.channel, note: last.note || '' } : null,
      style: { learned, ...style },
      sayOnce,
      instruction: `Write the message ${learned ? 'in the writer\'s style: follow his rules, and sound like his examples (greeting, length, tone, sign-off)' : 'plainly: short, polite, to the point'}; facts only from here, no confidential terms (salary, other clubs, contract terms). Then call outreach_link with the full text.`,
    };
  }

  async function link({ text, contactId, phone, playerId, dealId, about }) {
    const body = String(text || '').trim();
    if (!body) throw new Error('the draft is empty');
    if (body.length > DRAFT_MAX) throw new Error(`keep the message under ${DRAFT_MAX} characters`);
    const contact = await readContact(contactId);
    const number = waDigits(phone || (contact && contact.contactPhone));
    const url = waLink(number, body);
    const canLog = Boolean(contact) && can(role, 'edit');
    const id = `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (contact) {
      state.pendingOutreach = livePending([...state.pendingOutreach, {
        id, contactId: contact.id, contactName: contact.contactName || contact.clubName || '', phone: number, playerId: playerId || '', dealId: dealId || '',
        note: String(about || '').trim().slice(0, 140) || 'פנייה בוואטסאפ', text: body.slice(0, 1500), armedInTurn: turn, createdAt: Date.now(), by: identity.email || '',
      }]);
    }
    const toName = contact ? (contact.contactName || contact.clubName) : '';
    if (channel !== 'app') state.outLinks.push({ url, label: OPEN_LABEL, body: `${toName ? `ההודעה ל${toName} מוכנה.` : 'ההודעה מוכנה.'} לחיצה פותחת את הוואטסאפ שלך עם הטקסט, ואתה שולח.`, footer: number ? '' : 'בלי מספר: בוחרים את הצ\'אט בוואטסאפ' });
    return {
      ready: true, draftId: contact ? id : null, to: toName || null, numberKnown: Boolean(number), link: url, canLog,
      instruction: [
        channel === 'app' ? 'Show the draft in full, then this link on its own line.' : 'The "פתיחה בוואטסאפ" button goes out by itself right after your text; do not paste the link.',
        number ? '' : 'No number is known: the link opens WhatsApp and he picks the chat.',
        canLog ? 'End with the question whether it went out as its own last paragraph, with [[כפתורים: נשלח | לא נשלח]]; record only on his yes in a later message (outreach_log).'
          : contact ? 'This writer may not record in the CRM: do not ask whether it went out.' : 'Not linked to a contact in the CRM, so nothing will be recorded; say so in one line and offer to add the contact.',
      ].filter(Boolean).join(' '),
    };
  }

  async function log({ draftId, sent = true }) {
    if (!can(role, 'edit')) throw new Error(`${identity.name || 'the writer'} is a ${role} and may not edit here`);
    const pending = state.pendingOutreach;
    const ready = pending.filter((p) => p.armedInTurn !== turn);
    const pick = draftId ? ready.find((p) => p.id === draftId) : ready[ready.length - 1];
    if (!pick) {
      if (pending.some((p) => p.armedInTurn === turn && (!draftId || p.id === draftId))) throw new Error('the draft was made in this same message: ask the writer whether it went out and record it only after his answer');
      throw new Error('no draft is waiting to be recorded');
    }
    state.pendingOutreach = pending.filter((p) => p.id !== pick.id);
    if (sent === false) return { recorded: false, dropped: true, contact: pick.contactName };
    const ref = db.collection('contacts').doc(pick.contactId);
    const s = await ref.get();
    if (!s.exists || !live(s.data())) throw new Error('the contact is no longer in the CRM');
    const before = Array.isArray(s.data().touches) ? s.data().touches : [];
    const touch = { id: pick.id, at: new Date().toISOString(), channel: 'whatsapp', by: identity.email || pick.by || '', playerId: pick.playerId || '', dealId: pick.dealId || '', note: pick.note };
    const after = [...before, touch];
    const by = identity.email || '';
    const byName = `${identity.name || 'לו'} (גולדה)`;
    const stamp = FieldValue && FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date().toISOString();
    await ref.update({ touches: after, updatedAt: stamp, lastEditedAt: stamp, lastEditedBy: by, lastEditedByName: byName });
    await db.collection('audit').add({ action: 'update', collection: 'contacts', docId: pick.contactId, before: { touches: before }, after: { touches: after }, fields: ['touches'],
      by, byName, via: 'golda', channel, actor: 'golda', onBehalfOf: identity.email || '', sender: identity.name || '', phone: identity.phone || '', at: stamp, undone: false });
    state.changed = true;
    return { recorded: true, contact: pick.contactName, touch, link: `${APP}/contacts` };
  }

  async function writingStyle({ action, text, lang }) {
    if (!me) throw new Error('the writer is not known');
    if (action === 'list') {
      const st = await readStyle();
      return { ...st, learned: st.examples.length + st.rules.length > 0, note: 'Each entry has its id; forget removes one.' };
    }
    const t = String(text || '').trim();
    if (!t) throw new Error('text is empty');
    const max = action === 'example' ? EXAMPLE_MAX : RULE_MAX;
    if (t.length > max) throw new Error(`keep it under ${max} characters`);
    const now = Date.now();
    const doc = { kind: 'style', styleKind: action, text: t, about: 'סגנון כתיבה', shared: false, owner: me, ownerName: identity.name || '', createdAt: now, updatedAt: now, ...(lang ? { lang } : {}) };
    const ref = await db.collection('golda_memory').add(doc);
    return { saved: true, id: ref.id, kind: action, note: action === 'example' ? 'Drafts will sound like this.' : 'Drafts will follow this rule.' };
  }

  return { outreach_prepare: prepare, outreach_link: link, outreach_log: log, writing_style: writingStyle };
}

module.exports = { outreachTools, outreachSection, OUTREACH_TOOL_DEFS, waDigits, waLink, draftLanguage, styleOf, livePending, OPEN_LABEL };
