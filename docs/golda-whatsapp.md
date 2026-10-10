# Golda — the WhatsApp assistant

Lou writes to Golda on WhatsApp in plain Hebrew ("תוסיפי את יוסי לוי, חלוץ,
הפועל חדרה", "תעבירי את נועם לשלב משא ומתן", a PDF with "תצרפי לנועם את
החוזה") and she makes the change in the CRM herself and replies with exactly
what changed.

## How it works

```
WhatsApp (Lou) → Meta Cloud API → whatsapp-webhook (Netlify)
                                     │ checks Meta's signature, allow list, duplicates
                                     ▼
                         whatsapp-agent-background
                                     │ Claude (claude-opus-5-5) + CRM tools
                                     ▼
                     Firestore (same shapes as the app) → reply on WhatsApp
```

- `netlify/functions/whatsapp-webhook.js` — Meta's webhook. GET verifies the
  webhook; POST checks `X-Hub-Signature-256`, ignores numbers not in
  `WA_ALLOWED_NUMBERS`, dedupes by message id (`wa_inbox`), hands off.
- `netlify/functions/whatsapp-agent-background.js` — one message at a time per
  number (lock on `wa_sessions/{phone}`), downloads attached media, runs the
  agent, sends the reply, keeps the last 30 turns as plain text.
- `netlify/functions/lib/wa-agent.js` — the tools: search, get, create,
  update, delete (two-step: only after Lou's yes in a later message),
  attach_file / remove_file (chunked base64 in `files`, exactly like
  `uploadFile`), undo_last. Collections: players, the four pipelines,
  club_requirements, matches, contacts, tasks. Users/permissions are out of
  reach on purpose.
- Every write is stamped `lastEditedByName: "גולדה (WhatsApp)"` and logged in
  `wa_audit` with before/after, which is what "תבטלי" reverses.
- `netlify/functions/data/crm-constants.js` is a copy of the lists in
  `src/lib/constants.js`; keep them in sync.

## Environment variables (Netlify, Functions scope)

| Variable | What |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (console.anthropic.com) |
| `WA_TOKEN` | Permanent system-user access token for the WhatsApp app |
| `WA_PHONE_ID` | Phone number ID of Golda's number (WhatsApp → API Setup) |
| `WA_APP_SECRET` | The Meta app's App Secret (Settings → Basic) |
| `WA_VERIFY_TOKEN` | Any random string; the same value is typed into Meta's webhook form |
| `WA_ALLOWED_NUMBERS` | Comma list of numbers allowed to give orders, digits only, e.g. `972501234567` |
| `WA_ASSISTANT_NAME` | Optional, default `גולדה` |

Without these the endpoints refuse everything (401/403), so the code is inert
until set up.

## Meta setup (once)

1. business.facebook.com → create a business portfolio (Gold A&S).
2. developers.facebook.com → Create app → type Business → add the WhatsApp product.
3. WhatsApp → API Setup → Add phone number → Golda's new SIM, display name
   "Golda | Gold A&S", verify by SMS.
4. Business settings → System users → add an admin system user → assign the
   app → Generate token with `whatsapp_business_messaging` and
   `whatsapp_business_management`, never expiring → `WA_TOKEN`.
5. WhatsApp → Configuration → Webhook: callback
   `https://goldas-crm.netlify.app/.netlify/functions/whatsapp-webhook`,
   verify token = `WA_VERIFY_TOKEN`; subscribe to `messages`.
6. App → Publish (live mode) so real numbers can write to Golda.

Cost: conversations Lou starts are free on Meta's side (service
conversations); Claude API usage is billed per message.
