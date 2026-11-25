// A stand-in for the agency's website in the tests of Golda's own-initiative
// messages: a small page shaped like the live one, and a client that serves it
// and only records a publish.
const { applyChanges } = require('../website-html.js');

const FLAG = (code, name) => `<img src="https://flagcdn.com/h40/${code}.png" alt="${name}" title="${name}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;display:inline-block;" loading="lazy" decoding="async">`;
const CARD = (name, club, pos, born, foot, flags) => `<div class="player-card">
        <div class="player-img-wrap">
          <img alt="${name}" class="player-photo" src="/player-x.jpg" loading="lazy" decoding="async">
          <span class="player-pos-badge">${pos}</span>
          <div class="player-nat-overlay">${flags}</div>
          <div class="player-view-hint">View Profile</div>
        </div>
        <div class="player-info">
          <div class="player-name">${name}</div>
          <div class="player-club">${club}</div>
          <div class="player-meta">
            <div class="player-meta-item"><strong>Born</strong> ${born}</div>
            <div class="player-meta-item"><strong>Foot</strong> ${foot}</div>
          </div>
        </div>
      </div>`;
const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Gold A&amp;S</title></head>
<body>
<section id="players"><p class="section-label">Our Talents</p>
    <div class="players-grid" id="playersGrid">
      ${CARD('Eyal Prashizky', "Ironi Modi'in (U17)", 'GK', '2010', 'Right', FLAG('il', 'Israel'))}
      ${CARD('Gavin Karam', 'Hapoel Kfar Saba', 'DM / CM', '2007', 'Right', FLAG('il', 'Israel') + FLAG('us', 'United States'))}
      ${CARD('Yair Shemesh', 'Ironi Karmiel', 'DM / CM', '2006', 'Right', FLAG('il', 'Israel'))}
    </div>
</section>
</body></html>
`;

/** The website, as a stand-in: the public page, and a publish that only records. */
function fakeSite({ down = false } = {}) {
  const site = {
    reads: 0, published: [], down,
    async publicPage() { site.reads++; if (site.down) throw new Error('the site did not answer'); return PAGE; },
    async publish({ changes }) { site.published.push(changes); const r = applyChanges(PAGE, changes); return { summary: r.summary, deployId: 'dep1', before: {}, after: {}, playerCount: r.playerCount, uploaded: 0 }; },
  };
  return site;
}

module.exports = { PAGE, fakeSite };
