// Golda's tools for representation agreements signed inside the system
// (lib/agreements.js).
//
//   agreement_create    an admin's "הסכם ייצוג ל<שחקן>": check → the summary is
//                       shown and the request is kept; confirm, in a LATER
//                       message, makes it and returns the signing link
//   agreement_list      a player's agreements and where each one stands
//   agreement_link      stop an unsigned agreement's link, or issue a new one
//   agreement_template  show a language's template, propose a new text, and
//                       save it only after the writer's yes in a later message
//
// Making, linking and templates are an admin's (TOOL_ACTION in lib/wa-agent.js,
// and checked here again); the list is open to whoever may read the player,
// without the link's address for anyone but an admin. The link goes to the
// writer alone: Golda never sends it to the player or the family herself.
// Neither an ID number nor a signature ever reaches the model: the views this
// file returns are lib/agreements.js viewOf(), which has neither.
const { dayText, checkTemplate, AGREEMENT_PLACEHOLDERS } = require('@goldas/domain');
const agreements = require('./agreements.js');

const AGREEMENT_TOOL_DEFS = [
  { name: 'agreement_create', description: "Make a representation agreement for one player from the agency's template and get its private signing link (the player, or for a minor the parent or guardian, signs on the phone). Two steps: action=check with everything collected (start; end OR months, leave both out for the template's default length; lang he (default) or en; for a player under 18 the guardianName of the parent or guardian who signs) returns the summary to show the writer; action=confirm, ONLY after the writer's yes in a LATER message, makes it. days: how long the link works (14 when the writer named none, 30 at most). Admin only.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['check', 'confirm'] },
      playerId: { type: 'string', description: 'The id of the player in players, from search or list (check only)' },
      start: { type: 'string', description: 'The first day of representation, YYYY-MM-DD' },
      end: { type: 'string', description: 'The last day, YYYY-MM-DD. Or give months instead' },
      months: { type: 'integer', description: 'The length in months, when no end date was named' },
      lang: { type: 'string', enum: ['he', 'en'], description: "The agreement's language: he (default) or en" },
      guardianName: { type: 'string', description: 'For a player under 18: the full name of the parent or guardian who signs' },
      minor: { type: 'boolean', description: 'Only when the CRM has no date of birth: whether the player is under 18' },
      playerSigns: { type: 'boolean', description: 'For a minor: whether the player signs too beside the guardian (default true)' },
      days: { type: 'integer', description: 'How many days the signing link works: 1 to 30. Leave out when none was named (14)' },
    }, required: ['action'], additionalProperties: false } },
  { name: 'agreement_list', description: "A player's representation agreements made in the system and where each stands: waiting for the signature (until when the link works, how often it was opened), expired, revoked, locked (too many failed tries), signed (when, from a phone or a computer, by whom) and whether the signed PDF is in his file. Use for \"מה עם ההסכם של…\", \"<שחקן> חתם?\".",
    input_schema: { type: 'object', properties: { playerId: { type: 'string' } }, required: ['playerId'], additionalProperties: false } },
  { name: 'agreement_link', description: "For an agreement that is not signed yet: action=revoke stops its link at once; action=reissue makes a new link (the old one stops at once; days 14 by default, 30 at most) and returns it. agreementId comes from agreement_list. Admin only.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['revoke', 'reissue'] }, agreementId: { type: 'string' },
      days: { type: 'integer', description: 'reissue: 1 to 30 days; leave out for 14' },
    }, required: ['action', 'agreementId'], additionalProperties: false } },
  { name: 'agreement_template', description: `The agency's representation agreement template, one per language. action=show returns the current text, its version and settings, and the placeholder list. action=propose keeps a new text as a proposal (nothing changes yet): build it from the agency's own agreement when asked (read the player's representation agreement with read_file, keep the wording, and put placeholders where the names, dates and numbers of that one player were: ${AGREEMENT_PLACEHOLDERS.map((p) => `{{${p.key}}}`).join(' ')}; {{#minor}}…{{/minor}} holds text only for a player under 18, {{#adult}}…{{/adult}} only for an adult; '# ' starts a heading, a blank line a new paragraph). Never leave a real person's name, ID number, address or phone in a template. Show the writer the whole proposal and ask. action=save, ONLY after the writer's yes in a LATER message, saves it as the new version (earlier versions stay, signed agreements keep their own text). Admin only.`,
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['show', 'propose', 'save'] },
      lang: { type: 'string', enum: ['he', 'en'] },
      text: { type: 'string', description: 'propose: the whole template text' },
      defaultMonths: { type: 'integer', description: 'propose: the default length in months (24 when left out)' },
      maxMonths: { type: 'integer', description: 'propose: the longest length allowed, 24 at most' },
      agencyName: { type: 'string', description: "propose: the agency's name as printed (Gold A&S when left out)" },
    }, required: ['action', 'lang'], additionalProperties: false } },
];

/** 7 to 10 digits in a row: what an ID or a phone number looks like, never a placeholder. */
const LOOKS_PRIVATE = /(?<!\d)\d{7,10}(?!\d)/;

const STATE_HE = {
  waiting: 'ממתין לחתימה', expired: 'הלינק פג', revoked: 'הלינק בוטל', locked: 'הלינק ננעל אחרי יותר מדי ניסיונות',
  signed_filing: 'נחתם, ה-PDF בדרך לתיק', filing_failed: 'נחתם, שמירת ה-PDF נכשלה ואני מנסה שוב', signed: 'נחתם ונשמר בתיק',
};

function agreementTools({ db, identity = {}, role, channel = 'whatsapp', session = {}, now = () => Date.now() }) {
  const turn = Number(session?.turn) || 0;
  const me = String(identity.email || '').toLowerCase();
  const sender = identity.name || '';
  const adminOnly = (what) => {
    if (role !== 'admin') throw new Error(`${sender || 'the writer'} is a ${role} and may not ${what}: only an admin can`);
    if (!me) throw new Error('the writer is not known');
  };
  const draftRef = () => db.collection(agreements.DRAFTS).doc(me);
  const answer = (e) => {
    if (e instanceof agreements.AgreementError) return { refused: true, reason: e.message };
    throw e;
  };
  const line = (v) => ({
    agreementId: v.id, lang: v.lang, state: v.state, stateHe: STATE_HE[v.state] || v.state,
    period: v.start ? `${dayText(v.start)} – ${dayText(v.end)} (${v.months} months)` : null,
    ...(v.minor ? { minor: true, guardian: v.guardianName, playerSignsToo: v.playerSigns } : {}),
    created: v.createdAt, by: v.createdByName,
    ...(v.state === 'waiting' ? { linkWorksUntil: v.linkExpiresAt, opened: v.opens, lastOpened: v.lastOpenAt, lastDevice: v.lastOpenDevice } : {}),
    ...(v.signedAt ? { signedAt: v.signedAt, from: v.signedDevice, signers: v.signers.map((s) => `${s.name} (${s.role === 'guardian' ? s.relation || 'guardian' : 'player'})`), inFile: v.state === 'signed' } : {}),
    ...(v.url ? { link: v.url } : {}),
  });

  return {
    agreement_create: async ({ action, playerId, start, end, months, lang, guardianName, minor, playerSigns, days } = {}) => {
      adminOnly('make a representation agreement');
      if (action === 'check') {
        const input = { playerId, start, end, months, lang, guardianName, minor, playerSigns, days };
        let p;
        try { p = await agreements.prepareAgreement(db, { ...input, now: now() }); } catch (e) { return answer(e); }
        const summary = agreements.summaryOf(p);
        const span = agreements.linkDays(days);
        await draftRef().set({ input: JSON.parse(JSON.stringify(input)), summary, turn, at: now() });
        return {
          ready: true, summary, linkDays: span.days, ...(span.clamped ? { note: `A signing link works ${agreements.MAX_LINK_DAYS} days at most; say so.` } : {}),
          signedBy: p.minor ? `${p.guardianName} (parent or guardian)${p.playerSigns ? ` and ${summary.player}` : ''}` : summary.player,
          instruction: 'Show the writer this summary in short lines (player, period with dates, language, who signs, how long the link works) and ask with buttons [[כפתורים: ליצור, לשנות]]. Nothing is made yet. Only after the yes in a LATER message call agreement_create action=confirm.',
        };
      }
      if (action !== 'confirm') throw new Error('action is check or confirm');
      const snap = await draftRef().get();
      const d = snap.exists ? snap.data() : null;
      if (!d || !d.input) return { refused: true, reason: 'there is nothing waiting to be made: run action=check first' };
      if (!(turn > Number(d.turn))) throw new Error('the writer has not answered the summary yet: show it, ask, and confirm only after the yes in a later message');
      let made;
      try { made = await agreements.createAgreement(db, { ...d.input, by: { email: me, name: sender, channel }, now: now() }); } catch (e) { return answer(e); }
      await draftRef().delete();
      await db.collection('audit').add({
        action: 'create', collection: agreements.COL, docId: made.id, name: made.summary.player,
        summary: `Representation agreement made: ${made.summary.player} · ${made.summary.start} → ${made.summary.end}`, fields: ['created'], note: 'representation agreement',
        by: me, byName: `${sender} (Golda)`.trim(), via: 'golda', channel, actor: 'golda', onBehalfOf: me, sender, phone: identity.phone || '',
        at: new Date(now()).toISOString(), undone: false,
      }).catch((e) => console.error('[golda-agreement] audit failed:', e.message));
      return {
        made: true, agreementId: made.id, link: made.url, worksDays: made.days, summary: made.summary,
        instruction: 'Give the writer the link on its own line, with for whom it is and until when it works. He sends it on himself; you never send it to the player, the family or anyone else. Say you will tell him as soon as it is signed, and that the signed PDF goes into the player\'s file by itself. Opening it where he is signed in to the CRM is a preview: it does not count and cannot be signed there. Never say the agreement is legally binding or that the signature is a qualified electronic signature.',
      };
    },

    agreement_list: async ({ playerId } = {}) => {
      const list = await agreements.listAgreements(db, String(playerId || ''), { now: now(), withUrl: role === 'admin' });
      return { count: list.length, agreements: list.map(line) };
    },

    agreement_link: async ({ action, agreementId, days } = {}) => {
      adminOnly('change an agreement\'s link');
      try {
        if (action === 'revoke') {
          const a = await agreements.revokeLink(db, agreementId, { now: now() });
          if (!a) throw new Error('agreement not found; take agreementId from agreement_list');
          return { stopped: true, already: !!a.link.revokedAt, player: a.playerName, note: 'The link no longer works for anyone. A new one can be issued (action=reissue).' };
        }
        if (action === 'reissue') {
          const r = await agreements.reissueLink(db, agreementId, { days, now: now() });
          if (!r) throw new Error('agreement not found; take agreementId from agreement_list');
          return { link: r.url, player: r.agreement.playerName, worksDays: r.days, ...(r.clamped ? { note: `A link works ${agreements.MAX_LINK_DAYS} days at most.` } : {}),
            instruction: 'Give the writer the new link on its own line and say the old link stopped working. He sends it on himself.' };
        }
      } catch (e) { return answer(e); }
      throw new Error('action is revoke or reissue');
    },

    agreement_template: async ({ action, lang, text, defaultMonths, maxMonths, agencyName } = {}) => {
      adminOnly('change the agreement template');
      const l = lang === 'en' ? 'en' : 'he';
      const ref = db.collection(agreements.TEMPLATES).doc(l);
      if (action === 'show') {
        const t = await agreements.templateView(db, l);
        return t ? { exists: true, lang: l, version: t.version, defaultMonths: t.defaultMonths, maxMonths: t.maxMonths, agencyName: t.agencyName, text: t.text, placeholders: AGREEMENT_PLACEHOLDERS.map((p) => p.key) }
          : { exists: false, lang: l, note: agreements.NO_TEMPLATE[l], placeholders: AGREEMENT_PLACEHOLDERS.map((p) => p.key) };
      }
      if (action === 'propose') {
        const body = String(text || '').replace(/\r\n?/g, '\n').trim();
        const check = checkTemplate(body);
        if (!check.ok) return { refused: true, reason: agreements.templateProblem(check) };
        if (LOOKS_PRIVATE.test(body)) return { refused: true, reason: 'the text still holds a long number (an ID or a phone?): put a placeholder in its place, a template never keeps a real person\'s details. If it is the agency\'s own registration number, the writer adds it himself in System › Agreements' };
        const settings = agreements.periodSettings({ defaultMonths, maxMonths });
        await ref.set({ draft: { text: body, ...settings, agencyName: String(agencyName || '').slice(0, 60), by: me, turn, at: now() } }, { merge: true });
        return { proposed: true, lang: l, ...settings, placeholdersUsed: check.used,
          instruction: 'Show the writer the whole text as it will be saved, say nothing is saved yet, and ask with buttons [[כפתורים: לשמור, לשנות]]. Only after the yes in a LATER message call action=save.' };
      }
      if (action === 'save') {
        const snap = await ref.get();
        const d = snap.exists ? snap.data().draft : null;
        if (!d || !d.text) return { refused: true, reason: 'there is no proposal waiting: propose the text first' };
        if (String(d.by || '').toLowerCase() !== me) return { refused: true, reason: 'the waiting proposal is someone else\'s: propose it again' };
        if (!(turn > Number(d.turn))) throw new Error('the writer has not answered the proposal yet: show it, ask, and save only after the yes in a later message');
        try {
          const r = await agreements.saveTemplate(db, { lang: l, text: d.text, defaultMonths: d.defaultMonths, maxMonths: d.maxMonths, agencyName: d.agencyName, by: { email: me, name: sender }, now: now() });
          return { saved: true, lang: l, version: r.version, note: 'Saved as the new version; earlier versions are kept and agreements already made keep their own text.' };
        } catch (e) { return answer(e); }
      }
      throw new Error('action is show, propose or save');
    },
  };
}

module.exports = { agreementTools, AGREEMENT_TOOL_DEFS, STATE_HE };
