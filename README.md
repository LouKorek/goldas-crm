# Gold A&S CRM

Football agency CRM: players, pipelines, club requirements, matches and
trainings, scouting watches and Golda (the WhatsApp assistant).

## Layout

| Path | What |
| --- | --- |
| `apps/web` | React app (Vite). Aliases `lib/`, `components/`, `pages/` point into `apps/web/src`. |
| `packages/domain` | Shared TypeScript domain: reference lists, `can()` permissions, age-group rule. Built to CJS + ESM, used by the web app and the functions. |
| `netlify/functions` | Netlify functions (syncs, watches, alerts, Golda, weekly backup). Shared helpers in `netlify/functions/lib`. |

## Commands

```
npm install        # whole workspace
npm run dev        # build domain, start Vite on :3000
npm run build      # domain, then web -> apps/web/dist
npm test           # domain (vitest) + functions (node --test)
npm run typecheck
node scripts/check-functions.mjs   # bundle every function like Netlify does
```

## Rules that hold everywhere

- Permissions are enforced in code via `can(role, action)` from `@goldas/domain`; `firestore.rules` is not touched.
- Every HTTP function is wrapped in `withAuth()` (`netlify/functions/lib/auth.js`): a Firebase ID token for users, a single-use Firestore nonce for calls between functions.
- Files live in Firestore as chunked base64 (`uploadFile` in `apps/web/src/lib/db.js`), no external storage.
- The service worker cache name is derived from the commit at build time (`apps/web/scripts/sw-version.js`); nothing to bump by hand.
- One production deploy per phase (Netlify credits).
