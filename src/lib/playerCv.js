// One-page player CV, A4 portrait — the print-ready counterpart to the
// WhatsApp card. Same facts, laid out as a document a club can open, skim in
// ten seconds and file.
//
// Everything on the page is vector: the rules, the icons beside each row and
// the link buttons are drawn with jsPDF primitives rather than pasted as
// images, so the sheet stays sharp at any zoom and the file stays small.
//
// Type is deliberately limited to the PDF base-14 faces. Times carries the
// display and the values, Helvetica the letterspaced labels. Both are baked
// into every reader, so the document looks identical in Acrobat, Preview,
// Chrome and on a phone with nothing embedded and nothing to download.
//
// Links are buttons with the whole shape as the hotspot — no raw URLs.

import { calcAge } from './constants';

const DARK      = [10, 20, 13];      // agency green-black
const GOLD      = [0xC9, 0xA8, 0x4C];
const GOLD_DARK = [0x8E, 0x6A, 0x24];
const INK       = [0x14, 0x17, 0x1A];
const MUTED     = [0x8A, 0x8A, 0x8A];
const RULE      = [0xE2, 0xDD, 0xCE];
const TM_NAVY   = [0x1A, 0x30, 0x49];   // Transfermarkt's house navy
const PLAY_RED  = [0xC0, 0x2A, 0x2A];

const FOOT_WORD = { R: 'Right', L: 'Left', B: 'Both', Right: 'Right', Left: 'Left', Both: 'Both' };
const CAT_WORD  = { men: 'Men', women: 'Women', youth: 'Youth', jewish: 'Jewish' };

// jsPDF's base-14 fonts are Latin-1 only; anything outside it prints as
// garbage, so emoji and non-Latin characters are dropped rather than shown.
const latin1 = (s) => String(s ?? '').replace(/[^\x20-\xFF]/g, '').replace(/\s+/g, ' ').trim();

async function loadLogo() {
  try {
    const res = await fetch('/logo.png');
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch { return null; }
}

function videoUrl(raw) {
  const v = (raw || '').trim();
  if (!v) return '';
  const id = v.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{6,})/);
  if (id) return `https://youtube.com/watch?v=${id[1]}`;
  return /^https?:\/\//.test(v) ? v : `https://${v}`;
}
const absUrl = (raw) => {
  const v = (raw || '').trim();
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
};

function nationalTeam(player) {
  const country = player.natTeamCountry || (player.nationalities || [])[0] || '';
  const st = player.natTeamStatus;
  if (!country || !st || st === 'None') return '';
  return `${st.startsWith('Former') ? 'Former ' : ''}${country}${st.endsWith('Youth') ? ' Youth' : ''}`;
}

// ── Vector glyphs ───────────────────────────────────────────────
// Each draws inside a 13pt box whose top-left is (x, y), stroked in the
// current draw colour. Kept deliberately geometric to match the app's icon set.
const ICONS = {
  globe(d, x, y, s) {
    const r = s / 2, cx = x + r, cy = y + r;
    d.circle(cx, cy, r, 'S');
    d.ellipse(cx, cy, r * 0.42, r, 'S');
    d.line(x, cy, x + s, cy);
  },
  calendar(d, x, y, s) {
    d.roundedRect(x, y + s * 0.14, s, s * 0.86, 1, 1, 'S');
    d.line(x, y + s * 0.40, x + s, y + s * 0.40);
    d.line(x + s * 0.28, y, x + s * 0.28, y + s * 0.22);
    d.line(x + s * 0.72, y, x + s * 0.72, y + s * 0.22);
  },
  shield(d, x, y, s) {
    d.lines([[s, 0], [0, s * 0.46], [-s / 2, s * 0.54], [-s / 2, -s * 0.54], [0, -s * 0.46]],
      x, y, [1, 1], 'S', true);
  },
  flag(d, x, y, s) {
    d.line(x + s * 0.16, y, x + s * 0.16, y + s);
    d.lines([[s * 0.68, s * 0.18], [-s * 0.68, s * 0.18]], x + s * 0.16, y + s * 0.06, [1, 1], 'S', true);
  },
  pin(d, x, y, s) {
    d.circle(x + s / 2, y + s * 0.38, s * 0.30, 'S');
    d.lines([[s * 0.28, s * 0.36], [-s * 0.28, 0]], x + s * 0.22, y + s * 0.62, [1, 1], 'S', true);
  },
  play(d, x, y, s) {
    d.triangle(x + s * 0.28, y + s * 0.16, x + s * 0.28, y + s * 0.84, x + s * 0.84, y + s * 0.5, 'F');
  },
};

export async function exportPlayerCv(player, category = 'men') {
  const { default: jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const age = calcAge(player.dob);

  // Small caps label, letterspaced — the recurring typographic motif.
  const label = (text, x, y, colour = GOLD_DARK, size = 7.6) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(...colour);
    doc.text(String(text).toUpperCase(), x, y, { charSpace: 1.15 });
  };

  // ── Masthead ───────────────────────────────────────────────────
  const BAND = 150;
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W, BAND, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, BAND, W, 3, 'F');

  let textX = M;
  const logo = await loadLogo();
  if (logo) {
    try {
      const p = doc.getImageProperties(logo);
      const h = 66;
      const w = Math.min((p.width / p.height) * h, 132);
      doc.addImage(logo, 'PNG', M, (BAND - h) / 2 - 6, w, h);
      textX = M + w + 26;
    } catch { /* the logo is decoration; never block the export */ }
  }

  label('Gold A&S  ·  Football Agency', textX, 52, GOLD, 8);

  doc.setFont('times', 'bold');
  doc.setFontSize(30);
  doc.setTextColor(255, 255, 255);
  doc.text(latin1(player.playerName) || 'Player', textX, 88);

  const strap = [CAT_WORD[category], nationalTeam(player) || (player.nationalities || [])[0]]
    .filter(Boolean).join('  ·  ');
  doc.setFont('times', 'italic');
  doc.setFontSize(12);
  doc.setTextColor(...GOLD);
  doc.text(latin1(strap), textX, 108);

  // ── Headline figures ───────────────────────────────────────────
  // The four things a sporting director checks first, given the space they
  // deserve instead of being buried in the table.
  // Only the figures we actually hold get a column — an empty cell with a
  // dash reads as a gap in the record, four confident numbers read as a
  // profile. The strip disappears entirely for a very sparse entry.
  const stats = [
    ['Age',      age ? String(age) : ''],
    ['Height',   player.height ? `${(Number(player.height) / 100).toFixed(2)}m` : ''],
    ['Foot',     FOOT_WORD[player.foot] || ''],
    ['Position', player.primaryPosition || ''],
  ].filter(([, v]) => v);

  const STRIP_Y = BAND + 34;
  const STRIP_H = stats.length ? 62 : 0;
  const colW = (W - M * 2) / Math.max(stats.length, 1);
  stats.forEach(([k, v], i) => {
    const cx = M + colW * i + colW / 2;
    if (i) {
      doc.setDrawColor(...RULE);
      doc.setLineWidth(0.7);
      doc.line(M + colW * i, STRIP_Y + 4, M + colW * i, STRIP_Y + STRIP_H - 6);
    }
    doc.setFont('times', 'bold');
    doc.setFontSize(23);
    doc.setTextColor(...INK);
    doc.text(latin1(v), cx, STRIP_Y + 30, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.6);
    doc.setTextColor(...GOLD_DARK);
    doc.text(k.toUpperCase(), cx, STRIP_Y + 47, { align: 'center', charSpace: 1.15 });
  });

  // ── Detail rows ────────────────────────────────────────────────
  const league = player.leagueMode === 'manual'
    ? (player.leagueManual || '')
    : [player.leagueCountry, (player.leagueTier || '').replace('Tier ', '')].filter(Boolean).join(' ');

  // Age, height, foot and the primary position already sit in the headline
  // strip, so the table carries what the strip cannot: the full nationality
  // list, the club with its league, and the secondary positions.
  const secondary = (player.secondaryPositions || []).filter(Boolean);
  const rows = [
    ['globe',    'Nationality',    (player.nationalities || []).filter(Boolean).join('   ·   ')],
    ['calendar', 'Date of birth',  player.dob
      ? new Date(player.dob).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : ''],
    ['shield',   'Current club',   player.currentClub ? `${player.currentClub}${league ? `   (${league})` : ''}` : 'Free Agent'],
    ['flag',     'National team',  nationalTeam(player)],
    ['pin',      'Also plays',     secondary.join('   /   ')],
  ].filter(([, , v]) => v);

  let y = STRIP_Y + STRIP_H + 44;
  label('Profile', M, y - 16);
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(1.2);
  doc.line(M, y - 10, W - M, y - 10);
  y += 12;

  const ICON_S = 12.5, LABEL_X = M + 30, VALUE_X = M + 168;
  for (const [icon, name, value] of rows) {
    doc.setDrawColor(...GOLD_DARK);
    doc.setFillColor(...GOLD_DARK);
    doc.setLineWidth(0.9);
    ICONS[icon](doc, M, y - ICON_S + 2.5, ICON_S);

    label(name, LABEL_X, y, MUTED, 7.4);

    doc.setFont('times', 'normal');
    doc.setFontSize(14);
    doc.setTextColor(...INK);
    const fitted = doc.splitTextToSize(latin1(value), W - M - VALUE_X)[0] || '';
    doc.text(fitted, VALUE_X, y);

    y += 12;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.6);
    doc.line(M, y, W - M, y);
    y += 26;
  }

  // ── Notes ──────────────────────────────────────────────────────
  const notes = latin1(player.notes);
  if (notes) {
    y += 8;
    label('Scouting notes', M, y);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(1.2);
    doc.line(M, y + 6, W - M, y + 6);
    y += 26;
    doc.setFont('times', 'normal');
    doc.setFontSize(12);
    doc.setTextColor(...INK);
    const lines = doc.splitTextToSize(notes, W - M * 2).slice(0, 7);
    doc.text(lines, M, y, { lineHeightFactor: 1.45 });
    y += lines.length * 17 + 10;
  }

  // ── Link buttons ───────────────────────────────────────────────
  const buttons = [
    { text: 'Watch highlights', url: videoUrl(player.videoLink),   kind: 'video' },
    { text: 'Transfermarkt profile', url: absUrl(player.profileLink), kind: 'tm' },
  ].filter(b => b.url);

  if (buttons.length) {
    const BH = 40, GAP = 16;
    const BW = Math.min(238, (W - M * 2 - GAP * (buttons.length - 1)) / buttons.length);
    // Sit low on the page, but never let long notes push the buttons down
    // into the footer band.
    const by = Math.min(Math.max(y + 16, H - 176), H - 116);
    buttons.forEach((b, i) => {
      const bx = M + i * (BW + GAP);
      const bg = b.kind === 'video' ? PLAY_RED : TM_NAVY;

      doc.setFillColor(...bg);
      doc.roundedRect(bx, by, BW, BH, 3, 3, 'F');

      // Glyph tile on the left of the button.
      const gx = bx + 14, gy = by + (BH - 16) / 2;
      doc.setDrawColor(255, 255, 255);
      doc.setFillColor(255, 255, 255);
      doc.setLineWidth(1.1);
      if (b.kind === 'video') {
        doc.roundedRect(gx, gy + 2, 20, 13, 2.5, 2.5, 'S');
        ICONS.play(doc, gx + 4.5, gy + 3.5, 10);
      } else {
        // A monogram tile rather than a reproduction of their mark.
        doc.roundedRect(gx, gy, 18, 16, 2, 2, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...TM_NAVY);
        doc.text('TM', gx + 9, gy + 11.4, { align: 'center' });
      }

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(255, 255, 255);
      doc.text(b.text.toUpperCase(), gx + 32, by + BH / 2 + 3.4, { charSpace: 0.9 });

      doc.link(bx, by, BW, BH, { url: b.url });
    });
  }

  // ── Footer ─────────────────────────────────────────────────────
  doc.setFillColor(...DARK);
  doc.rect(0, H - 54, W, 54, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, H - 56, W, 2, 'F');
  label('gold-as.com  ·  Lou Korek  ·  FIFA Licensed Agent', M, H - 30, GOLD, 8);
  doc.setFont('times', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(new Date().toLocaleDateString('en-GB'), W - M, H - 30, { align: 'right' });

  const safe = (player.playerName || 'player').replace(/[^\w\s-]/g, '').trim() || 'player';
  doc.save(`${safe} - Gold A&S.pdf`);
}
