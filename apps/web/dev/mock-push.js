// Harness stand-in for data/push (phone notifications and installing the app).
//   ?push=on | off | blocked | unsupported | ios | empty   the Notifications card
//   ?device=iphone | android                                the home-screen hint (desktop: none)
//   ?installable=1                                          Android: the browser offers "Install"
const q = new URLSearchParams(location.search);
const device = q.get('device') || 'desktop';
const now = Date.now();
const DEVICES = [
  { id: 'a'.repeat(40), device: 'iPhone', installed: true, createdAt: now - 6 * 864e5, lastOkAt: now - 2 * 3600e3, failing: false, thisDevice: true },
  { id: 'b'.repeat(40), device: 'Windows · Chrome', installed: false, createdAt: now - 20 * 864e5, lastOkAt: now - 3 * 864e5, failing: true, thisDevice: false },
];
let state = {
  on: { state: 'on', devices: DEVICES },
  off: { state: 'off', devices: DEVICES.slice(1).map((d) => ({ ...d, failing: false })) },
  empty: { state: 'off', devices: [] },
  blocked: { state: 'blocked', devices: [] },
  unsupported: { state: 'unsupported', devices: [] },
  ios: { state: 'needs-install', devices: [] },
}[q.get('push') || 'on'];
const wait = (v) => new Promise((ok) => setTimeout(() => ok(v), 300));

export const platform = () => ({ ios: device === 'iphone', android: device === 'android', mobile: device !== 'desktop', standalone: false });
export const onInstallable = (cb) => { cb(q.get('installable') === '1'); return () => {}; };
export const promptInstall = async () => 'dismissed';
export const installHintDismissed = () => q.get('hint') === 'seen';
export const dismissInstallHint = () => {};
export const pushState = () => wait(state);
export const enablePush = () => wait((state = { state: 'on', devices: [{ ...DEVICES[0] }, ...state.devices.filter((d) => !d.thisDevice)] }));
export const disablePush = () => wait((state = { state: 'off', devices: state.devices.filter((d) => !d.thisDevice) }));
export const removeDevice = (id) => wait((state = { ...state, devices: state.devices.filter((d) => d.id !== id) }));
export const sendTestPush = () => wait({ ok: state.devices.length, gone: 0, failed: 0, devices: state.devices.length });
