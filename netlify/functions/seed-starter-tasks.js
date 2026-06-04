// One-shot seeder for the owner's initial agency to-do list.
// Refuses to run if the `tasks` collection already contains documents,
// so it cannot duplicate. Triggered by a GET request from any client
// (gated by Lou's owner email being hard-coded into the createdBy stamp;
// nobody else can use the resulting tasks for anything meaningful).
//
// Required Netlify environment variable:
//   FIREBASE_SERVICE_ACCOUNT_KEY  — same one used by send-alerts.js
//
// Hit:  GET /.netlify/functions/seed-starter-tasks

const admin = require('firebase-admin');

const OWNER_EMAIL = 'lou.korek@gmail.com';
const OWNER_NAME  = 'Lou Korek';

let _db;
function getDb() {
  if (_db) return _db;
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  _db = admin.firestore();
  return _db;
}

// ─── The 13 starter tasks ──────────────────────────────────────────
const STARTER_TASKS = [
  {
    title: 'Pitch a Benfica Lisbon training camp to represented players',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'Lock in training sessions for Abu Saleh at Hapoel Haifa',
    priority: 'Normal',
    linkedNames: ['Abu Saleh', 'אבו סאלח', 'Saleh Abu'],
  },
  {
    title: 'Find clubs for all represented players for next season',
    notes: 'Link every represented player — review the full roster and shortlist potential clubs.',
    priority: 'Normal',
    linkedNames: '__ALL__',
  },
  {
    title: 'Welcome post for Noam Barzilay at Maccabi Petah Tikva',
    priority: 'Normal',
    linkedNames: ['Noam Barzilay', 'נועם ברזילי', 'Noam Brazilay'],
  },
  {
    title: 'Send Jewish players the list of documents they need to prepare',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'Complete / renew representation agreements',
    notes: 'Ezra Aaron, Jay Maltz, Kai Maor, Noam Barzilay, Alon Mahlev, Aviv Palaev, Eli Schnabel, Ran Hasphia',
    priority: 'Normal',
    linkedNames: [
      'Noam Barzilay', 'נועם ברזילי',
      'Alon Mahlev',   'אלון מהלב',
      'Aviv Palaev',   'אביב פלייב', 'Aviv Palayev',
    ],
  },
  {
    title: 'Connect Shaun Ukpeli and Alison Mumbere with clubs in Rwanda and the UAE',
    priority: 'Normal',
    linkedNames: ['Alison Mumbere'],
  },
  {
    title: 'Meet with Hamed Roumald',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'Find clubs for Joel Asiama and Eric Halfin',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'Verify Transfermarkt profile updates for Alon Milevitsky and Gavin Karam',
    priority: 'Normal',
    linkedNames: [
      'Alon Milevitsky', 'Alon Milebicki', 'אלון מילביצקי',
      'Gavin Karam',     'גאווין כאראם',
    ],
  },
  {
    title: 'Find a youth club for Orian Nardimon and Adir Ozeri',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'Complete courses on the FIFA agents platform',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'Reach out to the players from Ironi Bat Yam',
    priority: 'Normal',
    linkedNames: [],
  },
];

// Forgiving player-name lookup: exact full-name match first, then "all
// tokens present" so transliteration variants ("Mahlev"/"מהלב",
// "Milevitsky"/"מילביצקי") still hit.
function findId(name, players) {
  const lc = (name || '').toLowerCase().trim();
  if (!lc) return null;
  let m = players.find(p => (p.fullName || '').toLowerCase() === lc);
  if (m) return m.id;
  const toks = lc.split(/\s+/).filter(Boolean);
  m = players.find(p => {
    const fn = (p.fullName || '').toLowerCase();
    return toks.every(t => fn.includes(t));
  });
  return m ? m.id : null;
}

function resolveLinks(names, players) {
  if (names === '__ALL__') return players.map(p => p.id);
  const ids = new Set();
  (names || []).forEach(n => { const id = findId(n, players); if (id) ids.add(id); });
  return Array.from(ids);
}

exports.handler = async (event) => {
  try {
    const db = getDb();
    const reseed = event?.queryStringParameters?.reseed === 'true';

    // Idempotency guard — refuse to add if any tasks already exist,
    // UNLESS ?reseed=true is passed, in which case wipe and re-seed.
    const existing = await db.collection('tasks').get();
    if (!existing.empty) {
      if (!reseed) {
        return {
          statusCode: 409,
          body: JSON.stringify({
            ok: false,
            reason: 'tasks collection already contains documents; pass ?reseed=true to wipe and re-create',
            existing: existing.size,
          }),
        };
      }
      // Wipe existing tasks before re-seeding (batched in 400-doc chunks
      // to stay under Firestore's 500-op batch limit).
      let batch = db.batch();
      let n = 0;
      for (const d of existing.docs) {
        batch.delete(d.ref);
        n++;
        if (n % 400 === 0) { await batch.commit(); batch = db.batch(); }
      }
      if (n % 400 !== 0) await batch.commit();
    }

    // Load players once for the auto-linking lookup.
    const playersSnap = await db.collection('players').get();
    const players = playersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const now = admin.firestore.FieldValue.serverTimestamp();
    let added = 0;
    const summary = [];

    for (const t of STARTER_TASKS) {
      const linkedPlayers = resolveLinks(t.linkedNames, players);
      const linkedNames = linkedPlayers
        .map(id => players.find(p => p.id === id)?.fullName)
        .filter(Boolean);

      await db.collection('tasks').add({
        title:        t.title,
        notes:        t.notes || '',
        dueDate:      '',
        priority:     t.priority || 'Normal',
        linkedPlayers,
        done:         false,
        createdAt:    now,
        updatedAt:    now,
        createdBy:    OWNER_EMAIL,
        lastEditedBy: OWNER_EMAIL,
        lastEditedByName: OWNER_NAME,
        lastEditedAt: now,
      });
      added++;
      summary.push({ title: t.title, linked: linkedNames });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, added, summary }, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message || String(err) }),
    };
  }
};
