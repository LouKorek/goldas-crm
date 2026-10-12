#!/usr/bin/env node
// Restore a backup taken by netlify/functions/backup-weekly.js.
//
// The backup is JSON Lines (format jsonl-v1): one line per document,
//   { "p": "players/abc123", "d": { ...fields } }
// with Firestore types encoded as { __ts: millis }, { __geo: [lat, lng] },
// { __ref: "path" }, { __b64: "..." }. Subcollections are plain paths too.
//
// Usage (documented in docs/runbooks.md):
//   FIREBASE_SERVICE_ACCOUNT_KEY='<json>' node scripts/restore-backup.mjs <file.jsonl> [--only players,clubs] [--apply]
//
// Without --apply it only reports what it would write. With --apply it
// writes every line with set(..., { merge: false }), so a document is put
// back exactly as it was in the backup. Documents created after the backup
// are left alone (nothing is deleted); remove them by hand if needed.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean)) : null;
if (!file) { console.error('usage: node scripts/restore-backup.mjs <backup.jsonl> [--only=players,clubs] [--apply]'); process.exit(2); }

const revive = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(revive);
  if ('__ts' in v && Object.keys(v).length === 1) return admin.firestore.Timestamp.fromMillis(v.__ts);
  if ('__geo' in v && Object.keys(v).length === 1) return new admin.firestore.GeoPoint(v.__geo[0], v.__geo[1]);
  if ('__b64' in v && Object.keys(v).length === 1) return Buffer.from(v.__b64, 'base64');
  if ('__ref' in v && Object.keys(v).length === 1) return admin.firestore().doc(v.__ref);
  const o = {}; for (const k of Object.keys(v)) o[k] = revive(v[k]); return o;
};

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const rows = lines.map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`line ${i + 1} is not JSON`); } })
  .filter((r) => r && r.p && r.d && (!only || only.has(r.p.split('/')[0])));
const perCollection = {};
for (const r of rows) perCollection[r.p.split('/')[0]] = (perCollection[r.p.split('/')[0]] || 0) + 1;
console.log(`${rows.length} documents in ${Object.keys(perCollection).length} collections:`);
for (const [c, n] of Object.entries(perCollection).sort()) console.log(`  ${c.padEnd(24)} ${n}`);

if (!apply) { console.log('\nDry run. Add --apply to write these documents back.'); process.exit(0); }

if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) { console.error('FIREBASE_SERVICE_ACCOUNT_KEY is required to write.'); process.exit(2); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)) });
const db = admin.firestore();
let written = 0;
for (let i = 0; i < rows.length; i += 400) {
  const batch = db.batch();
  for (const r of rows.slice(i, i + 400)) batch.set(db.doc(r.p), revive(r.d));
  await batch.commit();
  written += Math.min(400, rows.length - i);
  console.log(`  wrote ${written}/${rows.length}`);
}
console.log('Done. Open the app and check the recycle bin and the audit log before telling anyone.');
