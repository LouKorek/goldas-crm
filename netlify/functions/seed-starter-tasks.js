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
    title: 'הצעת מחנה אימונים של בנפיקה ליסבון למיוצגים',
    priority: 'High',
    linkedNames: [],
  },
  {
    title: 'לסגור אימונים לאבו סאלח בהפועל חיפה',
    priority: 'High',
    linkedNames: ['Abu Saleh', 'אבו סאלח', 'Saleh Abu'],
  },
  {
    title: 'מציאת קבוצות למיוצגים לעונה הקרובה',
    notes: 'שיוך כל המיוצגים — סקירת כל הרשימה ושיוך מועדונים פוטנציאליים.',
    priority: 'Urgent',
    linkedNames: '__ALL__',
  },
  {
    title: 'פוסט וולקאם לנועם ברזילי במכבי פתח תקווה',
    priority: 'Normal',
    linkedNames: ['Noam Barzilay', 'נועם ברזילי', 'Noam Brazilay'],
  },
  {
    title: 'לשלוח לשחקנים יהודים איזה מסמכים צריכים להכין',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'השלמת / חידוש הסכם ייצוג',
    notes: 'Ezra Aaron, Jay Maltz, Kai Maor, Noam Barzilay, Alon Mahlev, Aviv Palaev, Eli Schnabel, Ran Hasphia',
    priority: 'High',
    linkedNames: [
      'Noam Barzilay', 'נועם ברזילי',
      'Alon Mahlev',   'אלון מהלב',
      'Aviv Palaev',   'אביב פלייב', 'Aviv Palayev',
    ],
  },
  {
    title: 'לחבר את Shaun Ukpeli ואת Alison Mumbere לקבוצות ברואנדה ובאיחוד האמירויות',
    priority: 'High',
    linkedNames: ['Alison Mumbere'],
  },
  {
    title: 'להיפגש עם Hamed Roumald',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'מציאת קבוצות ל-Joel Asiama ול-Eric Halfin',
    priority: 'High',
    linkedNames: [],
  },
  {
    title: 'וידוא שינוי פרופיל ב-Transfermarkt לאלון מילביצקי ולגאווין כאראם',
    priority: 'Normal',
    linkedNames: [
      'Alon Milevitsky', 'Alon Milebicki', 'אלון מילביצקי',
      'Gavin Karam',     'גאווין כאראם',
    ],
  },
  {
    title: 'מציאת קבוצת נוער ל-Orian Nardimon ו-Adir Ozeri',
    priority: 'High',
    linkedNames: [],
  },
  {
    title: 'השלמת קורסים בפלטפורמת הסוכנים של FIFA',
    priority: 'Normal',
    linkedNames: [],
  },
  {
    title: 'יצירת קשר עם השחקנים מעירוני בת ים',
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

exports.handler = async () => {
  try {
    const db = getDb();

    // Idempotency guard — refuse to add if any tasks already exist.
    const existing = await db.collection('tasks').limit(1).get();
    if (!existing.empty) {
      return {
        statusCode: 409,
        body: JSON.stringify({
          ok: false,
          reason: 'tasks collection already contains documents; refusing to seed',
        }),
      };
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
