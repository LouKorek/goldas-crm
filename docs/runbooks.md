# ספר הפעלה (Runbooks) — Gold A&S CRM

מדריך למה עושים כשמשהו קורה. כל סעיף: מה רואים, מה בודקים, מה עושים.
הכלי הראשון תמיד הוא מסך **ניהול ← מערכת** באפליקציה (`/admin`): בריאות,
מכסות, גיבויים, יומן פעולות ושגיאות. רוב התקלות נפתרות משם בלי טרמינל.

## 1. איך המערכת בנויה (בקצרה)

| רכיב | איפה | הערות |
|---|---|---|
| אפליקציה | `apps/web` (Vite + React) | מתפרסמת ל-Netlify מ-`main`. כל מיזוג = פריסה אחת (~15 קרדיטים) |
| לוגיקה משותפת | `packages/domain` | הרשאות, מנועים (התראות, התאמות), קבוצות גיל, שלבי עסקה |
| פונקציות שרת | `netlify/functions` | מתוזמנות (`schedule`), עובדים ברקע (`*-background`), API לאפליקציה |
| נתונים | Firestore | ההרשאות נאכפות **בקוד** (`can()` / `withAuth` / `useRole`), לא ב-`firestore.rules` |
| גולדה | `lib/wa-agent.js`, `lib/golda-worker.js` | וואטסאפ וצ'אט באפליקציה, אותו תור, אותו יומן |

הגרסה הרצה מופיעה בכותרת מסך המערכת (10 התווים הראשונים של הקומיט), וזהו
גם `CACHE_NAME` של ה-service worker. אפשר לוודא פריסה דרך
`https://goldas-crm.netlify.app/sw.js`.

## 2. עבודות הלילה

| עבודה | מתי (UTC) | מה עושה | אם נכשלה |
|---|---|---|---|
| `nightly-engines` | 03:00 | מחשב התראות וציוני התאמה, שומר ב-`app_meta` | הרץ שוב מ"בריאות". אם נכשל פעמיים, פתח את השגיאה בשורה |
| `sync-matches` | 03:10 | משחקי השחקנים המיוצגים (מהשרת) | ראה סעיף 5 |
| `ig-watch` | 03:50 | אינסטגרם הסוכנות | טוקן `IG_ACCESS_TOKEN` פג? מחדשים ב-Meta |
| `tm-watch` | 04:30 | מועמדים מ-Transfermarkt (ScraperAPI) | ראה סעיף 4 |
| `send-alerts` | 05:30 | תקציר יומי באימייל למי שסימן | `GMAIL_APP_PASSWORD` תקין? |
| `golda-briefing` | כל שעה ב-:30 | תדריך בוקר, התראות דחופות, התראות תפעול לאדמינים | ראה סעיף 6 |
| `golda-queue` | כל 10 דק' | ניסיונות חוזרים להודעות שנתקעו; בדיקה אם פגישה מתקרבת (הכנה של גולדה); בדיקה אם הודעה לשחקן מחובר צריכה לצאת | ראה סעיף 6 |
| `golda-player-sends` | נבדק כל 10 דק' (ב-`golda-queue`), רק 08:00–22:00 שעון ישראל | לשחקן מחובר לגולדה, לפי המתגים בכרטיס "גולדה לשחקן": הלוח השבועי (מוצ"ש 21:00), תזכורת לפני אימון, בהצלחה לפני משחק. נרשמת רק כשנשלחה, דולגה או נכשלה הודעה | ראה סעיף 6 |
| `backup-weekly` | כל לילה 01:30 (רץ כשעבר שבוע) | גיבוי מלא ל-`backups/{id}/chunks`, בדיקה עצמית ועותק חיצוני | ראה סעיף 3 |

"הרץ עכשיו" במסך הבריאות מריץ את אותו הקוד שהתזמון מריץ, ומסומן `trigger: manual`
ב-`jobs`. כל ריצה נשמרת 60 יום.

**התראות תפעול אוטומטיות** (גולדה שולחת לאדמינים בוואטסאפ, פעם ביום לכל נושא):
עבודה שנכשלה פעמיים ברצף, מכסת ScraperAPI מעל 80%, סנכרון ההתאחדות
שקט 36 שעות, אין גיבוי תקין מ-8 הימים האחרונים.

## 3. גיבוי ושחזור

- **מתי:** `backup-weekly` מתעורר כל לילה ב-01:30 UTC ושואל את `ops-background`
  אם צריך גיבוי. גיבוי רץ כשהגיבוי התקין האחרון בן שבוע (6.5 ימים) או שאין
  כזה, כך שלילה שנכשל מקבל ניסיון נוסף בלילה שאחריו. "גבה עכשיו" במסך
  הגיבויים מריץ אחד מיידי. הקוד: `netlify/functions/lib/backup.js`.
- **למה כך:** עד 11/2026 הגיבוי רץ בתוך הפונקציה המתוזמנת עצמה, ו-Netlify
  קטע אותה אחרי כ-15 שניות (סטטוס 499, שלושה ניסיונות בלילה). פונקציה
  מתוזמנת רק מפעילה עבודת רקע; העבודה עצמה תמיד ב-`*-background`.
- **בדיקה עצמית:** בסוף כל גיבוי כל החלקים נקראים בחזרה, כל שורה מפוענחת,
  והמספרים מושווים למה שנכתב. גיבוי שעבר מסומן `verified: true` ("נבדק"
  במסך); גיבוי שנכשל בבדיקה מסומן `error` והעבודה נכשלת.
- **עותק מחוץ למסד הנתונים:** אחרי הבדיקה נשמר עותק דחוס ב-Netlify Blobs
  (חנות `crm-backups`, מפתח `YYYY-MM-DD_<id>.jsonl.gz`). כישלון בשמירת העותק
  נרשם ב-`offsiteError` ("בלי עותק חיצוני" במסך) ואינו מכשיל את הגיבוי.
- **כמה נשמרים:** 8 הגיבויים התקינים האחרונים. ניסיונות שנכשלו נמחקים אחרי
  יומיים ואינם דוחקים גיבויים תקינים החוצה.
- **התראה:** אם אין גיבוי תקין מ-8 הימים האחרונים, המנהלים מקבלים על כך שורה
  בהודעת התפעול של גולדה (פעם ביום).
- **שחזור רשומה אחת:** מסך גיבויים ← "שחזר" בשורת הגיבוי ← חיפוש לפי שם ←
  "שחזר". הרשומה, כל מה שמתחתיה והקבצים שלה שכבר לא קיימים חוזרים כפי שהיו
  בגיבוי. שאר המערכת לא משתנה.
- **שחזור מלא:** אותו חלון ← "שחזר הכל". קודם נבדק שהגיבוי שלם, ואז נעשה
  גיבוי של המצב הנוכחי (`reason: before-restore`). הנתונים העסקיים נכתבים
  כפי שהיו; מסמכי מערכת (חיבורים, הגדרות, יומן פעולות) נכתבים רק אם הם
  חסרים; שום דבר לא נמחק, ורשומות שנוספו אחרי הגיבוי נשארות.
- **אם מסד הנתונים ריק:** מסך הגיבויים מציג את העותקים החיצוניים, ו"שחזר
  הכל" משחזר מהעותק.
- כל שחזור רץ ברקע (`backup-restore-background`), מופיע בבריאות כ"שחזור
  מגיבוי" ומשאיר שורה ביומן הפעולות (`action: restore, via: backup`).
- **הורדה:** מסך גיבויים ← "הורד". הקובץ הוא JSON Lines (`jsonl-v1`), שורה
  לכל מסמך: `{ "p": "players/abc", "d": {...} }`.
- **שחזור ידני מקובץ (מוצא אחרון):** `node scripts/restore-backup.mjs <קובץ>
  --only=players,clubs` מדפיס מה ייכתב; `--apply` עם
  `FIREBASE_SERVICE_ACCOUNT_KEY` בסביבה כותב.
- **תצוגה מקדימה (deploy preview) עובדת על הנתונים האמיתיים:** שחזור שנלחץ
  שם כותב לייצור.
- מחיקה רכה: רוב האוספים נמחקים ל"סל המחזור" (`deletedAt`) ומטוהרים רק
  אחרי שנכללו בגיבוי. לפני שחזור, בדוק שאין פשוט מה לשחזר מהסל.
- **מסך הבריאות:** הריצה האחרונה של כל עבודה נשמרת גם ב-`app_meta/jobStatus`,
  כך שעבודה שבועית לא נעלמת כשעבודות שעתיות ממלאות את רשימת הריצות. ריצה
  שנשארה "רץ" יותר מ-20 דקות מוצגת "נקטע".

## 4. ScraperAPI (מכסה)

- משמש **רק** את `tm-watch`. סנכרון המשחקים לא צורך קרדיטים.
- המכסה מתאפסת ב-30 לחודש. מסך המכסות מראה שימוש/מגבלה ותאריך איפוס
  (מתוך `scraper-status`, המפתח לא נחשף).
- תקציב לריצה ורזרבה נערכים במסך המכסות (`app_meta/tmWatch`). הריצה עוצרת
  מעצמה כשנשארת רזרבה.
- אם נגמר: `tm-watch` ידלג עד האיפוס. אין מה לעשות מלבד לחכות או להגדיל
  תוכנית.

## 5. סנכרון ההתאחדות (IFA)

- **מהשרת, כל בוקר (מאוקטובר 2026):** `ifa-server-cron` (03:00 UTC = 05:00/06:00
  ישראל) מפעיל את `ifa-server-sync-background`, שקורא את לוח המשחקים של כל סגל
  ישראלי דרך Exa (`lib/ifa-exa.js`) ומפרסם דרך אותו ייבוא ואותן בדיקות של
  סנכרון הדפדפן. בלי `EXA_API_KEY` הקריאה דרך שרת ה-MCP הציבורי של Exa; עם
  המפתח (חינם, 10$ בחודש, כ-20 עמודים לריצה) דרך ה-API. התוצאה ב-
  `app_meta/ifaBrowserSync` (`stats.via` = `exa-api`/`exa-mcp`/`browser`) ובעבודה
  `ifa-server-sync` במסך בריאות. ריצה שסורבה = עבודה בשגיאה עם הסיבה.
- **מהמחשב של לו: הוחזר כגיבוי (6.11.2026).** בוטל ב-24.10 והוחזר לבחירת לו,
  כי רק דפדפן אמיתי מקבל את הדף החי. משימת Chrome "Gold A&S ifa sync" רצה
  ב-07:45 כשהמחשב דלוק (הנוסח: `docs/ifa-browser-sync-task.md`). ריצה שלה
  מסמנת `ifaBrowserSync.lastBrowserSuccessAt`, ובבוקר שאחריה השרת לא מפרסם
  (פחות מ-30 שעות), כדי שעותק ישן של Exa לא ידרוס נתונים חיים. יום שהמחשב כבוי
  השרת מפרסם כרגיל. `?force=1` מאלץ ריצת שרת. רק הדפדפן יכול *לזהות סגל*
  לשחקן חדש שהודבק לו קישור שחקן; השרת מדווח עליו `ifa-lookup-needs-browser`.
- **שני עותקים, נבחר החדש (6.11.2026):** האתר חוסם שרתים, לכן Exa מחזיר את
  העותק האחרון שהצליח לקרוא, והעותק העברי והאנגלי של אותו דף מתרעננים בזמנים
  שונים (חדרה, 2186: העברי נעצר ב-19.10 והראה משחק ב-7.11 שהוקדם ל-6.11). לכן
  השרת קורא גם את הדף האנגלי, וכשבו תוצאה מאוחרת יותר הוא מעביר את המשחקים
  העבריים לתאריכים ולשעות שלו (`applyNewerDates`; השמות נשארים בעברית). אם גם
  העותק החדש מבין השניים ישן (`isStaleCopy`), הקבוצה נרשמת ב-
  `ifaBrowserSync.staleCopies` וגולדה מתריעה (`ifastale`).
- השרת מפרסם משחקים עתידיים בלבד (היסטוריה כבר במערכת; מזהה המשחק מהטקסט הוא
  `תאריך|בית|חוץ`, והייבוא מזהה רשומה קיימת לפי זהות, ADR-13).
- אם גולדה הודיעה "סנכרון ההתאחדות לא פורסם X שעות": מסך ניהול ← בריאות ←
  `ifa-server-sync`: מה הסיבה? `refused` (Cloudflare / פחות מ-70% נקראו / פחות
  מ-5 משחקים / עונה ישנה) או שגיאת Exa. `?dryRun=1` מריץ את הבדיקות בלי לכתוב.

## 6. גולדה

- **לא עונה בוואטסאפ:** בדוק `wa_inbox` (מסך ניהול ← שגיאות לא יראה זאת).
  מצבים: `queued` → `processing` → `done` / `error` / `dropped`. התור
  (`golda-queue`) מנסה שוב עד 3 פעמים. אם `error`, הסיבה בשדה `error`.
- **טוקן Meta פג (`WA_TOKEN`):** ההודעות נכנסות אך השליחה נכשלת (401 מ-
  Graph). מחדשים טוקן משתמש-מערכת ב-Meta ומעדכנים ב-Netlify.
- **Webhook:** `deploy-succeeded` מוודא אחרי כל פריסה שה-callback ב-Meta מצביע
  לייצור (`ensureWebhookCallback`). ה-verify token הוא `WA_VERIFY_TOKEN`.
- **זהות:** מספר שולח מותאם ל-`app_users.whatsapp`; מי שאינו רשום נחסם. מספרים
  נוספים לכל אדם במסך הצוות.
- **הודעות שגולדה פותחת בעצמה, לבעלים בלבד (`lib/golda-nudge.js`):**
  - הכנה לפני פגישה: `golda-queue` (כל 10 דקות) בודק אם יש פגישה עם שעה
    בעוד 10 עד 70 דקות, ומעיר את `golda-briefing-background` עם
    `{ task: 'meeting-briefs' }`. נשלחת פעם אחת לפגישה
    (`app_meta/goldaMeetingBriefs`); נרשמת כעבודה `golda-meeting-brief` רק
    כשנשלחה או נכשלה.
  - האתר עוקב אחרי ה-CRM (`lib/golda-site-follow.js`): בריצה השעתית, ביום
    ואחרי התדריך, שחקן מיוצג שהשתנה מול `app_meta/goldaSiteFollow.seen`
    מקבל טיוטה לאתר ושאלה "לפרסם?". שום דבר לא מתפרסם בלי "כן" בהודעה מאוחרת.
  - **החריג היחיד: שחקן מחובר (`lib/golda-player-sends.js`).** שחקן מיוצג
    שאדמין חיבר לגולדה (מספר + מתג בכרטיס "גולדה לשחקן") מקבל רק מה שאדמין
    הפעיל לו, כל סוג במתג משלו (`players.goldaWeek`, `goldaTrainingReminder`,
    `goldaMatchWish`): הלוח לשבוע במוצאי שבת 21:00 (או ראשון בבוקר עד 12:00
    אם התפספס), תזכורת שעתיים לפני אימון, בהצלחה ארבע שעות לפני משחק (בערב
    שלפני ב-20:00 כשזה נופל לפני 08:00). `golda-queue` בודק כל 10 דקות ומעיר את
    `golda-briefing-background` עם `{ task: 'player-sends' }`. פעם אחת לכל אירוע
    ולכל שבוע (`app_meta/goldaPlayerSends`); השחקן והאימון/המשחק נקראים שוב
    רגע לפני השליחה, כך שאימון שבוטל לא מקבל תזכורת ואימון שזז מקבל תזכורת
    "שינוי". מחוץ לחלון 24 השעות יוצאת רק תבנית שנושאת את הטקסט (brief /
    digest), אף פעם hello_world, והטקסט המלא פג בתחילת האירוע. השחקן כותב
    "די" / "הפסיקי" / "stop" → שלושת המתגים כבים, היא מאשרת בשורה, והאדמינים
    מקבלים את זה בעדכונים משחקנים (`golda_player_notes`). כלי לאדמין:
    `player_messages`.
  - שאלה יומית (`lib/golda-daily-question.js`): פעם ביום בין 13:00 ל-19:00,
    על הפער החשוב ביותר בנתוני שחקן מיוצג. מצב ב-`app_meta/goldaDailyQuestion`;
    "בלי שאלה יומית" בוואטסאפ מכבה, "תחזירי את השאלה היומית" מדליק.
  - לא נשלחות שתיים באותה שעה, ולא בלילה.
- **עומק החשיבה (`lib/golda-effort.js`):** שאלת בירור קצרה רצה ב-`medium`,
  שיחת חולין ב-`low`, וכל השאר (שינוי, שיקול דעת, קובץ, הקלטה, אתר, יוטיוב,
  תשובה לשאלה שלה) ב-`xhigh`. הרמה נרשמת בשימוש של הריצה (`effort`).
- **מכסה יומית:** `GOLDA_DAILY_LIMIT` (ברירת מחדל 150 הודעות לאדם). השימוש
  של היום במסך המכסות.
- **ביטול פעולה:** מסך גולדה ← פעולות ← "בטל", או "בטלי" בוואטסאפ. כל שינוי
  של גולדה ב-`audit` עם `via: 'golda'` ועם `onBehalfOf`.
- **התדריך/התראה לא הגיעו (אוקטובר 2026):** וואטסאפ מאפשר לעסק לכתוב חופשי רק
  24 שעות אחרי ההודעה האחרונה של האדם ("חלון שירות"). מחוץ לחלון Meta מקבלת
  את ההודעה (200) ומכשילה אותה בסטטוס 131047. הטיפול ב-`lib/wa-outbox.js`:
  כל הודעה יזומה נרשמת ב-`wa_outbox` (`sent` → `delivered`/`read`, או `queued`
  כשהחלון סגור / נכשל ב-131047). כשהחלון סגור נשלחת תבנית התנעה אחת (לכל היותר
  אחת ל-12 שעות לאדם), והודעה כלשהי מהאדם (או לחיצה על כפתור התבנית) משחררת
  את מה שחיכה. `wa_contacts/{phone}`: `lastInbound`, `lastFailure`,
  `lastReengageAt`. מסך גולדה ← התדריך שלי ← "משלוח הודעות יזומות" מראה את
  המצב לאדם עצמו.
- **התבניות `golda_digest` ו-`golda_update`:** נוצרות/נבדקות אוטומטית
  (`lib/wa-templates.js`) בכל פריסה, ב-`whatsapp-setup?key=…&template=1`, וכל
  שעה מהתדריך כל עוד אחת ממתינה; המצב ב-`app_meta/whatsapp.templates`.
  `golda_digest` נושאת את העדכון עצמו (כותרת + שורת תמצית, `digestOf` ב-
  `lib/wa-outbox.js`; בלי שורות חדשות, עד 640 תווים) וכפתור לפירוט המלא, ונשלחת
  לכל עדכון; `golda_update` ("יש עדכון, לחץ") היא הגיבוי, לכל היותר אחת ל-12
  שעות. יצירה וקריאת הסטטוס דורשות `whatsapp_business_management` על `WA_TOKEN`;
  לטוקן הנוכחי אין אותה (`status: error`, `(#200) You do not have permission`),
  ולכן התבניות נוצרות **ידנית** דרך Graph API Explorer עם המשתמש של לו (JSON
  הרכיבים ב-`wa-templates.js`, `DIGEST`/`UPDATE`), על החשבון שממנו גולדה שולחת.
  השליחה לא תלויה בסטטוס: גולדה מנסה את `golda_digest`, ואם Meta עונה 132001 (לא
  קיימת / עדיין לא מאושרת) את `golda_update`, ורק אז `hello_world` (שקיימת רק על
  חשבון הבדיקה). הצלחה ראשונה נרשמת כ-`accounts["sent:<phone_id>"] = APPROVED`
  ב-`app_meta/whatsapp.templates`. תבנית ש-Meta דחתה/השהתה (REJECTED/PAUSED)
  מדולגת. הסיבה לכישלון ב-`wa_contacts.lastReengageError` ובהערות העבודה
  `golda-briefing`; מסך גולדה ← התדריך שלי מראה איזו תבנית נשלחה לאחרונה.
  דחייה (`rejected_reason`) דורשת שינוי נוסח ב-`wa-templates.js` ויצירה מחדש.
- **המפתח של השרת ל-Meta והמעבר למספר של גולדה (נובמבר 2026):** `WA_TOKEN`
  שולח הודעות בלבד. לניהול החשבון (סטטוס בדיקה, רישום מספר, תבניות) לו לוחץ
  פעם אחת "התחבר עם פייסבוק" במסך ניהול ← וואטסאפ (`meta-connect`, Facebook
  Login for Business על האפליקציה שלנו, תצורה `LOGIN_CONFIG_ID` ב-
  `lib/meta-auth.js` או `META_LOGIN_CONFIG_ID`). התצורה חייבת להיות מסוג
  WhatsApp Embedded Signup, כדי שבחלון של פייסבוק בוחרים את "Golda - Gold AS";
  תצורה מסוג General נותנת מפתח שלא רואה את החשבון (מצב `no_access`, ו-
  `reachesWaba: false` ב-`app_meta/metaConnect`). השרת מחליף את הקוד במפתח (עם
  `WA_APP_SECRET`), שומר אותו חתום ב-`app_secrets/meta` (לא נקרא מהאפליקציה),
  ותקציר בלי סודות ב-`app_meta/metaConnect`. העבודה `meta-onboard` (כל שעה ב-:45,
  `meta-onboard-cron`) רושמת את 055-295-9496 עם PIN שהשרת מייצר ושומר חתום, מנויה
  את האפליקציה על החשבון, יוצרת את התבניות שם, מעבירה את גולדה
  (`app_meta/whatsapp.primaryPhoneId`, `lib/wa-api.js` בוחר מספר ומפתח) ומודיעה
  ללו פעם אחת. כל עוד Meta בודקת את החשבון הרישום נדחה (#100) והמצב
  `waiting_for_meta`; אחרי שהמעבר הושלם בדיקה אחת ביום. מצב: מסך ניהול ←
  וואטסאפ, או `meta-connect?status=1` עם `x-sync-secret`.

## 7. אימייל (תקציר יומי)

- נשלח מ-Gmail של הסוכנות עם `GMAIL_APP_PASSWORD`. מי מקבל: `app_users.emailAlerts`.
- אם `send-alerts` נכשל ב-535: הסיסמה פגה (סיסמת אפליקציה חדשה ב-Google).

## 8. גישה והרשאות

- תפקידים: admin / manager / viewer (`packages/domain/src/permissions.ts`).
  `scout` ו-`player` שמורים במודל לעתיד ואינם מעניקים דבר.
- הוספה/השבתה/הסרה במסך הצוות. השבתה (`active: false`) חוסמת כניסה בלי למחוק
  את הרשומה.
- הבעלים (`OWNER_EMAIL`) תמיד admin ואינו ניתן לשינוי מהמסך.
- דומיין חדש (תצוגה מקדימה) מתווסף ל-Firebase Auth אוטומטית ב-`deploy-succeeded`.

## 9. פריסות וקרדיטים של Netlify

- כל פריסת ייצור עולה כ-15 קרדיטים. לכן עבודה נאספת לענפים ונמזגת פעם אחת.
- המונה החודשי במסך המכסות (`app_meta/deploys`), נספר ב-`deploy-succeeded`.
- תצוגה מקדימה: `https://deploy-preview-<N>--goldas-crm.netlify.app`.
- אם נגמרו הקרדיטים: הפריסות נכשלות עד תחילת החודש; האפליקציה ממשיכה לרוץ.

## 10. שגיאות באפליקציה

- `ErrorBoundary` תופס קריסת רינדור ומציג מסך התאוששות; `window.onerror` ו-
  `unhandledrejection` נרשמים ל-`client_errors` (עד 5 לטעינת עמוד).
- מסך ניהול ← שגיאות: הודעה, מסך, גרסה, מי. אם הגרסה ישנה, המשתמש פשוט לא
  רענן; ה-service worker יחליף בטעינה הבאה.

## 11. בדיקות ו-CI

```
npm test                 # domain (vitest) + functions (node --test)
npm run typecheck
npm run build
node scripts/check-functions.mjs   # כל פונקציה נארזת כמו ב-Netlify
npm run e2e              # Playwright: מסך כניסה בעברית/RTL, manifest, sw, SPA fallback
```

CI (`.github/workflows/ci.yml`) מריץ את כולם על כל PR. מיזוג רק כשירוק.

## 12. משתני סביבה (Netlify)

| משתנה | למה |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | חשבון שירות (JSON) לכל הפונקציות ולסקריפט השחזור |
| `OWNER_EMAIL` | הבעלים, תמיד admin |
| `ANTHROPIC_API_KEY` | גולדה |
| `GOLDA_DAILY_LIMIT` | מכסת הודעות לאדם ליום (150) |
| `WA_TOKEN`, `WA_PHONE_ID`, `WA_APP_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_WABA_IDS`, `WA_ALLOWED_NUMBERS`, `WA_ASSISTANT_NAME` | WhatsApp Cloud API |
| `SCRAPER_API_KEY` | TM Watch |
| `IG_ACCESS_TOKEN` | אינסטגרם הסוכנות |
| `GMAIL_APP_PASSWORD` | תקציר יומי |
| `CRM_SYNC_SECRET` | גישת סקריפטים ובדיקות מצב (`x-sync-secret`) |
| `META_LOGIN_CONFIG_ID` | (רשות) תצורת "התחבר עם פייסבוק"; ברירת המחדל בקוד (`lib/meta-auth.js`) |
| `EXA_API_KEY` | (רשות) קריאת ההתאחדות מהשרת דרך Exa API; בלעדיו שרת ה-MCP הציבורי |
| `WEBHOOK_SECRET` | חתימת אירועי Netlify ל-`deploy-succeeded` |
| `SEAL_KEY` | חתימת nonces פנימיים בין פונקציות |
| `URL` | מוגדר על ידי Netlify, כתובת האתר |

ערכים לא נכתבים לעולם בקוד, בצ'אט או ביומן.

## 13. תמונת מצב, חיתוכים וייצוא
- המסך: כרטיסייה "תמונת מצב" בבית. לוח אחד עם כל הגרפים; המסננים והתקופה
  בכתובת (`?f=stage:represented|category:youth&period=season`), אז קישור הוא
  תצוגה שמורה. לחיצה על אריח, פלח או עמודה מסננת את כל הלוח; לחיצה חוזרת
  מסירה. גרף חדש על הלוח: שורה ב-`BOARD` ב-`pages/Snapshot.jsx`
  (מקור, ממד, מדד, סוג גרף, מסנן קבוע אופציונלי). שורת המבט-על (מגמות,
  משפך, ציר זמן חוזים, מפות חום) מוגדרת ב-`OVERVIEW` באותו קובץ.
- תצוגות שמורות: אוסף `saved_views` ({ name, query }). "שמור תצוגה" בשורת
  הסינון שומר את הכתובת הנוכחית; לחיצה על השם מחילה אותה; ✕ מוחק (עורכים
  בלבד). שינוי שם: לעת עתה מוחקים ושומרים מחדש.
- ממד או מדד חדש: מוסיפים רשומה ל-`DIMENSIONS` / `MEASURES` ב-
  `packages/domain/src/engines/analytics.ts` (עם `sources` שבהם הוא תקף), ואז
  `npm run build -w @goldas/domain`. המסך, הסינון המהיר והייצוא מקבלים אותו לבד.
- ייצוא ממסך רשימה: `lib/exportView.js` בונה `listReport` ומוסר לבונים. ייצוא
  מהמסך "תמונת מצב": `exportAs` ב-`pages/Snapshot.jsx` בונה דוח מלא עם PNG של
  הגרפים (`toPng`). הדפסה פותחת חלון בלחיצה ואז מזריקה אליו PDF עם `autoPrint`;
  אם הדפדפן חסם חלונות קופצים, מורידים PDF ומדפיסים ממנו.
- בדיקה מקומית בלי Firestore: `apps/web/dev/harness.html?s=snapshot` (נתוני
  דוגמה), ו-`scripts/mobile-shots.mjs` לצילומי טלפון.
- עברית ב-PDF: `lib/pdfHebrew.js` (Heebo + סידור חזותי). טקסט הפוך בקובץ
  פירושו ש-`bidiVisual` לא זיהה את הריצה; מוסיפים מקרה לבדיקה שם.

## Google calendar sync ("Gold A&S Player Schedule")

What: `calendar-sync-cron` (every 10 min) calls `calendar-sync-background`, which keeps CRM
matches and trainings and Lou's Google calendar in step, both ways (rules in
`netlify/functions/lib/gcal-sync.js`). Golda's writes to matches/trainings trigger it at once.

Setup (once): the calendar is shared with the Firebase service account's `client_email`
("Make changes to events"), and the Google Calendar API is enabled on the `gold-as-crm`
project. Until then each run stores `state: needs_share | needs_api` and the email to share
with in `app_meta/calendarSync`.

Settings in `app_meta/calendarSync`: `enabled: false` stops it; `mode: "push"` makes it
CRM -> calendar only; `calendarId` points it at another calendar. Run it now with
`POST /.netlify/functions/calendar-sync-background {"force": true}` (admin / manager token).

Safety: a pass stops without touching anything when the CRM returns no games or trainings
while the calendar has synced events, or when more than 40 events would be removed.

## Live player pages (`/p/<token>`)

What: a private page of one player for one club, made only when an admin asks Golda for it
("דף חי", "לינק לשחקן", "live page"). The PDF sheet stays the answer to "דף שחקן" / "CV".
Golda gives the link to the person who asked and to nobody else; he sends it himself.
A link works 14 days unless he names a period, 90 at most.

What a link exposes (the allow-list is `publicPlayer` in `netlify/functions/lib/player-pages.js`,
nothing else leaves the server): name, age and year of birth, positions, foot, height,
nationalities, current club and league, national team status, the video link, the public
profile link, the first profile photo, this season's totals, and a CV built from those same
fields. Never: notes, contract, salary, documents, phone numbers, agent details, deals,
interactions, tasks. Adding a field to the page means adding it to `publicPlayer` and to the
key list in the test "a player record full of private fields" in
`netlify/functions/lib/__tests__/player-pages.test.js`.

Revoke a link (it stops at once, and cannot be brought back; make a new one instead):
- in the CRM: the player's page, card "Live links" ("לינקים חיים"), button "Revoke" ("חסימה"), editors only;
- by Golda: "בטלי את הלינק של <player> ל-<club>";
- by hand: in the collection `player_pages`, set `revokedAt` on the link's document to any
  number (the time in milliseconds). Deleting the document works too.
Deleting the player also closes his links: the page answers "not available".

Where things are stored: collection `player_pages`, one document per link, read and written
only by functions (`player-page`, `player-links`, Golda). The document id is the SHA-256 of
the token; the token itself is kept sealed (`tokenSealed`, `lib/seal.js`), so a database
export or a backup holds no working link. Openings: `opens` (total), `firstOpenAt`,
`lastOpenAt`, and `openLog`, the last 100 as `{ at, device }` where device is `phone` or
`desktop`. No IP address and no browser string is kept. An opening is counted when the
page's script asks for the data, so a link preview (WhatsApp) is not one; a reload within a
minute is not counted again; the CV download and the photo are not openings. A look from a
browser that is signed in to the CRM is not counted either (the page says so in a banner).

First-opening notice: the first counted opening sets `noticeState: "pending"` and calls
`player-page-notify-background`, which sends the owner one WhatsApp line. `golda-queue-cron`
picks up any link left `pending`. It is sent at most once per link: `sent`, `failed` and
`skipped` (no owner number) are final, and a link left at `sending` means a run died in the
middle; nothing retries it, on purpose. To send it again by hand set `noticeState` back to
`pending`.

A club says the link does not work: every bad case (unknown, expired, revoked, deleted
player) gives the same sentence on purpose. Look the link up on the player's card to see
which it was.

See it without a backend: `cd apps/web && npx vite --config vite.harness.config.js`, then
`/dev/app.html?path=/p/demo` (also `demo-he`, `demo-bare`, `demo-vimeo`, `demo-preview`,
`gone`, `broken`) and `/dev/app.html?path=/players/p1` for the card (`&role=viewer`,
`&theme=dark`).

## Representation agreements (`/sign/<token>`)

What: an admin makes a representation agreement for a player from the agency's template, in the
CRM (player page, card "Representation agreement" / "הסכם ייצוג") or through Golda
("הסכם ייצוג ל<שחקן>"). The signer opens a private link, reads the text, types the name and the
ID number, draws a signature and signs. The server builds the signed PDF, files it in the
player's representation documents, sets the representation's start and end on the player
through an audited change that can be undone from the Golda screen, and tells the owner once.
Nobody in the system claims the agreement is legally binding.

Template: Admin → "הסכמי ייצוג" ("Agreements"). One per language (he, en). Every save is a new
version; old versions stay under `agreement_templates/{lang}/versions/{n}`, and each agreement
keeps its own frozen text. Without a template, creating an agreement is refused with a sentence
that says where to make one. The agency signature (drawn once per admin, same tab) goes on the
agreements that admin creates; without it the PDF prints the agency's name and the creator's.

Links: 14 days by default, 30 at most, one use. A new link (CRM "New link" / Golda "לינק חדש
להסכם") kills the old one at once; "Revoke" / "חסימה" kills it for good. After 10 failed
submissions the link locks; give a new link. A dead, expired, revoked, locked or used link gets
the same neutral sentence on purpose; look at the card to see which. After signing, the signer
can download the signed PDF for 30 minutes from the same browser.

Filing: the signing request files at once. If the PDF or the file save fails, the agreement
stays "signed, filing failed" ("נחתם, התיוק נכשל"); the signature is never lost.
`golda-queue-cron` (every ten minutes) kicks `agreement-file-background`, which retries filings
left `pending` for over two minutes, `failed`, or stuck in `working` for over five, up to 12
tries (about two hours), and sends the owner notices. If the notice went out before filing
finished, a second notice says when the PDF is in the file. The file id is `agr_<agreement id>`,
so a retry never makes a second copy. After 12 tries: fix the cause (see `filingError`, a code
only) and press "Retry now" on the card (admins), which tries once more at once, whatever the count.

Where things are stored (functions only, the browser never reads them): `agreements`,
`agreement_links` (pointers by token hash), `agreement_templates`, `agreement_signatures`,
`agreement_drafts`. The shapes are listed at the top of `netlify/functions/lib/agreements.js`.
The ID numbers live only in `agreements/{id}.signers` and in the PDF: never in logs, audit
lines, Golda's memory or error reports. The PDF file itself sits in `files` like any upload.

See it without a backend: `cd apps/web && npx vite --config vite.harness.config.js`, then
`/dev/app.html?path=/sign/demo` (also `demo-minor`, `demo-en`, `signed`, `gone`),
`/dev/app.html?path=/players/p1` for the card and `/dev/app.html?path=/system/agreements`
(`&templates=none` for no template, `&theme=dark`).
