// The Instagram picture itself (lib/golda-graphic.js): a real JPEG at the
// right size, under the limit, in Hebrew and English, with a long name, with
// and without a photo; the direction of mixed lines; the caption; birthdays.
const test = require('node:test');
const assert = require('node:assert/strict');
const jpeg = require('jpeg-js');
const g = require('../golda-graphic.js');

const NOAM = { kind: 'signing', lang: 'he', name: 'נועם ברזילי', club: 'מכבי נתניה' };
const LONG_EN = { kind: 'goal', lang: 'en', name: 'Alexandros Konstantinopoulos-Papadimitriou Junior', opponent: 'Hapoel Tel Aviv', goals: 2, score: '2-1', minute: '67', competition: 'Premier League' };
const LONG_HE = { kind: 'birthday', lang: 'he', name: 'אלכסנדרוס קונסטנטינופולוס-פפדימיטריו הבן', age: 23 };

// A plain test photo: a tall JPEG drawn here (no outside image).
function photo(w = 900, h = 1200) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; data[i] = 40 + (x % 200); data[i + 1] = 90; data[i + 2] = 60 + (y % 150); data[i + 3] = 255; }
  return jpeg.encode({ data, width: w, height: h }, 80).data;
}

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

test('a post and a story are JPEGs of the right size, well under 5 MB', async () => {
  for (const size of ['post', 'story']) {
    const r = await g.renderGraphic({ facts: NOAM, size });
    assert.equal(r.type, 'image/jpeg');
    assert.ok(isJpeg(r.bytes));
    const img = jpeg.decode(r.bytes, { useTArray: true });
    assert.deepEqual([img.width, img.height], [g.SIZES[size].w, g.SIZES[size].h]);
    assert.ok(r.bytes.length < 5 * 1024 * 1024 && r.bytes.length <= g.MAX_BYTES);
    assert.equal(r.photoUsed, false);
  }
});

test('every kind, Hebrew and English, a long name, with a photo: nothing throws', async () => {
  const shot = photo();
  for (const facts of [NOAM, LONG_EN, LONG_HE, { kind: 'custom', lang: 'en', name: 'Noam Barzilai', headline: 'First call-up to the national team' }]) {
    const r = await g.renderGraphic({ facts, size: 'story', photo: shot });
    assert.equal(r.photoUsed, true, facts.kind);
    assert.ok(r.bytes.length > 10000 && r.bytes.length < 5 * 1024 * 1024);
  }
});

test('a photo that cannot be read gives the card of words, not an error', async () => {
  const r = await g.renderGraphic({ facts: NOAM, size: 'post', photo: Buffer.from('not an image') });
  assert.equal(r.photoUsed, false);
  assert.ok(isJpeg(r.bytes));
});

test('the words on the picture come from the facts only', () => {
  const s = g.graphicTexts(NOAM);
  assert.equal(s.name, 'נועם ברזילי');
  assert.ok(s.details.some((d) => d.text === 'מכבי נתניה'));
  const goal = g.graphicTexts(LONG_EN);
  assert.equal(goal.hero, 'BRACE');
  assert.deepEqual(goal.details.map((d) => d.text), ['vs Hapoel Tel Aviv', "2-1 · 67' · Premier League"]);
  const bare = g.graphicTexts({ kind: 'goal', lang: 'he', name: 'נועם', opponent: 'הפועל' });
  assert.deepEqual(bare.details.map((d) => d.text), ['נגד הפועל']);   // no score or minute that was not given
});

test('a Hebrew line with an English club reads right to left, the club in one piece', () => {
  // runs in reading order; a space between them is its own run (S), placed by the drawer
  assert.deepEqual(g.lineRuns('נגד Hapoel Tel Aviv', 'rtl'), [{ t: 'נגד', dir: 'R' }, { t: 1, dir: 'S' }, { t: 'Hapoel Tel Aviv', dir: 'L' }]);
  assert.deepEqual(g.lineRuns('vs מכבי חיפה', 'ltr'), [{ t: 'vs', dir: 'L' }, { t: 1, dir: 'S' }, { t: 'מכבי חיפה', dir: 'R' }]);
});

test('the caption: two lines of facts, the fixed tags and the handle; in Hebrew no Latin tag inside a Hebrew line', () => {
  const he = g.buildCaption(NOAM).split('\n');
  assert.equal(he[0], 'ברכות לנועם ברזילי על החתימה במכבי נתניה!');
  assert.equal(he[3], '#כדורגל #חתימה');
  assert.equal(he[4], `#GoldAS ${g.HANDLE}`);
  const en = g.buildCaption(LONG_EN).split('\n');
  assert.equal(en[0], 'Alexandros Konstantinopoulos-Papadimitriou Junior scored a brace against Hapoel Tel Aviv in the 67th minute!');
  assert.equal(en[1], 'Final score: 2-1 · Premier League');
  assert.deepEqual(en.slice(-2), ['#GoldAS #football #goal', '@goldas_loukorek']);
  // a birthday with no age says no number
  assert.doesNotMatch(g.buildCaption({ kind: 'birthday', lang: 'he', name: 'דנה', female: true }), /\d/);
  assert.match(g.buildCaption({ kind: 'birthday', lang: 'he', name: 'דנה', female: true, age: 21 }), /הולדתה ה-21/);
});

test('birthdays and ages, 29 February included', () => {
  assert.equal(g.isBirthday('2002-11-25', '2026-11-25'), true);
  assert.equal(g.isBirthday('2002-11-24', '2026-11-25'), false);
  assert.equal(g.isBirthday('2004-02-29', '2027-02-28'), true);    // not a leap year
  assert.equal(g.isBirthday('2004-02-29', '2028-02-28'), false);   // a leap year has its own day
  assert.equal(g.ageOn('2002-11-25', '2026-11-25'), 24);
  assert.equal(g.ageOn('', '2026-11-25'), null);
});
