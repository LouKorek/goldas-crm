// One-page player CV, A4 portrait — the print-ready counterpart to the
// WhatsApp card. Same facts, laid out as a document a club can open, skim in
// ten seconds and file.
//
// Everything on the page is vector: the rules, the icons beside each row and
// the link buttons are drawn with jsPDF primitives rather than pasted as
// images, so the sheet stays sharp at any zoom and the file stays small.
//
// Poppins is embedded (subset to Latin-1) rather than falling back on the
// PDF base-14 faces, which look like a 1990s form. If registration ever
// fails the document still builds, on Helvetica.
//
// Links are buttons with the whole shape as the hotspot — no raw URLs.

import { calcAge } from './constants';

const DARK      = [0x12, 0x2E, 0x21];   // masthead green — the logo's own family,
                                        // lightened so the logo tile doesn't read
                                        // as a dark patch on near-black
const CREST     = [0x06, 0x1E, 0x14];   // matches the logo artwork's background
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
  // A pitch seen from above — halfway line and centre circle. Reads as
  // "where he plays" far more directly than a map pin.
  pitch(d, x, y, s) {
    d.rect(x, y + s * 0.13, s, s * 0.74, 'S');
    d.line(x + s / 2, y + s * 0.13, x + s / 2, y + s * 0.87);
    d.circle(x + s / 2, y + s * 0.5, s * 0.17, 'S');
  },
  ruler(d, x, y, s) {
    d.rect(x, y + s * 0.28, s, s * 0.44, 'S');
    [0.28, 0.5, 0.72].forEach(f => d.line(x + s * f, y + s * 0.28, x + s * f, y + s * 0.48));
  },
  // A ball, for the foot that strikes it. The old boot outline was
  // unreadable at 12pt.
  ball(d, x, y, s) {
    const r = s / 2, cx = x + r, cy = y + r;
    d.circle(cx, cy, r, 'S');
    const pr = r * 0.42;
    const pts = [0, 1, 2, 3, 4].map(i => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      return [cx + pr * Math.cos(a), cy + pr * Math.sin(a)];
    });
    // jsPDF wants relative segments from the first point.
    const rel = pts.slice(1).concat([pts[0]]).map((p, i) => {
      const prev = pts[i];
      return [p[0] - prev[0], p[1] - prev[1]];
    });
    d.lines(rel, pts[0][0], pts[0][1], [1, 1], 'F', true);
  },
  play(d, x, y, s) {
    d.triangle(x + s * 0.28, y + s * 0.16, x + s * 0.28, y + s * 0.84, x + s * 0.84, y + s * 0.5, 'F');
  },
};

// Register the embedded family once per document. Falls back silently to
// Helvetica so a font problem can never cost Lou the export.
function useFonts(doc, fonts) {
  try {
    doc.addFileToVFS('Poppins-Regular.ttf', fonts.POPPINS_REGULAR);
    doc.addFileToVFS('Poppins-Medium.ttf',  fonts.POPPINS_MEDIUM);
    doc.addFileToVFS('Poppins-Bold.ttf',    fonts.POPPINS_BOLD);
    doc.addFont('Poppins-Regular.ttf', 'Poppins', 'normal');
    doc.addFont('Poppins-Medium.ttf',  'Poppins', 'medium');
    doc.addFont('Poppins-Bold.ttf',    'Poppins', 'bold');
    return 'Poppins';
  } catch { return 'helvetica'; }
}

export async function exportPlayerCv(player, category = 'men') {
  const [{ default: jsPDF }, fonts] = await Promise.all([
    import('jspdf'),
    import('./pdfFonts'),
  ]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const FAM = useFonts(doc, fonts);
  const MED = FAM === 'Poppins' ? 'medium' : 'bold';   // Helvetica has no medium
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const age = calcAge(player.dob);

  // Small caps label, letterspaced — the recurring typographic motif.
  const label = (text, x, y, colour = GOLD_DARK, size = 7.6) => {
    doc.setFont(FAM, MED);
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
      // The artwork ships with its own opaque dark background, so it is set
      // in a crest tile of that exact colour with a gold hairline. Left bare
      // on the band it reads as an accidental dark patch.
      const p = doc.getImageProperties(logo);
      const h = 64;
      const w = Math.min((p.width / p.height) * h, 128);
      const lx = M, ly = (BAND - h) / 2 - 4;
      doc.setFillColor(...CREST);
      doc.roundedRect(lx - 5, ly - 5, w + 10, h + 10, 3, 3, 'F');
      doc.setDrawColor(...GOLD_DARK);
      doc.setLineWidth(0.8);
      doc.roundedRect(lx - 5, ly - 5, w + 10, h + 10, 3, 3, 'S');
      doc.addImage(logo, 'PNG', lx, ly, w, h);
      textX = lx + w + 30;
    } catch { /* the logo is decoration; never block the export */ }
  }

  label('Gold A&S  ·  Football Agency', textX, 52, GOLD, 8);

  doc.setFont(FAM, 'bold');
  doc.setFontSize(28);
  doc.setTextColor(255, 255, 255);
  doc.text(latin1(player.playerName) || 'Player', textX, 88);

  const strap = [CAT_WORD[category], nationalTeam(player) || (player.nationalities || [])[0]]
    .filter(Boolean).join('  ·  ');
  doc.setFont(FAM, 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...GOLD);
  doc.text(latin1(strap), textX, 110, { charSpace: 0.5 });

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
    doc.setFont(FAM, 'bold');
    doc.setFontSize(21);
    doc.setTextColor(...INK);
    doc.text(latin1(v), cx, STRIP_Y + 30, { align: 'center' });
    doc.setFont(FAM, MED);
    doc.setFontSize(7.4);
    doc.setTextColor(...GOLD_DARK);
    doc.text(k.toUpperCase(), cx, STRIP_Y + 47, { align: 'center', charSpace: 1.15 });
  });

  // ── Detail rows ────────────────────────────────────────────────
  const league = player.leagueMode === 'manual'
    ? (player.leagueManual || '')
    : [player.leagueCountry, (player.leagueTier || '').replace('Tier ', '')].filter(Boolean).join(' ');

  // The strip is the headline; this is the record. Everything appears here in
  // full — the strip abbreviates, the table states.
  const secondary = (player.secondaryPositions || []).filter(Boolean);
  const rows = [
    ['globe',    'Nationality',    (player.nationalities || []).filter(Boolean).join('   ·   ')],
    ['calendar', 'Date of birth',  player.dob
      ? `${new Date(player.dob).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}${age ? `  (${age})` : ''}`
      : ''],
    ['shield',   'Current club',   player.currentClub ? `${player.currentClub}${league ? `   (${league})` : ''}` : 'Free Agent'],
    ['flag',     'National team',  nationalTeam(player)],
    ['pitch',    'Main position',  player.primaryPosition || ''],
    ['pitch',    'Other positions', secondary.join('   /   ')],
    ['ruler',    'Height',         player.height ? `${(Number(player.height) / 100).toFixed(2)} m` : ''],
    ['ball',     'Preferred foot', FOOT_WORD[player.foot] || player.foot || ''],
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

    doc.setFont(FAM, 'normal');
    doc.setFontSize(12);
    doc.setTextColor(...INK);
    const fitted = doc.splitTextToSize(latin1(value), W - M - VALUE_X)[0] || '';
    doc.text(fitted, VALUE_X, y);

    y += 11;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.6);
    doc.line(M, y, W - M, y);
    y += 21;
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
    doc.setFont(FAM, 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(...INK);
    // Take only as many lines as fit above the buttons; a CV that spills onto
    // a second page stops being a one-pager.
    const roomFor = Math.max(1, Math.floor(((H - 190) - y) / 15));
    const lines = doc.splitTextToSize(notes, W - M * 2).slice(0, roomFor);
    doc.text(lines, M, y, { lineHeightFactor: 1.45 });
    y += lines.length * 15 + 10;
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
        doc.setFont(FAM, 'bold');
        doc.setFontSize(8);
        doc.setTextColor(...TM_NAVY);
        doc.text('TM', gx + 9, gy + 11.4, { align: 'center' });
      }

      doc.setFont(FAM, MED);
      doc.setFontSize(8.8);
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
  // No export date: the sheet is sent and forwarded for months, and a stamped
  // date only makes a current profile look stale.
  label('gold-as.com  ·  Lou Korek  ·  FIFA Licensed Agent', M, H - 30, GOLD, 8);

  const safe = (player.playerName || 'player').replace(/[^\w\s-]/g, '').trim() || 'player';
  doc.save(`${safe} - Gold A&S.pdf`);
}
