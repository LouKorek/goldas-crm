// Seals small secrets (third-party tokens) before they are written to
// Firestore, so a reader of the database alone cannot use them. The key is
// derived from the service-account private key the functions already hold
// (HKDF), so nothing new has to be configured.
//
//   seal('abc')   -> 'enc:v1:<iv>:<tag>:<ciphertext>'  (base64url parts)
//   unseal(x)     -> 'abc'; a plaintext value (no 'enc:' prefix) is returned
//                    as is, so existing records keep working until re-sealed.
const crypto = require('crypto');

let _key;
function key() {
  if (_key) return _key;
  const material = process.env.SEAL_KEY || JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}').private_key;
  if (!material) throw new Error('no key material for seal(): set FIREBASE_SERVICE_ACCOUNT_KEY or SEAL_KEY');
  _key = Buffer.from(crypto.hkdfSync('sha256', material, 'goldas-crm', 'seal-v1', 32));
  return _key;
}

const b64 = (b) => Buffer.from(b).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url');

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `enc:v1:${b64(iv)}:${b64(c.getAuthTag())}:${b64(enc)}`;
}

const isSealed = (v) => typeof v === 'string' && v.startsWith('enc:v1:');

function unseal(value) {
  if (!isSealed(value)) return value;
  const [, , iv, tag, data] = value.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), unb64(iv));
  d.setAuthTag(unb64(tag));
  return Buffer.concat([d.update(unb64(data)), d.final()]).toString('utf8');
}

module.exports = { seal, unseal, isSealed, _resetKeyForTests: () => { _key = undefined; } };
