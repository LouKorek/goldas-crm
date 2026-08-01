// One-page player CV, A4 portrait — the print-ready counterpart to the
// WhatsApp card. Same facts, laid out as a document a club can open, skim in
// ten seconds and file.
//
// Typography follows the export house style: Times for display, Helvetica for
// labels. Both are PDF base-14 fonts, so the file renders identically in
// Acrobat, Preview, Chrome and on phones without embedding anything.
//
// Links are drawn as filled buttons with a clickable annotation on top —
// no raw URLs on the page.

import { calcAge } from './constants';

const DARK      = [10, 20, 13];
const GOLD      = [0xC9, 0xA8, 0x4C];
const GOLD_DARK = [0x8E, 0x6A, 0x24];
const INK       = [0x1A, 0x1A, 0x1A];
const MUTED     = [0x77, 0x77, 0x77];
const RULE      = [0xDD, 0xD8, 0xC8];

const FOOT_WORD = { R: 'Right', L: 'Left', B: 'Both', Right: 'Right', Left: 'Left', Both: 'Both' };

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

export async function exportPlayerCv(player, category = 'men') {
  const { default: jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 46;                       // page margin

  // ── Header band ────────────────────────────────────────────────
  const BAND = 132;
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W, BAND, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, BAND, W, 2.5, 'F');

  let textX = M;
  const logo = await loadLogo();
  if (logo) {
    try {
      const props = doc.getImageProperties(logo);
      const h = 58;
      const w = Math.min((props.width / props.height) * h, 130);
      doc.addImage(logo, 'PNG', M, (BAND - h) / 2, w, h);
      textX = M + w + 22;
    } catch { /* logo is decoration; never block the export */ }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...GOLD);
  doc.text('GOLD A&S  ·  FOOTBALL AGENCY', textX, 44);

  doc.setFont('times', 'bold');
  doc.setFontSize(27);
  doc.setTextColor(255, 255, 255);
  doc.text(latin1(player.playerName) || 'Player', textX, 78);

  const age = calcAge(player.dob);
  const CAT_WORD = { men: 'Men', women: 'Women', youth: 'Youth', jewish: 'Jewish' };
  const strap = [CAT_WORD[category] || '', player.primaryPosition, age ? `${age} years` : '']
    .filter(Boolean).join('  ·  ');
  doc.setFont('times', 'italic');
  doc.setFontSize(11.5);
  doc.setTextColor(...GOLD_DARK);
  doc.text(latin1(strap), textX, 98);

  // ── Fact sheet ─────────────────────────────────────────────────
  const league = player.leagueMode === 'manual'
    ? (player.leagueManual || '')
    : [player.leagueCountry, (player.leagueTier || '').replace('Tier ', '')].filter(Boolean).join(' ');

  const rows = [
    ['Nationality',    (player.nationalities || []).filter(Boolean).join('  ·  ')],
    ['Date of birth',  player.dob
      ? `${new Date(player.dob).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${age ? `   (${age})` : ''}`
      : ''],
    ['Current club',   player.currentClub ? `${player.currentClub}${league ? `   (${league})` : ''}` : 'Free Agent'],
    ['National team',  nationalTeam(player)],
    ['Position',       [player.primaryPosition, ...(player.secondaryPositions || [])].filter(Boolean).join('   /   ')],
    ['Height',         player.height ? `${(Number(player.height) / 100).toFixed(2)} m` : ''],
    ['Preferred foot', FOOT_WORD[player.foot] || player.foot || ''],
  ].filter(([, v]) => v);

  let y = BAND + 52;
  const LABEL_W = 132;
  doc.setLineWidth(0.6);
  for (const [label, value] of rows) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...GOLD_DARK);
    doc.text(label.toUpperCase(), M, y);

    doc.setFont('times', 'normal');
    doc.setFontSize(13.5);
    doc.setTextColor(...INK);
    doc.text(latin1(value), M + LABEL_W, y);

    y += 13;
    doc.setDrawColor(...RULE);
    doc.line(M, y, W - M, y);
    y += 25;
  }

  // ── Notes, when there are any worth printing ───────────────────
  const notes = latin1(player.notes);
  if (notes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...GOLD_DARK);
    doc.text('NOTES', M, y);
    y += 15;
    doc.setFont('times', 'normal');
    doc.setFontSize(11.5);
    doc.setTextColor(...INK);
    const lines = doc.splitTextToSize(notes, W - M * 2).slice(0, 6);
    doc.text(lines, M, y);
    y += lines.length * 15 + 12;
  }

  // ── Link buttons ───────────────────────────────────────────────
  const buttons = [
    ['WATCH VIDEO', videoUrl(player.videoLink)],
    ['TRANSFERMARKT PROFILE', absUrl(player.profileLink)],
  ].filter(([, url]) => url);

  if (buttons.length) {
    const BH = 34, GAP = 14;
    const BW = Math.min(220, (W - M * 2 - GAP * (buttons.length - 1)) / buttons.length);
    const by = Math.max(y + 12, H - 168);
    buttons.forEach(([label, url], i) => {
      const bx = M + i * (BW + GAP);
      doc.setFillColor(...DARK);
      doc.roundedRect(bx, by, BW, BH, 2, 2, 'F');
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1);
      doc.roundedRect(bx, by, BW, BH, 2, 2, 'S');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...GOLD);
      doc.text(label, bx + BW / 2, by + BH / 2 + 3.2, { align: 'center' });
      doc.link(bx, by, BW, BH, { url });   // the whole button is the hotspot
    });
  }

  // ── Footer ─────────────────────────────────────────────────────
  doc.setDrawColor(...GOLD_DARK);
  doc.setLineWidth(0.8);
  doc.line(M, H - 62, W - M, H - 62);
  doc.setFont('times', 'italic');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text('gold-as.com  ·  Lou Korek, FIFA Licensed Agent', M, H - 44);
  doc.text(new Date().toLocaleDateString('en-GB'), W - M, H - 44, { align: 'right' });

  const safe = (player.playerName || 'player').replace(/[^\w\s-]/g, '').trim() || 'player';
  doc.save(`${safe} - Gold A&S.pdf`);
}
