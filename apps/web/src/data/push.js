// Phone notifications and installing the app, the browser's side.
// The server's side is netlify/functions/push.js (+ lib/push.js); the worker
// that shows a notification and opens its page is public/sw.js.
//
//   pushState()      → { state, devices }  state: 'on' | 'off' | 'blocked' | 'unsupported' | 'needs-install'
//   enablePush()     must be called straight from a tap (the browser asks first)
//   disablePush(), removeDevice(id), sendTestPush()
//   platform()       → { ios, android, mobile, standalone }
//   install prompt:  onInstallable(cb), promptInstall()  (Android / desktop Chrome)
//   install hint:    installHintDismissed(), dismissInstallHint()
import { callFunctionJson } from 'lib/api';
import { t } from 'lib/i18n';

const nav = typeof navigator !== 'undefined' ? navigator : {};
const win = typeof window !== 'undefined' ? window : {};

export function platform() {
  const ua = String(nav.userAgent || '');
  const ios = /iPhone|iPad|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const standalone = !!(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) || nav.standalone === true;
  return { ios, android, mobile: ios || android || /Mobi/.test(ua), standalone };
}

const supported = () => 'serviceWorker' in nav && 'PushManager' in win && 'Notification' in win;

// ── The install prompt (Chrome on Android and the desktop) ─────────────
// The browser offers it once, early; it is kept until a tap uses it.
let deferred = null;
const listeners = new Set();
const tell = () => listeners.forEach((cb) => cb(!!deferred));
if (win.addEventListener) {
  win.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; tell(); });
  win.addEventListener('appinstalled', () => { deferred = null; tell(); });
}
export function onInstallable(cb) { listeners.add(cb); cb(!!deferred); return () => listeners.delete(cb); }
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const e = deferred; deferred = null; tell();
  e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
  return choice.outcome;
}

const HINT_KEY = 'install-hint-dismissed';
export function installHintDismissed() { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } }
export function dismissInstallHint() { try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ } }

// ── Push ───────────────────────────────────────────────────────────────
const call = (body) => callFunctionJson('push', { method: 'POST', body });

async function registration() {
  const existing = await nav.serviceWorker.getRegistration();
  if (!existing) await nav.serviceWorker.register('/sw.js');
  const timeout = new Promise((_, no) => setTimeout(() => no(new Error(t('The app is still loading. Reload the page and try again.'))), 10000));
  return Promise.race([nav.serviceWorker.ready, timeout]);
}

const keyBytes = (b64) => {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const sameKey = (buf, bytes) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((x, i) => x === bytes[i]);
};

async function currentSubscription() {
  const reg = await nav.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function pushState() {
  const p = platform();
  if (p.ios && !p.standalone) return { state: 'needs-install', devices: await call({ op: 'list' }).then((r) => r.devices).catch(() => []) };
  if (!supported()) return { state: 'unsupported', devices: [] };
  const sub = await currentSubscription().catch(() => null);
  let { devices } = await call({ op: 'list', endpoint: sub ? sub.endpoint : '' });
  const granted = Notification.permission === 'granted';
  // The browser still has it but the server lost it (a long silence, a restore): tell it again.
  if (sub && granted && !devices.some((d) => d.thisDevice)) {
    ({ devices } = await call({ op: 'subscribe', subscription: sub.toJSON(), installed: p.standalone }));
  }
  if (Notification.permission === 'denied') return { state: 'blocked', devices };
  return { state: sub && granted ? 'on' : 'off', devices };
}

/** Straight from the tap: the permission question must come first. */
export async function enablePush() {
  const answer = await Notification.requestPermission();
  if (answer !== 'granted') return pushState();
  const reg = await registration();
  const { publicKey } = await call({ op: 'key' });
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const { devices } = await call({ op: 'subscribe', subscription: sub.toJSON(), installed: platform().standalone });
  return { state: 'on', devices };
}

export async function disablePush() {
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    await call({ op: 'unsubscribe', endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => {});
  }
  return pushState();
}

export async function removeDevice(id) {
  const sub = supported() ? await currentSubscription().catch(() => null) : null;
  const { devices } = await call({ op: 'unsubscribe', id, endpoint: sub ? sub.endpoint : '' });
  // Removing this very device from the list also turns it off here.
  if (sub && !devices.some((d) => d.thisDevice)) await sub.unsubscribe().catch(() => {});
  return pushState();
}

export const sendTestPush = () => call({ op: 'test' });
