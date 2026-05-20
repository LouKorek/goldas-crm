# Gold A&S — Email alerts (free, no service account)

One Google Apps Script reads your CRM data (Firestore) and the SAME
notification settings you set in the app, then emails each alert ONCE,
the day it becomes due. It is not a repeating daily digest.

It authenticates as **your own Google account** — no service account and
no private key. The Google account that owns the script must have read
access to the `gold-as-crm` Firestore project (yours does).

---

## What's already set up

`Code.gs` and `appsscript.json` (with the required OAuth scopes:
`datastore`, `script.send_mail`, `script.external_request`,
`script.scriptapp`) are already in the Apps Script project.

## What you do (one time)

1. Open the Apps Script project editor.
2. Select the function **`sendDigest`** in the toolbar dropdown → **Run**.
   - First run shows a permissions screen → pick your account →
     (if shown) **Advanced → Go to … (unsafe)** → **Allow**. This is your
     own app, so it is safe.
   - Check your inbox. If nothing is due today it logs
     "No new alerts due" — that still proves it works.
3. Select **`setupDailyTrigger`** → **Run** once. It schedules a daily
   check at 08:00. Each alert still emails only once, when it is due.

## How the timing works

- The thresholds (e.g. contract `7/30/60` days before) come from the
  app's **Notification Settings**. Change them in the app and the emails
  follow automatically — they are saved to Firestore
  (`settings/notifications`), which the script reads.
- Each (player, category, threshold) is emailed at most once. When it
  crosses the next smaller threshold you configured, you get one more.
- Birthdays re-fire each year. Matches send one reminder
  `MATCH_LEAD_DAYS` (default 1) day before kickoff.

## Optional — WhatsApp

Set `WHATSAPP_PHONE`, `GREENAPI_ID`, `GREENAPI_TOKEN` (from green-api.com)
at the top of `Code.gs`. Leave `GREENAPI_ID` empty to keep WhatsApp off.

## Useful

- `resetSentState` — run manually to clear the "already sent" memory
  (so everything currently due is emailed again on the next run).
- Alerts only fire for players whose dates are filled in. Fill in
  contract / representation / passport / DOB to start receiving them.
