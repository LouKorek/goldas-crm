// /sign/<token>: the page a player, or his parent or guardian, opens on the
// phone to sign a representation agreement. The agreement's own text as
// readable text (never an embedded PDF), right to left in Hebrew; then, for
// each person who signs, the full name, the ID or passport number and a
// signature drawn with a finger; one consent box; a look at exactly what will
// be sent; and the signature. In the agency's public look, the same as the
// live player page (components/public/PublicLook.jsx).
//
// No sign-in: the token in the link is the key, good once, until it expires
// or is revoked (netlify/functions/agreement-sign.js). After signing, the
// signer may download the signed PDF for a short while (the copy key is kept
// in this tab only, so a reload still finds it); any other link that does not
// work gets one calm sentence.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { agreementBlocks } from '@goldas/domain';
import { loadAgreement, signAgreement, copyStatus, copyUrl } from 'data/agreements';
import { GOLD, INK, MUTED, RULE, CARD, LOGO, PAPER, PAPER_INK, ERROR, ERROR_INK, usePrivatePage, Shell as PublicShell, Loading, Message, Guard, BROKEN } from 'components/public/PublicLook';
import SignaturePad from 'components/SignaturePad';

const TEXT = {
  en: {
    agency: 'Football Agency', title: 'Representation agreement', read: 'Please read the whole agreement before you sign.',
    sign: 'Signing', player: 'The player', guardian: 'Parent or guardian', name: 'Full name', id: 'ID or passport number',
    idHint: 'As in the ID card or the passport.', relation: 'Relation to the player', relations: { father: 'Father', mother: 'Mother', guardian: 'Legal guardian' },
    draw: 'Signature', drawHint: 'Sign with your finger or the mouse.', clear: 'Clear', choose: 'Choose…',
    consent: 'I have read the agreement above and I sign it of my own free will.', consentMinor: 'I have read the agreement above and I sign it of my own free will, as the parent or legal guardian of the player.',
    review: 'Review what will be sent', back: 'Back', send: 'Sign the agreement', sending: 'Signing…',
    reviewTitle: 'This is what will be sent', reviewNote: 'Together with the agreement text exactly as shown above. After signing it cannot be changed.',
    fingerprint: 'Text fingerprint', consentGiven: 'Consent', yes: 'Given',
    done: 'Thank you. The agreement is signed.', doneSub: 'Gold A&S has received it. You can keep a copy of the signed agreement:',
    download: 'Download the signed copy', preparing: 'Preparing the signed copy…', notYet: 'The signed copy is not ready yet. Try again in a minute.',
    until: 'The download is available until', later: 'Gold A&S will send you a copy as well.',
    until2: 'Private link, valid until', preview: 'Preview. You are signed in to the CRM: this opening is not counted and the agreement cannot be signed here.',
    problems: {
      consent: 'Please tick the consent box.', name: 'Please write the full name of everyone who signs.', id: 'Please check the ID or passport number (letters and digits only).',
      relation: 'Please choose the relation to the player.', signature: 'Please sign in the box (or clear it and sign again).', signers: 'Something is missing in the signing details.',
      text: 'The agreement changed while the page was open. Please reload the page and read it again.',
    },
    failed: 'The signature was not sent. Please check the details and try again.',
    nameOne: 'Please write the full name.', fix: 'Something is missing or needs fixing. It is marked above.',
  },
  he: {
    agency: 'סוכנות כדורגל', title: 'הסכם ייצוג', read: 'נא לקרוא את כל ההסכם לפני החתימה.',
    sign: 'חתימה', player: 'השחקן', guardian: 'ההורה או האפוטרופוס', name: 'שם מלא', id: 'מספר תעודת זהות או דרכון',
    idHint: 'כמו בתעודת הזהות או בדרכון.', relation: 'הקרבה לשחקן', relations: { father: 'אב', mother: 'אם', guardian: 'אפוטרופוס חוקי' },
    draw: 'חתימה', drawHint: 'חתמו עם האצבע או עם העכבר.', clear: 'ניקוי', choose: 'בחירה…',
    consent: 'קראתי את ההסכם שלמעלה ואני חותם עליו מרצוני.', consentMinor: 'קראתי את ההסכם שלמעלה ואני חותם עליו מרצוני, כהורה או כאפוטרופוס החוקי של השחקן.',
    review: 'לבדיקת הפרטים לפני השליחה', back: 'חזרה', send: 'חתימה על ההסכם', sending: 'חותמים…',
    reviewTitle: 'אלה הפרטים שיישלחו', reviewNote: 'יחד עם נוסח ההסכם בדיוק כפי שהוצג למעלה. אחרי החתימה אי אפשר לשנות.',
    fingerprint: 'טביעת האצבע של הנוסח', consentGiven: 'הסכמה', yes: 'ניתנה',
    done: 'תודה. ההסכם נחתם.', doneSub: 'ההסכם הגיע ל-Gold A&S. אפשר לשמור עותק של ההסכם החתום:',
    download: 'הורדת העותק החתום', preparing: 'מכינים את העותק החתום…', notYet: 'העותק החתום עוד לא מוכן. נסו שוב בעוד דקה.',
    until: 'ההורדה זמינה עד', later: 'Gold A&S ישלחו לכם עותק גם בעצמם.',
    until2: 'קישור פרטי, בתוקף עד', preview: 'תצוגה מקדימה. את/ה מחובר/ת ל-CRM: הפתיחה הזו לא נספרת, ואי אפשר לחתום כאן.',
    problems: {
      consent: 'נא לסמן את תיבת ההסכמה.', name: 'נא לכתוב את השם המלא של כל מי שחותם.', id: 'נא לבדוק את מספר הזהות או הדרכון (אותיות וספרות בלבד).',
      relation: 'נא לבחור את הקרבה לשחקן.', signature: 'נא לחתום בתיבה (או לנקות ולחתום שוב).', signers: 'חסר משהו בפרטי החתימה.',
      text: 'נוסח ההסכם השתנה בזמן שהעמוד היה פתוח. נא לרענן את העמוד ולקרוא שוב.',
    },
    failed: 'החתימה לא נשלחה. נא לבדוק את הפרטים ולנסות שוב.',
    nameOne: 'נא לכתוב את השם המלא.', fix: 'יש פרטים שחסרים או שצריך לתקן. הם מסומנים למעלה.',
  },
};

const DEAD = { en: 'This link is no longer available. Please ask Gold A&S for a new one.', he: 'הקישור הזה כבר לא זמין. אפשר לבקש קישור חדש מהסוכנות.' };
const COPY_KEY = (token) => `gas-sign-copy:${token}`;
// An ID or passport number: letters and digits, 5 to 20, once spaces and dashes are taken out (the server checks the same).
const ID_OK = (v) => /^[A-Z0-9]{5,20}$/.test(String(v || '').replace(/[\s-]/g, '').toUpperCase());

// This page's own parts; the frame, cards, buttons and messages come from PublicLook.
const CSS = `
.sg-wrap { max-width: 760px; }
.sg-title { font-family: 'Bebas Neue', 'Heebo', sans-serif; font-weight: 400; font-size: clamp(34px, 9vw, 52px); line-height: 1; letter-spacing: 0.02em; margin: 0; color: ${INK}; }
.pp[dir="rtl"] .sg-title { font-family: 'Heebo', system-ui, sans-serif; font-weight: 700; letter-spacing: 0; line-height: 1.15; font-size: clamp(30px, 8vw, 44px); }
.sg-lead { color: ${MUTED}; margin: 8px 0 0; font-size: 14px; }
.sg-doc { background: ${PAPER}; color: ${PAPER_INK}; border-radius: 14px; padding: 22px 18px; font-size: 15.5px; line-height: 1.75; max-height: 64vh; overflow-y: auto; border: 1px solid ${RULE}; }
.sg-doc h3 { font-size: 16.5px; margin: 18px 0 6px; line-height: 1.4; }
.sg-doc h3:first-child { margin-top: 0; }
.sg-doc p { margin: 0 0 12px; white-space: pre-line; overflow-wrap: anywhere; }
.sg-who { display: grid; gap: 14px; padding: 16px 0; border-top: 1px solid ${RULE}; }
.sg-who:first-of-type { border-top: 0; padding-top: 0; }
.sg-who h3 { margin: 0; font-size: 16px; color: ${GOLD}; }
.sg-field { display: grid; gap: 6px; }
.sg-field label, .sg-field .sg-k { font-size: 13.5px; color: ${MUTED}; }
.sg-field small { font-size: 12px; color: ${MUTED}; }
.sg-input { width: 100%; min-height: 48px; padding: 10px 14px; border-radius: 12px; border: 1px solid ${RULE}; background: rgba(244,240,230,0.06); color: ${INK}; font: inherit; font-size: 16px; }
/* The CRM's own field styles reach every input on the site (with !important); this page keeps the public look in either theme. */
.pp .sg-input, .pp .sg-input:focus { background: rgba(244,240,230,0.06) !important; box-shadow: none; color: ${INK} !important; font-family: inherit; border-bottom-color: ${RULE}; border-radius: 12px; min-height: 48px; padding: 10px 14px; font-size: 16px; }
.pp .sg-input:hover:not(:focus) { border-color: ${RULE}; }
.pp .sg-input:focus { border-color: ${GOLD}; outline: none; }
.pp .sg-input[aria-invalid="true"] { border-color: ${ERROR}; }
.sg-err { font-size: 13px; line-height: 1.45; color: ${ERROR_INK}; }
.pp select.sg-input option { background: ${PAPER} !important; color: ${PAPER_INK} !important; }
.sg-pad .sigpad-canvas { background: ${PAPER}; color: ${PAPER_INK}; border: 1px solid ${RULE}; }
.sg-pad[data-invalid="true"] .sigpad-canvas { border-color: ${ERROR}; box-shadow: 0 0 0 1px ${ERROR}; }
.sg-pad .sigpad-hint { color: ${MUTED}; }
.sg-pad .sigpad-clear { background: transparent; color: ${GOLD}; border: 1px solid ${RULE}; border-radius: 10px; padding: 8px 14px; font: inherit; font-size: 13.5px; cursor: pointer; min-height: 48px; }
.sg-pad .sigpad-clear:disabled { opacity: 0.4; cursor: default; }
.sg-consent { display: flex; gap: 12px; align-items: flex-start; padding: 14px; border: 1px solid ${RULE}; border-radius: 12px; cursor: pointer; font-size: 14.5px; }
.sg-consent[data-invalid="true"] { border-color: ${ERROR}; }
.sg-consent-err { display: block; margin-top: 6px; }
/* The CRM sets every checkbox's width to auto with !important; this one stays a full finger target. */
.pp .sg-consent input { width: 22px !important; height: 22px; min-height: 0; padding: 0; margin: 1px 0 0; accent-color: ${GOLD}; flex: none; background: transparent !important; box-shadow: none; }
.sg-errors { border: 1px solid ${ERROR}; color: ${ERROR_INK}; background: rgba(228,139,122,0.1); border-radius: 12px; padding: 10px 14px; font-size: 14px; display: grid; gap: 4px; }
.sg-review { display: grid; gap: 12px; }
.sg-review img { width: 100%; max-width: 320px; background: ${PAPER}; border-radius: 10px; border: 1px solid ${RULE}; display: block; }
.sg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; color: ${MUTED}; direction: ltr; text-align: start; }
.sg-done { display: grid; gap: 14px; justify-items: center; text-align: center; }
.sg-tick { width: 64px; height: 64px; border-radius: 50%; background: ${GOLD}; color: ${CARD}; display: flex; align-items: center; justify-content: center; font-size: 34px; font-weight: 700; }
`;
const Shell = (props) => <PublicShell css={CSS} {...props} />;
const until = (iso, lang) => (iso ? new Date(iso).toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const readCopy = (token) => { try { const v = JSON.parse(sessionStorage.getItem(COPY_KEY(token)) || 'null'); return v && Date.parse(v.until) > Date.now() ? v : null; } catch { return null; } };
const keepCopy = (token, v) => { try { sessionStorage.setItem(COPY_KEY(token), JSON.stringify(v)); } catch { /* a private window: the copy shows until the page is left */ } };

function Top({ L }) {
  return (
    <header className="pp-top">
      <img className="pp-logo" src={LOGO} alt="" />
      <div>
        <div className="pp-brand" dir="ltr">GOLD A&amp;S</div>
        <div className="pp-sub">{L.agency}</div>
      </div>
    </header>
  );
}

/** After signing: a quiet confirmation and the signed copy, for a short while. */
function Done({ copy, lang }) {
  const L = TEXT[lang];
  const [ready, setReady] = useState(!!copy.ready);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (ready) return undefined;
    let live = true, tries = 0;
    const tick = async () => {
      tries += 1;
      try { const r = await copyStatus(copy.copy); if (!live) return; if (r.ready) { setReady(true); return; } } catch { if (live) setGone(true); return; }
      if (live && tries < 20) setTimeout(tick, 4000);
    };
    const t = setTimeout(tick, 1500);
    return () => { live = false; clearTimeout(t); };
  }, [copy.copy, ready]);
  return (
    <Shell lang={lang}>
      <div className="pp-wrap sg-wrap">
        <Top L={L} />
        <section className="pp-card sg-done" aria-live="polite">
          <div className="sg-tick" aria-hidden="true">✓</div>
          <h1 className="sg-title" style={{ fontSize: 'clamp(26px, 7vw, 36px)' }}>{L.done}</h1>
          {!gone && <p className="sg-lead" style={{ margin: 0 }}>{L.doneSub}</p>}
          {gone ? <p className="sg-lead" style={{ margin: 0 }}>{L.later}</p>
            : ready ? <a className="pp-btn pp-btn-gold" href={copyUrl(copy.copy)} download>{L.download}</a>
              : <button type="button" className="pp-btn pp-btn-line" disabled><span className="pp-pulse">{L.preparing}</span></button>}
          {!gone && <small style={{ color: MUTED }}>{L.until} {until(copy.until, lang)}</small>}
        </section>
      </div>
    </Shell>
  );
}

function SignerFields({ role, L, value, onChange, showErrors }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const bad = (k) => showErrors && ((k === 'name' && value.name.trim().length < 2) || (k === 'id' && !ID_OK(value.idNumber)) || (k === 'relation' && !value.relation));
  const id = `sg-${role}`;
  const noSign = showErrors && !value.signature;
  const err = (k, text) => (bad(k) ? <span className="sg-err" id={`${id}-${k}-err`}>{text}</span> : null);
  return (
    <div className="sg-who">
      <h3>{role === 'guardian' ? L.guardian : L.player}</h3>
      <div className="sg-field">
        <label htmlFor={`${id}-name`}>{L.name}</label>
        <input id={`${id}-name`} className="sg-input" value={value.name} onChange={set('name')} autoComplete="name" aria-invalid={bad('name')} aria-describedby={bad('name') ? `${id}-name-err` : undefined} maxLength={80} />
        {err('name', L.nameOne)}
      </div>
      <div className="sg-field">
        <label htmlFor={`${id}-id`}>{L.id}</label>
        <input id={`${id}-id`} className="sg-input" value={value.idNumber} onChange={set('idNumber')} autoComplete="off" inputMode="text" dir="ltr" aria-invalid={bad('id')} aria-describedby={bad('id') ? `${id}-id-err` : `${id}-idh`} maxLength={30} />
        {bad('id') ? err('id', L.problems.id) : <small id={`${id}-idh`}>{L.idHint}</small>}
      </div>
      {role === 'guardian' && (
        <div className="sg-field">
          <label htmlFor={`${id}-rel`}>{L.relation}</label>
          <select id={`${id}-rel`} className="sg-input" value={value.relation} onChange={set('relation')} aria-invalid={bad('relation')} aria-describedby={bad('relation') ? `${id}-relation-err` : undefined}>
            <option value="">{L.choose}</option>
            {Object.entries(L.relations).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {err('relation', L.problems.relation)}
        </div>
      )}
      <div className="sg-field sg-pad" data-invalid={noSign ? 'true' : undefined}>
        <span className="sg-k">{L.draw}</span>
        <SignaturePad label={`${L.draw}: ${role === 'guardian' ? L.guardian : L.player}`} clearLabel={L.clear} hint={L.drawHint}
          describedBy={noSign ? `${id}-sign-err` : undefined} onChange={(png) => onChange({ ...value, signature: png })} />
        {noSign && <span className="sg-err" id={`${id}-sign-err`}>{L.problems.signature}</span>}
      </div>
    </div>
  );
}

function Page({ token }) {
  const [state, setState] = useState({ phase: 'loading' });
  const [signers, setSigners] = useState({});
  const [consent, setConsent] = useState(false);
  const [step, setStep] = useState('fill');            // fill → review → (signed)
  const [serverErrors, setServerErrors] = useState([]);
  const [showErrors, setShowErrors] = useState(false);
  const [sending, setSending] = useState(false);
  const fill = useRef(null);
  const a = state.data?.agreement;
  const lang = a?.lang === 'en' ? 'en' : 'he';
  const L = TEXT[lang];
  usePrivatePage(a ? `${L.title} · Gold A&S` : 'Gold A&S');
  const blocks = useMemo(() => (a ? agreementBlocks(a.text) : []), [a]);

  useEffect(() => {
    let live = true;
    const kept = readCopy(token);
    if (kept) { setState({ phase: 'signed', copy: kept, lang: kept.lang }); return undefined; }
    loadAgreement(token).then((data) => {
      if (!live) return;
      const n = data.agreement.names || {};
      setSigners(Object.fromEntries(data.agreement.needs.map((r) => [r, { name: r === 'guardian' ? n.guardian || '' : n.player || '', idNumber: '', relation: '', signature: null }])));
      setState({ phase: 'ready', data });
    }).catch((e) => { if (live) setState({ phase: e.status === 404 ? 'gone' : 'broken' }); });
    return () => { live = false; };
  }, [token]);

  if (state.phase === 'loading') return <Loading />;
  if (state.phase === 'gone') return <Message en={DEAD.en} he={DEAD.he} />;
  if (state.phase === 'broken') return <Message en={BROKEN.en} he={BROKEN.he} />;
  if (state.phase === 'signed') return <Done copy={state.copy} lang={state.lang === 'en' ? 'en' : 'he'} />;

  const needs = a.needs;
  const minor = needs.includes('guardian');
  const localProblems = () => {
    const p = [];
    if (needs.some((r) => (signers[r]?.name || '').trim().length < 2)) p.push('name');
    if (needs.some((r) => !ID_OK(signers[r]?.idNumber))) p.push('id');
    if (minor && !signers.guardian?.relation) p.push('relation');
    if (needs.some((r) => !signers[r]?.signature)) p.push('signature');
    if (!consent) p.push('consent');
    return p;
  };
  // Once the signer tried to go on, each message sits by its own field and follows what is still missing as it is fixed;
  // the box at the end says that something is marked, and carries what only the server found.
  const local = showErrors ? localProblems() : [];
  const fromServer = [...new Set(serverErrors)].filter((p) => !local.includes(p));
  const noConsent = local.includes('consent');
  const toReview = () => {
    setShowErrors(true);
    setServerErrors([]);
    if (!localProblems().length) { setStep('review'); return; }
    // Bring the first thing to fix into view (on a phone it is often above the screen) and put the cursor in it.
    requestAnimationFrame(() => {
      const first = fill.current?.querySelector('[aria-invalid="true"], [data-invalid="true"]');
      if (!first) return;
      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      first.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
      (first.matches('input, select') ? first : first.querySelector('input'))?.focus({ preventScroll: true });
    });
  };
  const send = async () => {
    setSending(true);
    setServerErrors([]);
    try {
      const r = await signAgreement(token, {
        consent: true, textHash: a.textHash,
        signers: needs.map((role) => ({ role, name: signers[role].name.trim(), idNumber: signers[role].idNumber, ...(role === 'guardian' ? { relation: signers[role].relation } : {}), signature: signers[role].signature })),
      });
      const copy = { copy: r.copy, until: r.copyUntil, ready: r.filed, lang };
      keepCopy(token, copy);
      setState({ phase: 'signed', copy, lang });
    } catch (e) {
      setSending(false);
      if (e.status === 404 || e.locked) { setState({ phase: 'gone' }); return; }
      setServerErrors(e.problems?.length ? e.problems : ['failed']);
      setStep('fill');
    }
  };

  return (
    <Shell lang={lang}>
      <div className="pp-wrap sg-wrap">
        <Top L={L} />
        {state.data.preview && <div className="pp-note" role="status">{L.preview}</div>}
        <section className="pp-card">
          <div className="pp-eyebrow">{a.agencyName}</div>
          <h1 className="sg-title">{L.title}</h1>
          <p className="sg-lead">{L.read}</p>
        </section>
        <section className="pp-card" aria-label={L.title}>
          <article className="sg-doc" dir={lang === 'he' ? 'rtl' : 'ltr'} lang={lang} tabIndex={0}>
            {blocks.map((b, i) => (b.type === 'h' ? <h3 key={i}>{b.text}</h3> : <p key={i}>{b.text}</p>))}
          </article>
        </section>

        {/* Kept mounted while reviewing, so going back finds the drawn signatures as they were. */}
        <section className="pp-card" hidden={step !== 'fill'} ref={fill}>
            <h2 className="pp-label">{L.sign}</h2>
            {needs.map((role) => (
              <SignerFields key={role} role={role} L={L} value={signers[role]} showErrors={showErrors}
                onChange={(v) => setSigners((s) => ({ ...s, [role]: v }))} />
            ))}
            <label className="sg-consent" data-invalid={noConsent ? 'true' : undefined}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-invalid={noConsent} aria-describedby={noConsent ? 'sg-consent-err' : undefined} />
              <span>{minor ? L.consentMinor : L.consent}</span>
            </label>
            {noConsent && <span className="sg-err sg-consent-err" id="sg-consent-err">{L.problems.consent}</span>}
            {(local.length > 0 || fromServer.length > 0) && (
              <div className="sg-errors" role="alert" style={{ marginTop: 14 }}>
                {local.length > 0 && <span>{L.fix}</span>}
                {fromServer.map((p) => <span key={p}>{L.problems[p] || L.failed}</span>)}
              </div>
            )}
            <div className="pp-actions" style={{ marginTop: 16 }}>
              <button type="button" className="pp-btn pp-btn-gold" onClick={toReview} disabled={!!state.data.preview}>{L.review}</button>
            </div>
        </section>

        {step === 'review' && (
          <section className="pp-card sg-review" aria-live="polite">
            <h2 className="pp-label">{L.reviewTitle}</h2>
            {needs.map((role) => (
              <dl key={role} style={{ margin: 0 }}>
                <div className="pp-row"><dt>{role === 'guardian' ? L.guardian : L.player}</dt><dd><bdi>{signers[role].name.trim()}</bdi></dd></div>
                <div className="pp-row"><dt>{L.id}</dt><dd dir="ltr" style={{ textAlign: 'start' }}>{signers[role].idNumber.replace(/[\s-]/g, '').toUpperCase()}</dd></div>
                {role === 'guardian' && <div className="pp-row"><dt>{L.relation}</dt><dd>{L.relations[signers[role].relation]}</dd></div>}
                <div className="pp-row"><dt>{L.draw}</dt><dd><img src={signers[role].signature} alt={L.draw} /></dd></div>
              </dl>
            ))}
            <dl style={{ margin: 0 }}>
              <div className="pp-row"><dt>{L.consentGiven}</dt><dd>{L.yes}: {minor ? L.consentMinor : L.consent}</dd></div>
              <div className="pp-row"><dt>{L.fingerprint} <bdi dir="ltr" style={{ whiteSpace: 'nowrap' }}>(SHA&#8209;256)</bdi></dt><dd className="sg-mono">{a.textHash}</dd></div>
            </dl>
            <p className="sg-lead" style={{ margin: 0 }}>{L.reviewNote}</p>
            <div className="pp-actions">
              <button type="button" className="pp-btn pp-btn-gold" onClick={send} disabled={sending || !!state.data.preview}>{sending ? L.sending : L.send}</button>
              <button type="button" className="pp-btn pp-btn-line" onClick={() => setStep('fill')} disabled={sending}>{L.back}</button>
            </div>
          </section>
        )}

        <footer className="pp-foot">
          <div><a href="https://gold-as.com" rel="noreferrer noopener">gold-as.com</a></div>
          {a.expiresAt && <small>{L.until2} {until(a.expiresAt, lang)}</small>}
        </footer>
      </div>
    </Shell>
  );
}

export default function SignPage({ token }) {
  return <Guard><Page token={token} /></Guard>;
}
