// A live page of the design system: the tokens index.css defines and the
// shared components, rendered by the real CSS so this never drifts from the
// app. Admin only, reached from the System screen.
import React from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, ChipGroup, Field, SearchInput, Empty, Skeleton, Spinner, StatusBadge, RowActions, EUBadge } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { getLang } from 'lib/i18n';
import { useRole } from 'lib/roleContext';

const COLORS = ['--gold', '--gold-lt', '--gold-dk', '--gold-soft', '--bg', '--surface-1', '--surface-2', '--surface-3', '--card', '--text-1', '--text-2', '--text-3', '--text-mute', '--border', '--border-2', '--border-3', '--red', '--amber', '--green-ok', '--blue', '--purple'];
const FONTS = [['--font-display', 'כותרות · Headings'], ['--font-body', 'טקסט · Body'], ['--font-mono', 'מספרים ומזהים · Mono']];
const SIZES = ['--fs-1', '--fs-2', '--fs-3', '--fs-4', '--fs-5', '--fs-6', '--fs-7'];
const ICONS = ['dashboard', 'players', 'clipboard', 'contacts', 'matches', 'search', 'chat', 'team', 'tasks', 'bell', 'social', 'trash', 'refresh', 'plus', 'star', 'men', 'women', 'youth', 'menu', 'chevron'];

const Section = ({ title, children }) => (
  <section style={{ marginTop: 24 }}>
    <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-4)', margin: '0 0 12px', paddingBottom: 6, borderBottom: '1px solid var(--border-2)' }}>{title}</h2>
    {children}
  </section>
);

export default function DesignSystem() {
  const { isAdmin } = useRole();
  const he = getLang() === 'he';
  const [chip, setChip] = React.useState('a');
  const [q, setQ] = React.useState('');
  if (!isAdmin) return null;
  const read = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
  return (
    <div>
      <PageHeader title={he ? 'מערכת העיצוב' : 'Design system'} subtitle={he ? 'הטוקנים והרכיבים שכל מסך משתמש בהם, מתוך ה-CSS האמיתי. שינוי ב-index.css משתנה גם כאן.' : 'The tokens and components every screen uses, rendered by the real CSS.'}
        action={<Link to="/admin" className="btn btn-ghost btn-sm" style={{ height: 36, textDecoration: 'none' }}>{he ? 'חזרה למערכת' : 'Back to System'}</Link>} />

      <Section title={he ? 'צבעים' : 'Colors'}>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {COLORS.map((v) => (
            <div key={v} className="card" style={{ padding: 10 }}>
              <div style={{ height: 36, background: `var(${v})`, border: '1px solid var(--border-2)' }} />
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 6 }}>{v}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>{read(v)}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={he ? 'טיפוגרפיה' : 'Typography'}>
        {FONTS.map(([v, label]) => (
          <div key={v} className="card" style={{ padding: 12, marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{v} · {label}</div>
            <div style={{ fontFamily: `var(${v})`, fontSize: 20, marginTop: 4 }}>{he ? 'גולד א.ס. סוכנות כדורגל · Gold A&S 0123456789' : 'Gold A&S Football Agency 0123456789'}</div>
          </div>
        ))}
        <div className="card" style={{ padding: 12, display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
          {SIZES.map((v) => <span key={v} style={{ fontSize: `var(${v})` }} title={v}>{v.replace('--fs-', 'fs')} {read(v)}</span>)}
        </div>
      </Section>

      <Section title={he ? 'כפתורים' : 'Buttons'}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-primary"><Icon name="plus" size={12} /><span className="btn-text">btn-primary</span></button>
          <button className="btn btn-secondary">btn-secondary</button>
          <button className="btn btn-ghost">btn-ghost</button>
          <button className="btn btn-primary btn-sm">btn-sm</button>
          <button className="btn btn-secondary" disabled>disabled</button>
          <RowActions onEdit={() => {}} onDuplicate={() => {}} onView={() => {}} onDelete={() => {}} profileUrl="https://example.com" />
        </div>
      </Section>

      <Section title={he ? 'שדות וסינון' : 'Fields and filters'}>
        <div className="card" style={{ padding: 16, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <Field label={he ? 'שדה טקסט' : 'Text field'} hint={he ? 'הסבר קצר מתחת לשדה' : 'A short hint under the field'}><input placeholder={he ? 'הקלד…' : 'Type…'} /></Field>
          <Field label={he ? 'שדה חובה' : 'Required field'} required error={he ? 'הודעת שגיאה' : 'An error message'}><input defaultValue="" /></Field>
          <Field label="ChipGroup"><ChipGroup options={['a', 'b', 'c']} labels={[he ? 'ראשון' : 'First', he ? 'שני' : 'Second', he ? 'שלישי' : 'Third']} value={chip} onChange={setChip} required /></Field>
          <Field label="SearchInput"><SearchInput value={q} onChange={setQ} placeholder={he ? 'חיפוש' : 'Search'} /></Field>
        </div>
      </Section>

      <Section title={he ? 'תגים ומצבים' : 'Badges and states'}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <StatusBadge status="Active" /><StatusBadge status="Not Contacted" /><EUBadge is /><EUBadge is={false} />
          <span className="chip active">chip active</span><span className="chip">chip</span>
          <Spinner size={20} />
        </div>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          <div className="card" style={{ padding: 0 }}><Skeleton rows={3} /></div>
          <div className="card"><Empty message={he ? 'מצב ריק עם הודעה' : 'An empty state with a message'} action={<button className="btn btn-primary btn-sm">{he ? 'פעולה' : 'Action'}</button>} /></div>
        </div>
      </Section>

      <Section title={he ? 'טבלה' : 'Table'}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}><div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>{he ? 'שם' : 'Name'}</th><th>{he ? 'מועדון' : 'Club'}</th><th>{he ? 'סטטוס' : 'Status'}</th><th style={{ textAlign: 'end' }}>{he ? 'ערך' : 'Value'}</th></tr></thead>
            <tbody>
              {[['נועם ברזילי', 'Hapoel Tel Aviv', 'Active', '€1.2m'], ['דוגמה שנייה', 'Maccabi Haifa', 'Trial', '€400k']].map((r) => (
                <tr key={r[0]}><td style={{ fontWeight: 600 }}>{r[0]}</td><td>{r[1]}</td><td><StatusBadge status={r[2]} /></td><td style={{ textAlign: 'end', fontFamily: 'var(--font-mono)' }}>{r[3]}</td></tr>
              ))}
            </tbody>
          </table>
        </div></div>
      </Section>

      <Section title={he ? 'אייקונים' : 'Icons'}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {ICONS.map((n) => <div key={n} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: 64, color: 'var(--text-2)' }}><Icon name={n} size={18} /><span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{n}</span></div>)}
        </div>
      </Section>

      <Section title={he ? 'כללים' : 'Rules'}>
        <ul style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7, paddingInlineStart: 20 }}>
          <li>{he ? 'רדיוס 0 עד 2 פיקסלים, קווי מסגרת דקים, ללא צללים זהובים. הזהב מסמן מיקוד ופעולה ראשית בלבד.' : 'Radius 0 to 2px, hairline borders, no gold glows. Gold marks focus and the primary action only.'}</li>
          <li>{he ? 'עברית היא שפת המקור; מחרוזות עוברות דרך t() והמילון ב-i18n/he.js. פריסה ב-RTL עם מאפייני inline-start/end.' : 'Hebrew first; strings go through t() and i18n/he.js. RTL layout via inline-start/end properties.'}</li>
          <li>{he ? 'כל מסך פותח ב-PageHeader, טבלאות ב-card + table-wrap + data-table, טעינה ב-Skeleton, ריק ב-Empty.' : 'Every screen opens with PageHeader; tables are card + table-wrap + data-table; loading is Skeleton; empty is Empty.'}</li>
          <li>{he ? 'יעדי מגע 44 פיקסלים בטלפון (--tap). מספרים ומזהים בפונט mono.' : '44px touch targets on the phone (--tap). Numbers and ids in the mono font.'}</li>
        </ul>
      </Section>
    </div>
  );
}
