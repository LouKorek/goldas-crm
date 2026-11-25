// System › Agreements: the agency's representation agreement template, one
// per language, and the agency's own drawn signature.
//
// The template is the agency's own text: '# ' starts a heading, a blank line
// a new paragraph, and fixed placeholders ({{player_name}} …) are filled in
// for each player when an agreement is made; {{#minor}}…{{/minor}} holds
// text only for a player under 18 and {{#adult}}…{{/adult}} only for an adult.
// Every save is a new version; earlier versions stay and an agreement keeps
// the exact text it was made with. The preview fills the text being edited
// for a chosen player, here in the browser, before anything is saved.
//
// The signature is drawn once and placed, with the admin's name and the time,
// on every agreement that admin makes (without it the PDF prints the agency's
// name and the name of the admin who made it).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AGREEMENT_PLACEHOLDERS, checkTemplate, fillTemplate, agreementValues, agreementBlocks, agreementPeriod, isMinorOn, israelDate, AGREEMENT_DEFAULT_MONTHS, AGREEMENT_MAX_MONTHS, playerName } from '@goldas/domain';
import { t, fmtDateTime, getLang } from 'lib/i18n';
import { Skeleton, Field, toast, useConfirm } from 'components/ui/UI';
import SignaturePad from 'components/SignaturePad';
import { listenPlayers } from 'data/players';
import { loadAgreementSettings, saveAgreementTemplate, saveAgencySignature, clearAgencySignature } from 'data/agreements';

const Card = ({ children, style }) => <div className="card" style={{ padding: 16, ...style }}>{children}</div>;
const Title = ({ children }) => <div style={{ fontWeight: 700, marginBottom: 6 }}>{children}</div>;
const blank = { text: '', defaultMonths: AGREEMENT_DEFAULT_MONTHS, maxMonths: AGREEMENT_MAX_MONTHS, agencyName: 'Gold A&S' };

function Template({ lang, saved, players, onSaved }) {
  const [form, setForm] = useState(saved ? { text: saved.text, defaultMonths: saved.defaultMonths, maxMonths: saved.maxMonths, agencyName: saved.agencyName } : blank);
  const [busy, setBusy] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const area = useRef(null);
  useEffect(() => { setForm(saved ? { text: saved.text, defaultMonths: saved.defaultMonths, maxMonths: saved.maxMonths, agencyName: saved.agencyName } : blank); }, [saved, lang]);

  const check = useMemo(() => checkTemplate(form.text), [form.text]);
  const dirty = !saved ? form.text.trim() !== '' : form.text !== saved.text || Number(form.defaultMonths) !== saved.defaultMonths || Number(form.maxMonths) !== saved.maxMonths || form.agencyName !== saved.agencyName;
  const player = players.find((p) => p.id === playerId) || null;
  const preview = useMemo(() => {
    if (!player || !check.ok) return null;
    const today = israelDate();
    const minor = isMinorOn(player.dob, today) === true;
    const period = agreementPeriod({ start: today, defaultMonths: Math.min(Number(form.defaultMonths) || AGREEMENT_DEFAULT_MONTHS, Number(form.maxMonths) || AGREEMENT_MAX_MONTHS), maxMonths: Number(form.maxMonths) || AGREEMENT_MAX_MONTHS });
    if (!period.ok) return null;
    const values = agreementValues({ playerName: playerName(player), dob: player.dob, guardianName: minor ? t('(the parent or guardian)') : '', start: period.start, end: period.end, months: period.months, agencyName: form.agencyName || 'Gold A&S', today });
    const filled = fillTemplate(form.text, values, { minor, lang });
    return { minor, missing: filled.missing, blocks: agreementBlocks(filled.text) };
  }, [player, form, check.ok, lang]);

  const insert = (key) => {
    const el = area.current;
    const tag = `{{${key}}}`;
    if (!el) { setForm((f) => ({ ...f, text: f.text + tag })); return; }
    const { selectionStart: a, selectionEnd: b } = el;
    const next = form.text.slice(0, a) + tag + form.text.slice(b);
    setForm((f) => ({ ...f, text: next }));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); });
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await saveAgreementTemplate({ lang, ...form, defaultMonths: Number(form.defaultMonths), maxMonths: Number(form.maxMonths) });
      toast.success(t('Saved as version {v}.', { v: r.version }));
      onSaved(lang, r.template);
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    setBusy(false);
  };
  const problems = [
    check.unknown.length ? t('Unknown placeholders: {list}', { list: check.unknown.map((k) => `{{${k}}}`).join(', ') }) : '',
    check.sections.length ? t('Sections not closed properly: {list}', { list: check.sections.map((k) => `{{#${k}}}`).join(', ') }) : '',
    check.tooLong ? t('The text is too long.') : '',
  ].filter(Boolean);
  const he = getLang() === 'he';

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card>
        <Title>{lang === 'he' ? t('The Hebrew template') : t('The English template')}</Title>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 10 }}>
          {saved ? t('Version {v} · saved {when}{by}', { v: saved.version, when: fmtDateTime(saved.updatedAt), by: saved.updatedByName ? ` · ${saved.updatedByName}` : '' })
            : t('No template in this language yet: agreements in it cannot be made until one is saved.')}
        </div>
        <Field label={t('The agreement text')} hint={<>{t("'# ' at the start of a line makes a heading; a blank line starts a new paragraph.")}{lang === 'he' && <> {t('While you type in Hebrew, {a} and {b} can look reversed here; the preview shows them as they really are.', { a: '\u2066{{#minor}}\u2069', b: '\u2066{{/minor}}\u2069' })}</>}</>} error={problems.join(' · ')}>
          <textarea ref={area} value={form.text} onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))} dir={lang === 'he' ? 'rtl' : 'ltr'} rows={16}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, minHeight: 280 }} aria-label={t('The agreement text')} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginTop: 10 }}>
          <Field label={t('Default length (months)')}><input type="number" min="1" max={AGREEMENT_MAX_MONTHS} value={form.defaultMonths} onChange={(e) => setForm((f) => ({ ...f, defaultMonths: e.target.value }))} /></Field>
          <Field label={t('Longest allowed (months)')} hint={t('{n} at most.', { n: AGREEMENT_MAX_MONTHS })}><input type="number" min="1" max={AGREEMENT_MAX_MONTHS} value={form.maxMonths} onChange={(e) => setForm((f) => ({ ...f, maxMonths: e.target.value }))} /></Field>
          <Field label={t("The agency's name as printed")}><input value={form.agencyName} onChange={(e) => setForm((f) => ({ ...f, agencyName: e.target.value }))} maxLength={60} /></Field>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy || !dirty || !check.ok}>{busy ? t('Saving…') : saved ? t('Save as a new version') : t('Save the template')}</button>
          {dirty && saved && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ text: saved.text, defaultMonths: saved.defaultMonths, maxMonths: saved.maxMonths, agencyName: saved.agencyName })}>{t('Undo changes')}</button>}
        </div>
      </Card>

      <Card>
        <Title>{t('Placeholders')}</Title>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>{t('Click one to put it where the cursor is. Only these are allowed.')}</div>
        <div style={{ display: 'grid', gap: 4 }}>
          {AGREEMENT_PLACEHOLDERS.map((p) => (
            <div key={p.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, auto) minmax(0, 1fr)', gap: 10, alignItems: 'baseline', fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid var(--rule)' }}>
              <button type="button" className="chip" onClick={() => insert(p.key)} dir="ltr" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, justifySelf: 'start' }}>{`{{${p.key}}}`}</button>
              <span style={{ color: 'var(--text-2)' }}>{he ? p.he : p.en}</span>
            </div>
          ))}
          {[['#minor', t('Text only for a player under 18, closed with {{/minor}}')], ['#adult', t('Text only for an adult player, closed with {{/adult}}')]].map(([k, d]) => (
            <div key={k} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, auto) minmax(0, 1fr)', gap: 10, alignItems: 'baseline', fontSize: 12.5, padding: '3px 0' }}>
              <code dir="ltr" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{`{{${k}}}…{{/${k.slice(1)}}}`}</code>
              <span style={{ color: 'var(--text-2)' }}>{d}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <Title>{t('Preview for a player')}</Title>
        <Field label={t('Player')}>
          <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
            <option value="">{t('Choose a player…')}</option>
            {players.map((p) => <option key={p.id} value={p.id}>{playerName(p)}</option>)}
          </select>
        </Field>
        {preview && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 6 }}>
              {preview.minor ? t('Under 18: the minor sections are in.') : t('An adult: the adult sections are in.')} {t('Starting today, for the default length. The ID numbers are typed by the signer.')}
              {preview.missing.length > 0 && <span style={{ color: 'var(--red)' }}> {t('Missing on this player: {list}', { list: preview.missing.map((k) => `{{${k}}}`).join(', ') })}</span>}
            </div>
            <article dir={lang === 'he' ? 'rtl' : 'ltr'} lang={lang} style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', padding: '14px 16px', fontSize: 13.5, lineHeight: 1.7, maxHeight: 420, overflowY: 'auto' }}>
              {preview.blocks.map((b, i) => (b.type === 'h'
                ? <h4 key={i} style={{ margin: i ? '14px 0 4px' : '0 0 4px', fontSize: 14 }}>{b.text}</h4>
                : <p key={i} style={{ margin: '0 0 10px', whiteSpace: 'pre-line' }}>{b.text}</p>))}
            </article>
          </div>
        )}
      </Card>
    </div>
  );
}

function AgencySignature({ signature, onChange }) {
  const [png, setPng] = useState(null);
  const [busy, setBusy] = useState(false);
  const [redraw, setRedraw] = useState(!signature?.has);
  const { confirm, dialog } = useConfirm();
  useEffect(() => { setRedraw(!signature?.has); }, [signature?.has]);
  const save = async () => {
    setBusy(true);
    try { await saveAgencySignature(png); toast.success(t('Your signature was saved.')); onChange(); } catch (e) { toast.error(e.message || t('Save failed.')); }
    setBusy(false);
  };
  const clear = async () => {
    if (!(await confirm(t('Remove your saved signature? Agreements you make from now on carry your name without a drawn signature.'), { title: t('Remove signature'), confirmLabel: t('Remove') }))) return;
    try { await clearAgencySignature(); onChange(); } catch (e) { toast.error(e.message || t('Save failed.')); }
  };
  return (
    <Card>
      <Title>{t("The agency's signature")}</Title>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 10 }}>
        {t('Drawn once, and placed with your name and the time on every agreement you make. Without it the signed PDF prints the agency\'s name and yours.')}
      </div>
      {!redraw && signature?.png ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <img src={signature.png} alt={t("The agency's signature")} style={{ maxWidth: 320, width: '100%', border: '1px solid var(--border)', background: 'var(--surface-2)', filter: document.documentElement.dataset.theme === 'dark' ? 'invert(1)' : 'none' }} />
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{signature.name}{signature.savedAt ? ` · ${fmtDateTime(signature.savedAt)}` : ''}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRedraw(true)}>{t('Draw again')}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>{t('Remove')}</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
          <div style={{ color: 'var(--text-1)' }}>
            <SignaturePad label={t("The agency's signature")} clearLabel={t('Clear')} hint={t('Sign with the mouse, a pen or a finger.')} onChange={setPng} height={160}
              canvasStyle={{ border: '1px solid var(--border)', background: 'var(--surface-2)', borderRadius: 0 }} clearClassName="btn btn-ghost btn-sm" hintStyle={{ color: 'var(--text-3)' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!png || busy}>{busy ? t('Saving…') : t('Save signature')}</button>
            {signature?.has && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRedraw(false)}>{t('Cancel')}</button>}
          </div>
        </div>
      )}
      {dialog}
    </Card>
  );
}

export default function AgreementTemplates() {
  const [d, setD] = useState(null);
  const [lang, setLang] = useState('he');
  const [players, setPlayers] = useState([]);
  const load = () => loadAgreementSettings().then(setD).catch((e) => { toast.error(e.message); setD({ he: null, en: null, signature: { has: false } }); });
  useEffect(() => { load(); }, []);
  useEffect(() => listenPlayers({ notStage: 'archived' }, (rows) => setPlayers(rows.filter((p) => !p.deletedAt).sort((a, b) => playerName(a).localeCompare(playerName(b))))), []);
  if (!d) return <Skeleton rows={4} />;
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 820 }}>
      <Card>
        <Title>{t('Representation agreements')}</Title>
        <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
          {t('An admin makes an agreement on the player\'s page or asks Golda ("הסכם ייצוג ל…"). The player, or for a minor the parent or guardian, signs on the phone through a private link; the signed PDF goes into the player\'s documents and the representation dates are updated.')}
        </div>
        <div className="chip-group" role="tablist" style={{ display: 'flex', marginTop: 12 }}>
          {['he', 'en'].map((l) => (
            <button key={l} type="button" role="tab" aria-selected={lang === l} className={`chip${lang === l ? ' active' : ''}`} onClick={() => setLang(l)}>
              {l === 'he' ? t('Hebrew') : t('English')}{d[l] ? ` · v${d[l].version}` : ` · ${t('no template')}`}
            </button>
          ))}
        </div>
      </Card>
      <Template lang={lang} saved={d[lang]} players={players} onSaved={(l, tpl) => setD((x) => ({ ...x, [l]: tpl }))} />
      <AgencySignature signature={d.signature} onChange={load} />
    </div>
  );
}
