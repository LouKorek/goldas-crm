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
3. Golda's number. Current setup (2026-10-10): Meta's free WhatsApp test
   number (Use cases → Connect on WhatsApp → Try it out → claim a test
   number), with Lou's own number added to the recipient list (up to 5).
   No SIM or phone needed; Lou saves it as a contact named "גולדה".
   `WA_PHONE_ID` = the test number's phone number id. To move to a real
   number later: Add phone number → new SIM/eSIM, display name
   "Golda | Gold A&S", verify by SMS, then update `WA_PHONE_ID`.
4. Business settings → System users → add an admin system user → assign the
   app and the WhatsApp account (full control) → Generate token with `whatsapp_business_messaging` and
   `whatsapp_business_management`, never expiring → `WA_TOKEN`.
5. WhatsApp → Configuration → Webhook: callback
   `https://goldas-crm.netlify.app/.netlify/functions/whatsapp-webhook`,
   verify token = `WA_VERIFY_TOKEN`; subscribe to `messages`.
6. App → Publish (live mode) so real numbers can write to Golda (only needed
   with a real number; the test number talks to the recipient list).

Cost: conversations Lou starts are free on Meta's side (service
conversations); Claude API usage is billed per message.

## גולדה 2.0 (אוקטובר 2026, שלב 4 של ארכיטקטורה 3.0)

- **זהות אמיתית לכל שולח.** המספר שממנו נכתבה ההודעה מותאם ל-`app_users.whatsapp`
  (`lib/golda-identity.js`); גולדה פועלת בהרשאות של אותו אדם, ושינוייה נרשמים
  ב-`audit` עם `via: 'golda'` ו-`onBehalfOf`. מי שאינו ברשומות נחסם.
- **ערוץ אחד לוואטסאפ ולאפליקציה.** הצ'אט במסך גולדה (`/golda`) נכנס לאותו
  `wa_inbox` ואותו עובד (`lib/golda-worker.js`, `golda-chat-background`).
- **תור עם ניסיונות חוזרים.** `golda-queue-cron` (כל 10 דקות) מרים הודעות
  שנתקעו, עד 3 ניסיונות, עם נעילה של 15 דקות לכל שיחה.
- **היא מדברת ראשונה.** `golda-briefing` (כל שעה ב-:30): תדריך בוקר בשעה שכל
  אדם בחר במסך הצוות, התראות דחופות כשהן מופיעות, והתראות תפעול לאדמינים
  (עבודה שנכשלה פעמיים, מכסה מעל 80%, סנכרון ההתאחדות שקט 36 שעות).
- **כלים חדשים.** `suggest_matches`, `alerts_today`, `sync_fixtures`; כל כלי מוגבל
  לפי `toolsFor(role)`.
- **מכסה.** `GOLDA_DAILY_LIMIT` הודעות לאדם ליום; השימוש במסך ניהול ← מכסות.

## חלון 24 השעות של וואטסאפ (אוקטובר 2026)

גולדה הפסיקה "לכתוב מיוזמתה" כי WhatsApp מאפשר לעסק לשלוח טקסט חופשי רק בתוך
24 שעות מההודעה האחרונה של האדם. מחוץ לחלון Graph מחזיר 200 ואז מגיע לוובהוק
סטטוס `failed` עם קוד 131047, שהוובהוק זרק. מאז:

- `lib/wa-outbox.js` – `deliver()` לכל הודעה יזומה: בתוך החלון שולח ורושם
  ב-`wa_outbox` לפי מזהה ההודעה; כשהחלון סגור שומר (`queued`) ושולח תבנית
  התנעה אחת ל-12 שעות; `onStatuses()` מעדכן מסירה/קריאה ומזהה 131047;
  `onInbound()` מסמן `wa_contacts.lastInbound` ומשחרר את התור (הישן קודם).
- `whatsapp-webhook.js` מעביר סטטוסים ל-outbox, ולחיצה על כפתור התבנית
  ("שלחי את העדכון") משחררת את התור בלי להפעיל את הסוכן.
- `lib/wa-templates.js` – התבנית `golda_update` (UTILITY, עברית, כפתור
  Quick Reply) נוצרת אוטומטית בכל פריסה ונבדקת כל שעה עד לאישור. נופלים
  ל-`hello_world` כשאין הרשאה/אישור.
- מסך גולדה ← התדריך שלי ← "משלוח הודעות יזומות": מצב החלון, הודעות שמחכות,
  כישלון אחרון, מצב התבנית.
