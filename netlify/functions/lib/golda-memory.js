// Golda's long-term memory. A chat topic keeps only its recent turns; what
// should last (a preference, a decision, context on a player or a club) is
// saved here and shown to Golda in every conversation.
//
// golda_memory/{id}: text, about, shared (bool), owner (email, or the phone
// when the sender has no email), ownerName, createdAt, updatedAt (ms).
// Shared memories are seen by everyone who talks to Golda; personal ones only
// by their owner.
const MEMORY_MAX_ITEMS = 150;
const MEMORY_MAX_CHARS = 12000;
const TEXT_MAX = 600;

const ownerKey = (identity = {}) => identity.email || identity.phone || '';

/** The memories this person may see, newest first. */
function visibleMemories(rows, identity) {
  const me = ownerKey(identity);
  return rows
    .filter((m) => m && m.text && (m.shared || (me && m.owner === me)))
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

async function loadMemories(db, identity) {
  const snap = await db.collection('golda_memory').get();
  return visibleMemories(snap.docs.map((d) => ({ id: d.id, ...d.data() })), identity);
}

const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

/** The "What you remember" part of the system prompt, capped in items and size. */
function memorySection(memories = []) {
  if (!memories.length) return 'What you remember: nothing yet.';
  const lines = [];
  let size = 0;
  for (const m of memories.slice(0, MEMORY_MAX_ITEMS)) {
    const line = `- [${m.id}] ${m.about ? `(${m.about}) ` : ''}${m.text} — ${m.shared ? 'shared' : 'personal'}, ${m.ownerName || m.owner || ''}, ${day(m.updatedAt || m.createdAt)}`;
    if (size + line.length > MEMORY_MAX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  const more = memories.length - lines.length;
  return `What you remember (long-term memory, newest first; [id] is for forget):\n${lines.join('\n')}${more > 0 ? `\n(${more} older memories not shown)` : ''}`;
}

function memoryTools({ db, identity }) {
  const me = ownerKey(identity);
  async function remember({ text, about, shared }) {
    const t = String(text || '').trim();
    if (!t) throw new Error('text is empty');
    if (t.length > TEXT_MAX) throw new Error(`keep a memory under ${TEXT_MAX} characters; split it into several`);
    const now = Date.now();
    const doc = { text: t, about: String(about || '').trim().slice(0, 80), shared: shared !== false, owner: me, ownerName: identity.name || '', createdAt: now, updatedAt: now };
    const ref = await db.collection('golda_memory').add(doc);
    return { saved: true, id: ref.id, shared: doc.shared };
  }
  async function forget({ id }) {
    const ref = db.collection('golda_memory').doc(String(id || ''));
    const s = await ref.get();
    if (!s.exists) throw new Error('no memory with that id');
    const m = s.data();
    if (!m.shared && m.owner !== me) throw new Error("that is someone else's personal memory");
    await ref.delete();
    return { forgotten: true, id: s.id, text: m.text };
  }
  return { remember, forget };
}

module.exports = { loadMemories, visibleMemories, memorySection, memoryTools, MEMORY_MAX_ITEMS, MEMORY_MAX_CHARS };
