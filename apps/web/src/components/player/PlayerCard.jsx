import React from 'react';

// The card of the player page: a section label, an optional action at the
// end of the header row, then the body. Every card on that page is this one,
// so they all share one padding, one header and one label style.
//
// `note` is a short sentence that sits on the header row itself, for a card
// that has nothing else to say (a complete file: "the file is complete").
export function PlayerCard({ title, action, note, children, style }) {
  return (
    <section className="card card-body" style={{ padding: '14px 16px', ...style }}>
      <div style={{ display: 'flex', alignItems: note ? 'baseline' : 'center', gap: 10, flexWrap: 'wrap', marginBottom: children ? 10 : 0 }}>
        <div className="section-label" style={{ marginBottom: 0, flex: note ? '0 0 auto' : 1 }}>{title}</div>
        {note && <span style={{ flex: 1, minWidth: 0, color: 'var(--text-3)', fontSize: 12.5 }}>{note}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

// A number with its label above it and a coloured top edge: the days left on
// a contract, a season's minutes. `tone` colours the edge (and the number,
// when `toned`); `sub` is the small line under the number.
export function StatTile({ label, value, sub, tone = 'var(--gold)', toned = false, compact = false }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderTop: `2px solid ${tone}`, padding: compact ? '8px 10px' : '10px 12px', background: 'var(--card)', minWidth: 0 }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={typeof label === 'string' ? label : undefined}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: compact ? 18 : 22, color: toned ? tone : 'var(--text-1)', lineHeight: 1.1, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub}</div>}
    </div>
  );
}
