// ─────────────────────────────────────────────────────────────────────────
// Jewish / Israeli name database for the Transfermarkt watch.
//
// Structure: every entry is a canonical spelling plus explicit variant
// spellings. On top of that, `fold()` normalises transliteration drift
// (Cohen/Kohen/Coen, Horowitz/Hurwitz/Gurevich-style families are listed
// explicitly; folding handles c/k, tz/ts/z, i/y, w/v, ph/f, -man/-mann,
// -ski/-sky, doubled letters, and vowel-h drops), so one listed stem
// matches thousands of real-world spellings.
//
// tier 1 = strongly indicative (Cohen, Ben-*, Ohayon, Rosenberg…)
// tier 2 = possible (Stern, Blum, Roth… common German/Slavic overlap)
//
// Player matching = surname match OR first-name match. Citizenship-based
// detection is handled separately (Transfermarkt "Foreigners" pages) and
// always outranks name matches.
// ─────────────────────────────────────────────────────────────────────────

// [name, [variants...], tier]
const SURNAMES = [
  // ── Kohanic / Levitic families ──
  ['Cohen', ['Kohen','Coen','Cohn','Kohn','Cohan','Kahan','Kahane','Cahan','Kohane','Koen','Coyne'], 1],
  ['Kahn', ['Cahn','Kagan','Kogan','Kaganovich','Kohansky'], 1],
  ['Katz', ['Kats','Kac','Katzman','Katzenelson','Kacev'], 1],
  ['Levi', ['Levy','Lewy','Levie','Halevi','Halevy','Levit','Levitt','Lewit'], 1],
  ['Levin', ['Levine','Lewin','Levinsky','Levinson','Lewinsky','Levinstein'], 1],
  ['Kaplan', ['Caplan','Kaplansky','Kaplinsky'], 1],
  ['Segal', ['Siegel','Segel','Sagal','Segalovich','Chagall'], 1],
  ['Aluf', [], 2],
  // ── Classic Ashkenazi compounds (-berg/-stein/-feld/-baum/-blatt/-thal) ──
  ['Goldberg', ['Golberg'], 1], ['Rosenberg', ['Rozenberg'], 1],
  ['Greenberg', ['Grinberg','Grünberg','Grunberg','Gruenberg'], 1],
  ['Steinberg', [], 1], ['Weinberg', ['Vainberg','Wainberg'], 1],
  ['Silberberg', ['Zilberberg','Silverberg'], 1], ['Friedberg', [], 1],
  ['Goldstein', ['Goldstien','Goldshtein'], 1], ['Bernstein', ['Bernstien','Bernshtein'], 1],
  ['Rubinstein', ['Rubinshtein','Rubistein'], 1], ['Epstein', ['Epshtein','Eppstein'], 1],
  ['Feinstein', ['Fainstein'], 1], ['Silverstein', ['Zilberstein','Silberstein'], 1],
  ['Rothstein', [], 1], ['Lowenstein', ['Loewenstein','Levenstein'], 1],
  ['Wallerstein', [], 1], ['Finkelstein', ['Finkelshtein'], 1], ['Braunstein', ['Bronstein','Bronshtein'], 1],
  ['Rosenfeld', ['Rozenfeld'], 1], ['Blumenfeld', [], 1], ['Grunfeld', ['Grünfeld','Greenfeld'], 1],
  ['Sommerfeld', [], 2], ['Mandelbaum', [], 1], ['Teitelbaum', ['Taitelbaum'], 1],
  ['Applebaum', ['Appelbaum','Apfelbaum'], 1], ['Nussbaum', ['Nusbaum'], 1],
  ['Greenbaum', ['Grinbaum','Grünbaum'], 1], ['Kirschenbaum', ['Kirshenbaum'], 1],
  ['Rosenblatt', ['Rozenblat'], 1], ['Rosenthal', ['Rozental','Rosental'], 1],
  ['Blumenthal', ['Blumental'], 1], ['Lilienthal', [], 2],
  ['Rosenblum', ['Rozenblum'], 1], ['Weintraub', ['Vaintrub'], 1],
  ['Goldman', ['Goldmann'], 1], ['Perlman', ['Pearlman','Perelman'], 1],
  ['Friedman', ['Freedman','Fridman','Friedmann'], 1], ['Kaufman', ['Kaufmann','Koifman'], 1],
  ['Lieberman', ['Liberman','Libermann'], 1], ['Zuckerman', ['Zukerman','Cukierman'], 1],
  ['Wasserman', ['Vaserman'], 1], ['Grossman', ['Grosman'], 1],
  ['Weissman', ['Vaisman','Waisman','Weisman'], 1], ['Bergman', ['Bergmann'], 2],
  ['Fishman', ['Fischman'], 1], ['Furman', ['Fuhrman'], 2], ['Shulman', ['Schulman'], 1],
  ['Feldman', ['Feldmann'], 1], ['Hoffman', ['Hoffmann','Hofman'], 2],
  ['Neuman', ['Neumann','Naiman','Nayman'], 2], ['Wechsler', ['Wexler','Veksler'], 1],
  // ── -witz / -vich patronymic families ──
  ['Abramowitz', ['Abramovich','Abramovitz','Abramowicz'], 1],
  ['Berkowitz', ['Berkovich','Berkovitz','Berkowicz'], 1],
  ['Moskowitz', ['Moskovich','Moskovitz'], 1],
  ['Rabinowitz', ['Rabinovich','Rabinovitz','Rabinowicz'], 1],
  ['Lefkowitz', ['Lefkovich'], 1], ['Markowitz', ['Markovich'], 2],
  ['Leibowitz', ['Leibovich','Lebowitz','Leibovitz'], 1],
  ['Itzkowitz', ['Itzkovich','Ickowicz'], 1],
  ['Horowitz', ['Horovitz','Hurwitz','Horwitz','Gurvitz','Gurevich','Gurewicz','Hurvitz'], 1],
  ['Yankelevich', ['Jankelowitz'], 1], ['Mendelevich', [], 1],
  // ── Rabbinic / scholarly families ──
  ['Shapiro', ['Shapira','Szapiro','Chapiro','Spiro','Shapir'], 1],
  ['Halperin', ['Halpern','Alperin','Galperin','Heilprin','Halprin'], 1],
  ['Margolis', ['Margulies','Margolin','Margalit'], 1],
  ['Rappaport', ['Rapaport','Rapoport','Rappoport'], 1],
  ['Landau', ['Landa','Landauer'], 1], ['Mintz', ['Minc','Munz'], 1],
  ['Melamed', ['Melammed'], 1], ['Spektor', ['Spector','Szpektor'], 1],
  ['Luria', ['Lurie','Loria'], 1], ['Eiger', [], 1], ['Soloveitchik', [], 1],
  ['Brisker', [], 1], ['Ashkenazi', ['Ashkenazy','Eskenazi','Askenazi'], 1],
  ['Mizrahi', ['Mizrachi','Misrahi'], 1], ['Frankel', ['Fraenkel','Frenkel'], 1],
  ['Weil', ['Weill','Vail'], 2], ['Dreyfus', ['Dreyfuss','Dreifuss'], 1],
  ['Brodsky', ['Brodski'], 2], ['Pinsky', ['Pinski'], 1], ['Minsky', [], 2],
  ['Portnoy', ['Portnoi'], 1], ['Tversky', ['Twersky'], 1],
  // ── Sephardi / Mizrahi (North Africa, Middle East) ──
  ['Abecassis', ['Abekassis','Abitbol'], 1], ['Abergel', ['Abergil'], 1],
  ['Aboutboul', ['Abutbul','Abitbul'], 1], ['Abuhatzeira', ['Abihsira'], 1],
  ['Aflalo', ['Aflalou'], 1], ['Amar', ['Ammar','Amara'], 2], ['Amsalem', ['Amsellem'], 1],
  ['Anidjar', [], 1], ['Assayag', ['Asayag'], 1], ['Attias', ['Attia','Atias'], 1],
  ['Azoulay', ['Azoulai','Azulay','Azulai'], 1], ['Azran', [], 1],
  ['Bardugo', ['Berdugo'], 1], ['Benaim', ['Ben-Haim','Benhaim'], 1],
  ['Benarroch', ['Benaroch','Benaroya'], 1], ['Benayoun', ['Benayun'], 1],
  ['Benchetrit', ['Benshetrit'], 1], ['Benhamou', ['Benhamo'], 1],
  ['Bensimon', ['Ben-Simon'], 1], ['Bensoussan', ['Bensusan'], 1],
  ['Bitton', ['Biton','Bittan'], 1], ['Bouskila', ['Buskila'], 1],
  ['Buzaglo', ['Bouzaglo','Buzgalo'], 1], ['Shitrit', ['Chetrit','Sheetrit','Chitrit'], 1],
  ['Dadon', [], 1], ['Dahan', ['Dahhan'], 1], ['Danino', ['Danilo?'], 1],
  ['Dayan', ['Dayyan'], 1], ['Deri', ['Dery','Edri','Edery'], 1],
  ['Elbaz', ['El-Baz'], 1], ['Elkabetz', ['Elkabets'], 1], ['Elkayam', [], 1],
  ['Elmaleh', ['Elmalich'], 1], ['Gabay', ['Gabbay','Gabai','Ghabbay'], 1],
  ['Guedj', ['Guez'], 1], ['Halimi', [], 2], ['Hazan', ['Chazan','Hazzan','Khazan'], 1],
  ['Ifergan', [], 1], ['Ifrach', ['Ifrah'], 1], ['Illouz', ['Ilouz'], 1],
  ['Kadosh', ['Kadouch'], 1], ['Knafo', ['Knaffo'], 1], ['Lasry', ['Lasri'], 1],
  ['Malka', ['Malca','Malkah'], 1], ['Mamane', ['Maman'], 1],
  ['Marciano', [], 2], ['Mimoun', ['Mimouni','Mimon'], 1], ['Moyal', ['Mouyal'], 1],
  ['Nahmias', ['Nachmias'], 1], ['Obadia', ['Ovadia','Ovadya','Obadiah'], 1],
  ['Ohana', ['Ochana'], 1], ['Ohayon', ['Ohaion','Ohayoun'], 1],
  ['Vaknin', ['Ouaknin','Waknin','Vaqnin'], 1], ['Ouazana', ['Wazana'], 1],
  ['Peretz', ['Perets','Perec'], 1], ['Revivo', [], 1],
  ['Sabag', ['Sebbag','Sabbag','Sabah'], 2], ['Sasson', ['Sassoon'], 1],
  ['Serfaty', ['Sarfati','Tsarfati','Zarfati'], 1], ['Shukrun', ['Shokron'], 1],
  ['Siboni', ['Sebbouni'], 1], ['Suissa', ['Swissa','Souissa'], 1],
  ['Taieb', ['Tayeb'], 2], ['Toledano', [], 1], ['Turgeman', ['Tordjman','Turjeman','Tourgeman'], 1],
  ['Zafrani', ['Safrani'], 1], ['Zerbib', [], 1], ['Zaguri', ['Zagouri'], 1],
  ['Hadad', ['Haddad'], 2], ['Harush', ['Harroch','Haroush'], 1], ['Ankri', [], 1],
  ['Alfasi', ['Alfassi'], 1], ['Almoznino', [], 1], ['Bracha', ['Beracha'], 1],
  ['Kessous', [], 1], ['Medina', [], 2], ['Nagar', ['Najar'], 2], ['Nakash', [], 1],
  ['Pinto', [], 2], ['Zohar', [], 1], ['Zribi', [], 1], ['Saban', ['Shaban'], 2],
  // ── Israeli Hebrew surnames ──
  ['Arad', [], 1], ['Avital', [], 1], ['Avrahami', ['Abrahami'], 1],
  ['Azaria', ['Azarya'], 1], ['Barzilay', ['Barzilai','Barzily'], 1],
  ['Ben-David', ['Bendavid'], 1], ['Ben-Ami', ['Benami'], 1],
  ['Ben-Shimon', ['Benshimon'], 1], ['Biran', [], 1], ['Doron', [], 1],
  ['Eshel', [], 1], ['Even', [], 2], ['Gershon', ['Gerson'], 1],
  ['Golan', [], 2], ['Goren', [], 1], ['Harel', ['Arel'], 1],
  ['Hazut', [], 1], ['Kimhi', ['Kimchi'], 1], ['Lavi', ['Lavie'], 1],
  ['Maimon', ['Maymon'], 1], ['Malul', ['Maloul'], 1], ['Naor', [], 1],
  ['Nissim', ['Nisim'], 1], ['Peled', [], 1], ['Raviv', [], 1],
  ['Regev', [], 1], ['Shaked', [], 1], ['Shamir', [], 1], ['Shavit', [], 1],
  ['Shemesh', [], 1], ['Shimoni', ['Shimony'], 1], ['Tzur', ['Zur','Tsur'], 1],
  ['Yadin', [], 1], ['Sharabi', [], 1], ['Gerbi', [], 1], ['Baribo', [], 1],
  ['Solomon', ['Salomon','Shlomo'], 2], ['Zelig', ['Selig'], 1],
  // ── -son patronymics & misc Ashkenazi ──
  ['Abramson', [], 1], ['Aronson', ['Aaronson'], 1], ['Isaacson', ['Isacson'], 1],
  ['Mendelson', ['Mendelssohn','Mendelsohn'], 1], ['Levinson', ['Levinsohn'], 1],
  ['Jacobson', ['Jakobson'], 2], ['Davidson', [], 2], ['Samuelson', [], 2],
  ['Mendel', ['Mandel'], 1], ['Blum', ['Bloom','Blume'], 2], ['Stern', ['Shtern'], 2],
  ['Rosen', ['Rozen'], 2], ['Roth', [], 2], ['Weiss', ['Weis','Vais'], 2],
  ['Schwartz', ['Shvarts','Schwarz','Swartz'], 2], ['Gross', ['Groys'], 2],
  ['Klein', ['Klain'], 2], ['Braun', [], 2], ['Adler', [], 2],
  ['Singer', ['Zinger'], 2], ['Brenner', [], 2], ['Geller', ['Heller'], 2],
  ['Garfinkel', ['Gorfinkel','Garfunkel'], 1], ['Fried', ['Frid'], 2],
  ['Ehrlich', ['Erlich'], 2], ['Reich', ['Raich'], 2], ['Glick', ['Gluck','Glik'], 1],
  ['Kessler', [], 2], ['Lang', [], 2], ['Marcus', ['Markus'], 2],
  ['Wolf', ['Wolff','Vulf'], 2], ['Hirsch', ['Hirsh','Hersh','Girsh'], 1],
  ['Baran', [], 2], ['Bram', [], 2], ['Cyprys', [], 1], ['Danziger', [], 1],
  ['Eisen', ['Aizen'], 1], ['Eisenberg', ['Aizenberg'], 1], ['Fogel', ['Vogel','Feigel'], 2],
  ['Frank', [], 2], ['Ginzburg', ['Ginsburg','Ginsberg','Ginzberg'], 1],
  ['Gitelman', [], 1], ['Gottlieb', ['Gotlib'], 1], ['Grinblat', ['Greenblatt'], 1],
  ['Kantor', ['Cantor','Kantorovich'], 1], ['Karpin', [], 2], ['Kissinger', [], 2],
  ['Korek', [], 1], ['Kramer', ['Kremer'], 2], ['Lempel', [], 1],
  ['Lerner', [], 1], ['Lifshitz', ['Lifschitz','Livshits','Lipschitz','Lipshitz'], 1],
  ['Maisel', ['Meisel','Mayzel'], 1], ['Nemirovsky', [], 1], ['Olmert', [], 1],
  ['Oz', [], 2], ['Paz', [], 2], ['Perl', ['Pearl'], 1], ['Pick', [], 2],
  ['Polak', ['Pollak','Pollack','Polack'], 2], ['Rabin', ['Rabbin'], 1],
  ['Reznik', ['Resnik','Resnick'], 1], ['Sandler', [], 2], ['Scheinman', ['Shainman'], 1],
  ['Sirkin', [], 1], ['Slutsky', ['Slutzky'], 1], ['Sobol', [], 2],
  ['Tabak', [], 2], ['Vilner', ['Wilner'], 1], ['Wallach', ['Wallach','Volach','Bloch','Blokh'], 1],
  ['Yudkevich', [], 1], ['Zaks', ['Sachs','Sacks','Zaks'], 2], ['Zilber', ['Silber'], 1],
];

const FIRSTNAMES = [
  // strong = distinctly Hebrew/Israeli spelling
  ['Amit', [], 1], ['Almog', [], 1], ['Alon', ['Allon'], 1], ['Assaf', ['Asaf'], 1],
  ['Aviv', [], 1], ['Avner', [], 1], ['Barak', [], 1], ['Boaz', [], 1],
  ['Baruch', ['Boruch'], 1], ['Chaim', ['Haim','Hayim','Khaim'], 1], ['Dvir', [], 1],
  ['Doron', [], 1], ['Dor', [], 2], ['Eitan', [], 1], ['Elad', [], 1],
  ['Eliav', [], 1], ['Elior', [], 1], ['Eyal', ['Eial'], 1], ['Gal', [], 2],
  ['Gilad', ['Gilead'], 1], ['Idan', [], 1], ['Ido', ['Iddo'], 1],
  ['Ilay', ['Ilai','Ylay'], 1], ['Itay', ['Itai','Ittai'], 1], ['Itamar', [], 1],
  ['Lior', [], 1], ['Liran', [], 1], ['Maor', [], 1], ['Matan', [], 1],
  ['Meir', ['Meyer','Mayer'], 2], ['Menachem', ['Menahem'], 1],
  ['Mordechai', ['Mordecai','Motti','Moti'], 1], ['Moshe', ['Moche'], 1],
  ['Nadav', [], 1], ['Neta', [], 1], ['Nir', [], 1], ['Niv', [], 1],
  ['Noam', [], 1], ['Ofek', [], 1], ['Ofir', ['Ophir'], 1], ['Omri', [], 1],
  ['Oren', [], 1], ['Osher', [], 1], ['Raz', [], 1], ['Roee', ['Roi','Roy'], 2],
  ['Sagi', ['Sagiv'], 1], ['Shachar', ['Shahar'], 1], ['Shai', ['Shay'], 1],
  ['Shlomo', [], 1], ['Shmuel', ['Samuel'], 2], ['Snir', [], 1], ['Tal', [], 2],
  ['Tomer', [], 1], ['Tzvi', ['Zvi','Cvi'], 1], ['Udi', [], 1], ['Uri', [], 1],
  ['Yahav', [], 1], ['Yair', ['Jair'], 2], ['Yaniv', [], 1], ['Yarden', [], 1],
  ['Yariv', [], 1], ['Yehuda', ['Yehudah','Juda'], 1], ['Yigal', [], 1],
  ['Yishai', ['Ishay'], 1], ['Yoav', [], 1], ['Yogev', [], 1], ['Yonatan', [], 1],
  ['Yossi', ['Yosi'], 1], ['Yotam', [], 1], ['Zohar', [], 1], ['Zeev', ["Ze'ev"], 1],
  ['Aryeh', ['Arie','Arye'], 1], ['Akiva', [], 1], ['Avraham', [], 1],
  ['Eliyahu', ['Eliahu'], 1], ['Pinchas', ['Pinhas'], 1], ['Yitzhak', ['Itzhak','Yitzchak','Itzik'], 1],
  ['Gadi', [], 1], ['Rami', [], 2], ['Kobi', ['Koby'], 1], ['Dudu', [], 1],
  ['Eran', [], 1], ['Erez', [], 1], ['Guy', [], 2], ['Ariel', [], 2],
  ['Omer', [], 2], ['Eden', [], 2], ['Amir', [], 2],
  ['Oz', [], 2], ['Nimrod', [], 1], ['Michal', [], 1], ['Noa', ['Noah?'], 2],
  ['Yael', ['Jael'], 1], ['Shira', [], 1], ['Rotem', [], 1], ['Moran', [], 1],
  ['Liron', [], 1], ['Hila', [], 1], ['Einav', [], 1], ['Maayan', ['Maayan'], 1],
  ['Adi', [], 2], ['Shani', [], 2], ['Sapir', [], 1], ['Yuval', [], 1],
  ['Inbar', [], 1], ['Agam', [], 1], ['Orian', [], 1], ['Meshi', [], 1],
];

// ── Normalisation / folding ──────────────────────────────────────────────
// Collapses transliteration drift so "Kohen"≈"Cohen"≈"Coen".
function fold(s) {
  let x = (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[^a-z]/g, '');                            // letters only
  x = x
    .replace(/tch/g, 'z').replace(/tsch/g, 'z')
    .replace(/sch/g, 'sh')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/ck/g, 'k')
    .replace(/ch/g, 'h').replace(/kh/g, 'h')
    .replace(/c(?=[aou])/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c$/g, 'k')
    .replace(/w/g, 'v')
    .replace(/tz|ts|cz/g, 'z')
    .replace(/y/g, 'i')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/mann$/g, 'man')
    .replace(/(ski|skii|skij)$/g, 'ski').replace(/ski$/g, 'ski')
    .replace(/(vits|vitz|vich|vic|viz|wicz|witz|vits)$/g, 'viz')
    .replace(/(ie|ei|ai|ei|ay|ei)/g, 'ai')
    .replace(/([aeiou])h(?=[aeiou]|$)/g, '$1')          // vowel-h drop: kohen→koen
    .replace(/(.)\1+/g, '$1');                          // collapse doubles
  return x;
}

function buildIndex(list) {
  const m = new Map(); // folded → { name, tier }
  for (const [canon, variants, tier] of list) {
    for (const v of [canon, ...variants]) {
      const f = fold(v);
      if (!f) continue;
      const prev = m.get(f);
      if (!prev || tier < prev.tier) m.set(f, { name: canon, tier });
    }
  }
  return m;
}

const SURNAME_IDX   = buildIndex(SURNAMES);
const FIRSTNAME_IDX = buildIndex(FIRSTNAMES);

// Match a full player name ("Tai Baribo") → null or { tier, matchedOn }.
// Policy:
//   - surname hit → that tier
//   - "Ben/Bar" inside the SURNAME part (not as a first name) → tier 1
//   - strong (t1) first name alone → tier 2 ("possible", needs a look)
//   - weak (t2) first name alone → no match (too noisy: Guy, Eden, Omer…)
function matchName(fullName) {
  const raw = (fullName || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const evidence = [];

  // Ben-/Bar- in the surname portion only (skip the first token).
  if (parts.length >= 2 && /\b(ben|bar)[- ][a-z]/i.test(parts.slice(1).join(' '))) {
    evidence.push({ tier: 1, on: 'Ben-/Bar- surname' });
  }

  // Surname: last token; for 3+ token names also the last two joined
  // ("Idan Ben David" → "bendavid").
  const surnameCands = [parts[parts.length - 1]];
  if (parts.length >= 3) surnameCands.push(parts.slice(-2).join(''));
  for (const cand of surnameCands) {
    const hit = SURNAME_IDX.get(fold(cand));
    if (hit) { evidence.push({ tier: hit.tier, on: `surname: ${hit.name}` }); break; }
  }

  const surnameMatched = evidence.length > 0;

  // First name (first token).
  if (parts.length >= 2) {
    const fh = FIRSTNAME_IDX.get(fold(parts[0]));
    if (fh) {
      if (fh.tier === 1) evidence.push({ tier: surnameMatched ? 1 : 2, on: `first name: ${fh.name}` });
      else if (surnameMatched) evidence.push({ tier: 2, on: `first name: ${fh.name}` });
    }
  }

  if (!evidence.length) return null;
  return {
    tier: Math.min(...evidence.map(e => e.tier)),
    matchedOn: [...new Set(evidence.map(e => e.on))].join(' + '),
  };
}

// Query list for the Transfermarkt search rotation: every canonical + variant
// spelling once. ~1,100 distinct search strings.
function buildQueries() {
  const set = new Set();
  for (const [canon, variants] of SURNAMES) [canon, ...variants].forEach(v => set.add(v.toLowerCase()));
  return [...set];
}

module.exports = { SURNAMES, FIRSTNAMES, fold, matchName, buildQueries };
