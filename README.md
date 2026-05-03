# אנגלית בכיף 🌟 - מדריך התקנה

PWA ללימוד אנגלית לילדים, עם נגן וידאו שעוצר אוטומטית לחידונים, משחקים, וסנכרון מלא בין מכשירים.

## ארכיטקטורה

```
┌─────────────────┐         ┌─────────────────┐
│ Cloudflare Pages│         │Cloudflare Worker│
│                 │ HTTPS   │                 │
│  PWA (HTML)     │ ◄─────► │   API + Stream  │
└─────────────────┘         │                 │
                            │   ┌──────┐      │
                            │   │  KV  │ ◄── פרופילים, מילים, מטא
                            │   ├──────┤      │
                            │   │  R2  │ ◄── קבצי וידאו (streaming)
                            │   └──────┘      │
                            └─────────────────┘
```

## דרישות מקדימות

- חשבון Cloudflare (חינמי)
- Node.js + npm במחשב
- `wrangler` CLI: `npm install -g wrangler`

## התקנה - 5 שלבים

### שלב 1: יצירת R2 bucket ו-KV namespace

```bash
# התחבר ל-Cloudflare
wrangler login

# צור את ה-R2 bucket לוידאו
wrangler r2 bucket create english-kids-videos

# צור KV namespace למטא-דאטה - שמור את ה-ID שמופיע!
wrangler kv namespace create english-kids-state
# פלט לדוגמה: id = "abc123def456..."
```

### שלב 2: הגדרת ה-Worker

```bash
cd worker
npm install

# ערוך את wrangler.toml:
# החלף "REPLACE_WITH_YOUR_KV_ID" ב-ID שקיבלת בשלב 1
nano wrangler.toml

# הגדר סיסמה (זו תהיה הסיסמה שלך באתר!)
wrangler secret put AUTH_TOKEN
# יבקש להזין סיסמה - בחר משהו חזק

# פרסם
wrangler deploy
```

תקבל URL כמו: `https://english-kids-api.bnayaav.workers.dev` - **שמור אותו**, תצטרך אותו בשלב 5.

### שלב 3: הוסף CORS ל-R2 (אופציונלי)

לרוב לא נחוץ כי ה-Worker מתווך את ה-streaming.

### שלב 4: פרסום ה-PWA ל-Cloudflare Pages

**אופציה א' - דרך GitHub:**
1. דחוף את התיקייה ל-GitHub repo
2. Cloudflare Dashboard → Pages → Create → Connect to Git
3. Build command: (השאר ריק)
4. Build output directory: `public`
5. Deploy

**אופציה ב' - העלאה ישירה:**
```bash
cd public
wrangler pages deploy . --project-name=english-kids
```

### שלב 5: הגדרה ראשונה באתר

1. פתח את האתר (URL של Pages)
2. במסך "הגדרת חיבור":
   - **כתובת ה-Worker**: ה-URL מהשלב 2 (לדוגמה `https://english-kids-api.bnayaav.workers.dev`)
   - **סיסמה**: ה-AUTH_TOKEN שהגדרת
3. לחץ "התחבר"
4. צור פרופיל ראשון לילד והתחל!

## העלאת סרטים

יש 3 דרכים, באתר תחת "אזור הורה → ניהול סרטים → + הוסף סרט":

### דרך 1: ⚡ העלאה ישירה (קבצים <100MB)
פשוט בוחרים קובץ ולוחצים העלה. בר התקדמות בזמן אמת.

### דרך 2: 🚀 העלאה גדולה / multipart (סרטים שלמים)
- הקובץ מתחלק לחתיכות של 20MB
- כל חתיכה עולה בנפרד עם 3 ניסיונות חוזרים
- אפשר לבטל באמצע
- מתאים לקבצים של 1-5GB
- אם יש נפילת רשת באמצע, הסרט יופיע ב"ניהול סרטים" עם סטטוס ⏳ "לא הסתיים"

### דרך 3: 📁 העלאה דרך wrangler מהמחשב (הכי מהיר ויציב לסרטים שלמים)

```bash
# העלה את הקובץ ישירות ל-R2
wrangler r2 object put english-kids-videos/videos/frozen.mp4 --file=./Frozen.mp4

# יכול להיות מספר קבצים
wrangler r2 object put english-kids-videos/videos/luca.mp4 --file=./Luca.mp4
```

ואז באתר: **אזור הורה → ניהול סרטים → + הוסף סרט → "כבר ב-R2"**

תראה את כל הקבצים שהעלית. לחץ "+רשום" ליד כל קובץ, תן לו שם ושמור.

## עלות משוערת

| שירות | מחיר |
|-------|------|
| Worker (חינם) | עד 100,000 בקשות ביום |
| KV (חינם) | עד 100,000 קריאות ביום |
| R2 אחסון | $0.015 ל-GB לחודש (סרט 2GB = ~3 סנט בחודש) |
| R2 egress | **חינם!** (יתרון מרכזי על S3) |

לדוגמה: 50 סרטים × 2GB ממוצע = 100GB = $1.50 לחודש בלבד.

## בעיות נפוצות

### "Unauthorized" אחרי הזנת סיסמה
- ודא שה-AUTH_TOKEN שהגדרת ב-`wrangler secret put AUTH_TOKEN` זהה למה שאתה מזין באתר.
- בדוק `wrangler tail` לראות אם הבקשה מגיעה.

### העלאה גדולה נופלת באמצע
- בדוק את הרשת. ה-multipart עושה 3 ניסיונות חוזרים אוטומטית.
- אם נכשל - תוכל למחוק את הסרט הלא-גמור ולנסות שוב.
- אלטרנטיבה אמינה יותר: העלה ב-wrangler מהמחשב, ואז רשום באתר.

### הוידאו לא משתחזר במכשיר אחד מבין השניים
- ודא שהמכשיר מחובר לאותה כתובת Worker.
- בדוק "סנכרן עכשיו" בהגדרות.

### Service Worker שגיאות
- לא קריטי, ה-PWA תעבוד גם בלי. נסה להוסיף לבית-מסך מהדפדפן.

## פיתוח מקומי

```bash
# Worker dev mode
cd worker
wrangler dev

# פתח את public/index.html ושנה את כתובת ה-API במסך ההגדרה ל-http://localhost:8787
```

## מבנה הקוד

```
english-kids/
├── README.md                  ← אתה כאן
├── public/
│   └── index.html             ← ה-PWA כולה (HTML+CSS+JS)
└── worker/
    ├── src/
    │   └── index.js           ← API logic
    ├── wrangler.toml          ← Cloudflare config
    └── package.json
```

ה-`public/index.html` הוא קובץ יחיד - אין build step. ערוך אותו ישירות.

ה-Worker גם הוא קובץ יחיד שעושה הכל: ניהול state, multipart upload, video streaming עם Range requests.
