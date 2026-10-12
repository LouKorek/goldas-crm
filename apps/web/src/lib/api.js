// Calls to the site's own Netlify functions. Every function now requires a
// signed-in user, so the Firebase ID token goes along as a Bearer token.
import { auth } from 'lib/firebase';

export const callFunction = async (name, { method = 'GET', body, query } = {}) => {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  const token = await user.getIdToken();
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await fetch(`/.netlify/functions/${name}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res;
};

export const callFunctionJson = async (name, opts) => {
  const res = await callFunction(name, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
