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
- `lib/wa-templates.js` – שתי תבניות UTILITY בעברית, נוצרות אוטומטית בכל פריסה
  ונבדקות כל שעה עד לאישור: `golda_digest` עם שני משתנים (כותרת, שורת תמצית של
  העדכון; `digestOf` משטח את הטקסט המלא) וכפתור "שלחי את הפירוט", ו-`golda_update`
  ("יש עדכון, לחץ") כגיבוי. נופלים ל-`hello_world` כשאין הרשאה/אישור. כך לו
  מקבל את עיקר התדריך גם בלי לחיצה; הלחיצה מביאה את הטקסט המלא.
- מסך גולדה ← התדריך שלי ← "משלוח הודעות יזומות": מצב החלון, הודעות שמחכות,
  כישלון אחרון, מצב התבנית.

## גולדה חושבת לעומק (נובמבר 2026)

לו (8.11): "אני רוצה שגולדה תהיה סופר אינטליגנטית, שתכתוב לי עדכונים מסודרים,
שתדע לעשות דברים מורכבים ושתבין דברים לעומק." מאז (ADR-19):

- **חשיבה.** effort `xhigh`, עד 60 צעדי כלים לבקשה, תשובה עד 64K טוקנים
  (בסטרימינג, `lib/wa-agent.js`). זיכרון השיחה: 60 תורות לסוכן, 80 נשמרות לכל
  נושא (`lib/golda-worker.js`). מטמון פרומפט אוטומטי (`cache_control` בראש הבקשה)
  מוריד את עלות הקריאות החוזרות בתוך אותה בקשה.
- **זיכרון ארוך-טווח.** `golda_memory` (`lib/golda-memory.js`): הכלים `remember`
  ו-`forget` לכל תפקיד. זיכרון משותף (ברירת המחדל) נראה לכל מי שמדבר עם גולדה,
  אישי רק לבעליו. כל הזיכרונות הגלויים נכנסים לפרומפט בכל שיחה ובכל נושא (עד 150
  פריטים, 12,000 תווים). גולדה לא שומרת סיסמאות, קודים, מספרי זהות או פרטי בנק.
- **כתיבה.** שורת סיכום, כותרות *מודגשות*, פריטים קונקרטיים, ובסוף "*מה עכשיו:*"
  עם 1–3 צעדים. אורך התשובה לפי השאלה. תשובה ארוכה מ-4,000 תווים מתפצלת לכמה
  הודעות בשבירות שורה (`splitText` ב-`lib/wa-api.js`).
- **כלים חדשים לתמונה הגדולה** (`lib/golda-insights.js`, קריאה בלבד):
  `changes` (מה השתנה, מי שינה, לפי תקופה/אוסף/רשומה/אדם, מתוך `audit`) ו-`overview`
  (מיוצגים, פרוספקטים, עסקאות פתוחות, דרישות שפג תוקפן, משימות באיחור, משחקי השבוע).
- **תדריך בוקר חכם.** `golda-briefing` (הקרון) רק מעיר את
  `golda-briefing-background`, שמריץ את אותה לולאה. את טקסט התדריך כותב המודל
  (`lib/golda-briefing-ai.js`, effort `high`) מתוך המשחקים, ההתראות, השינויים של
  הצוות ב-24 השעות האחרונות, העסקאות והדרישות הפתוחות והזיכרונות של האדם. השורה
  הראשונה קבועה (`*בוקר טוב, <שם>* ☀️ dd/mm`, היא הכותרת בתבנית `golda_digest`)
  והקישור לאפליקציה תמיד אחרון. בלי `ANTHROPIC_API_KEY`, בשגיאה או בתשובה ריקה
  נשלח התדריך הקבוע (`buildBriefing`) והסיבה נרשמת בעבודה. התראות דחופות ותפעול
  נשארו בתבניות קבועות.

## גולדה בשטח (נובמבר 2026, שלב א')

- **הודעות קוליות.** הודעה קולית מתומללת ב־Google Speech-to-Text (`lib/golda-speech.js`, עברית ואנגלית) עם חשבון השירות של Firebase. עד דקה בקריאה רגילה, ארוכה יותר בקריאה ארוכה. גולדה מקבלת את הטקסט עם 🎤 בתחילתו והתמליל נשמר על ההודעה ב־`wa_inbox`. אם השירות כבוי השרת מנסה להפעיל אותו בעצמו פעם אחת. מצב השירות נשמר ב־`app_meta/whatsapp.speech` ומוצג במסך גולדה (משלוח הודעות). אם התמלול לא אפשרי, הכותב מקבל בקשה לכתוב במילים.
- **כפתורים ותפריט.** תשובה שמסתיימת בשורה `[[כפתורים: א | ב | ג]]` נשלחת עם עד שלושה כפתורים (`wa.sendButtons`), והשורה עצמה לא מוצגת. לחיצה חוזרת כהודעה רגילה עם טקסט הכפתור. המילה "תפריט" (או menu / עזרה) פותחת רשימה קבועה (`MENU_ROWS` ב־`golda-worker.js`) בלי קריאה למודל. באפליקציה אותם כפתורים מופיעים כצ'יפים מתחת לתשובה האחרונה.
- **אישור קבלה.** כשהודעה מגיעה גולדה מסמנת אותה כנקראה ומציגה "מקלידה…". אם המשימה נמשכת יותר מ־20 שניות נשלחת שורה אחת "רגע, אני על זה 🔎".
- **הודעות מועברות.** הודעה שהועברה מצ'אט אחר מגיעה לגולדה עם `[הודעה מועברת]`. היא מסכמת ממי ועל מה, ומציעה מה לרשום (הערה, משימה, דרישה, משחק). היא אף פעם לא עונה לשולח המקורי.
- **צילום לו"ז.** מצילום או רשימה גולדה קוראת כל שורה, מעבירה ל־`check_schedule` (`lib/golda-briefs.js`), מציגה תוכנית (חדש / קיים / שינוי שעה / שם שלא זוהה) ושואלת פעם אחת עם כפתורים לפני שהיא יוצרת. התאמת שמות עבריים לאנגליים עוברת דרך `findPlayers`, שמנסה עכשיו ו' בודדת גם כתנועה וגם כ־v (נוה = Naveh, לוי = Levi).
- **"ספרי לי על X".** `player_brief` ו־`club_brief` מחזירים בקריאה אחת את כל מה שידוע על שחקן או מועדון. `opportunities` מחזיר את הצירופים החזקים של דרישה פתוחה × שחקן בלי עסקה.
- **3 הזדמנויות בתדריך.** התדריך היומי מקבל את ההזדמנויות (`opportunitiesOf`) ומשתמש בהן בהמלצות. ביום ראשון יש להן מקטע משלו.

## גולדה יוזמת (נובמבר 2026, שלב ב')

כל ההודעות היזומות יוצאות מהסבב השעתי (`golda-briefing.js`, :30 בכל שעה), רק בין 08:00 ל־22:00 שעון ישראל, ורק אחרי שהתדריך של אותו יום כבר נשלח לאותו אדם. מה שקרה בלילה מחכה לבוקר (`goldaSent.eventsAt` לא מתקדם בלילה).

- **דרישה חדשה.** דרישה שנוספה מאז הסבב הקודם נשלחת למנהלים ולאדמינים (חוץ ממי שהוסיף אותה) עם עד שלושה שחקנים מתאימים (`newRequirementFits` ב־`lib/golda-proactive.js`).
- **תנועות של הצוות.** שינוי שלב בעסקה שעשה מישהו אחר (`deals.history`) נשלח לאדמינים (`teamDealMoves`).
- **משימות מעקב אוטומטיות.** עסקה שתקועה בשלב יותר מהמגבלה (`FOLLOW_DAYS`: לדוגמה "הוצע למועדון" 7 ימים, "טרם נוצר קשר" 14) מקבלת משימה עם `auto: 'deal_followup'`, הבעלים של העסקה ותאריך היום, ונרשמת ב־audit כ־`golda-auto`. עד 5 משימות חדשות ביום, הארוכות ביותר קודם. המשימה נסגרת לבד כשהעסקה זזה שלב, נסגרת או נמחקת. הבעלים מקבל הודעה עם הרשימה.
- **חלונות העברות.** `lib/transfer-windows.js` מחזיק את התאריכים של הליגות המרכזיות באירופה, טורקיה, סעודיה ו־MLS לקיץ 2026 וחורף 2027 (מקור: thetransferclock.com, נבדק 2026-11-08; ישראל לא מכוסה וגולדה בודקת ברשת). הכלי `transfer_windows` פתוח לכל תפקיד. הצוות מקבל תזכורת 14 יום לפני פתיחה, ביום הפתיחה, ו־14, 7, 3 ויום אחד לפני סגירה, פעם אחת לכל מועד. התדריך היומי מזכיר חלון שנפתח או נסגר בתוך 14 יום. **צריך לעדכן את הטבלה לפני קיץ 2027.**
- **תוכנית שבוע.** ביום ראשון התדריך מקבל את 7 הימים הבאים (משחקים, אימונים, פגישות) במקטע "השבוע".
- **סיכום שבוע.** ביום חמישי ב־18:00 כל אחד מקבל סיכום של השבוע (`recapFacts` + `writeRecap`): עסקאות שזזו, חוזים, דרישות חדשות, משימות, משחקים, ומה בשבוע הבא. אדמין מקבל גם את מדד האיכות.
- **מדד איכות 👍/👎.** תגובה (reaction) על הודעה של גולדה בוואטסאפ, או לחיצה על 👍/👎 מתחת לתשובה באפליקציה (`golda-feedback.js`, רק מי ששאל), נשמרת ב־`golda_feedback` (אחת לכל אדם ותשובה; הסרה מוחקת). התשובות נמצאות לפי `wa_inbox.sentIds`. חמשת המקרים האחרונים של 👎 נכנסים לפרומפט של גולדה כדי שלא תחזור על הטעות, והסיכום השבועי מציג את הספירה ואת המקרים.

## גולדה לכל הסוכנות (נובמבר 2026, שלב ג')

- **דף שחקן PDF.** הכלי `player_pdf` (`lib/golda-pdf.js`) בונה בשרת את אותו דף שחקן שהאפליקציה מורידה (`apps/web/src/lib/playerCv.js`, עם הלוגו), באנגלית כברירת מחדל ובעברית לפי בקשה. בוואטסאפ הוא נשלח כמסמך (`wa.sendDocument`) אחרי הטקסט, ובאפליקציה הוא מופיע כצ'יפ 📄 מתחת לתשובה. הקובץ נשמר ב־`files/golda_…` לשבוע, כדי ששליחה חוזרת והאפליקציה יגיעו אליו. גולדה שולחת אותו רק למי ששאל.
- **סעיפי חוזה.** כשגולדה קוראת חוזה היא מציעה לשמור את `contractStart`/`contractEnd` ואת `contractTerms` (שכר, תקופה, דמי חתימה, סעיף שחרור, אופציה ומי מחזיק בה, בונוסים ותאריכים מרכזיים). `cleanContractTerms` ב־`wa-agent.js` בודק כל שדה. כרטיס "תנאי החוזה" מוצג בדף השחקן, ומנוע ההתראות (`alerts.ts`) מתריע לפני מועד האופציה ולפני כל תאריך מרכזי לפי ספי החוזים. התנאים חסויים.
- **סקאוטינג שבועי.** ביום ראשון ב־10:00 (שעון ישראל), בתוך הסבב השעתי, `lib/golda-scouting.js` בוחר עד 3 דרישות פתוחות: קודם כאלה שלא נסרקו אף פעם, ואחר כך מה שלא נסרק הכי הרבה זמן (פעם בשבוע לכל היותר). לכל דרישה גולדה מחפשת ברשת שחקנים מבחוץ שמתאימים, לא שחקנים שלנו, ומחזירה עד 3, כל אחד עם קישור למקור. התוצאה נשמרת ב־`club_requirements/{id}.scouting` ומוצגת בדרישה תחת "סקאוטינג של גולדה". מנהלים ואדמינים מקבלים הודעה אחת. חיפוש שנכשל לא נשמר, והדרישה תיבדק שוב בשבוע הבא. לא יוצרים קשר עם אף אחד.
- **גולדה לשחקנים.** אדמין מפעיל את זה לכל שחקן מיוצג בנפרד, בכרטיס "גולדה לשחקן" בדף השחקן: מספר וואטסאפ ומתג (`players.goldaAccess`, `players.goldaPhone`). רק אדמין יכול לשנות את השדות האלה, גם דרך גולדה. השחקן מזוהה ב־`resolveSender` רק אם המספר לא שייך לאף אחד בצוות (`role: 'player'`).
  - השחקן מקבל את `lib/golda-player.js` ולא את הסוכן הרגיל. אין לו כלי מערכת. הוא רואה רק את הפרופיל שלו: מועדון, עמדה, תאריכי חוזה, ייצוג ודרכון, והמשחקים והאימונים שלו משבוע אחורה ועד חודש קדימה. הוא יכול לבקש את דף השחקן שלו (`my_cv`).
  - הוא לא רואה עסקאות, שחקנים אחרים, תנאי כסף, הערות או קבצים.
  - מה שהוא מדווח (פציעה, הצעה, שינוי) נשמר ב־`golda_player_notes` דרך `tell_agent`. הסבב השעתי שולח את זה לאדמינים בלבד, ביום, אחרי התדריך שלהם.
  - גולדה אף פעם לא כותבת לשחקן ראשונה: שחקנים לא נכללים ב־`whatsappRecipients`. יש מגבלה של 30 הודעות ביום לשחקן.
- **קבוצות וואטסאפ.** ממתין: Meta מאפשרת קבוצות רק למספר עסקי מאומת (מספר 055), וזה עוד לא אושר.
- **תמונות וקבצים.** קובץ שנשלח לגולדה מוצג למודל אבל לא נשמר בהיסטוריית השיחה, רק שמו (PR #67). לפני כן, תמונה גדולה כמו דרכון חרגה ממגבלת הגודל של המסמך ב־Firestore, וההודעה נכשלה.
