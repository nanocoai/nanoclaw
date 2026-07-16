# פרומפט מסירה — התקנת גיבוי Claude→Codex על שרת daniela

הדבק את כל המסמך הזה כהודעה ראשונה בסשן Claude Code על שרת daniela (בתיקייה ~/nanoclaw-v2).

---

אתה ממשיך עבודה שפותחה ונבדקה על שרת eliabc (השרת של אליה) ב-2026-07-05/06.
המשתמש (אליה) אינו מתכנת — דבר איתו עברית פשוטה, בלי ז'רגון, שלב-שלב,
ואל תתקדם משלב לשלב בלי אישור שלו.

## מה נבנה בשרת של אליה (ומה אתה מתקין כאן)

**גיבוי אוטומטי Claude→Codex לכל קבוצת סוכן (quota fallback):**

- עמודה חדשה `fallback_provider` ב-`container_configs` (מיגרציה בשם
  `fallback-provider`; מערכת המיגרציות ממופתחת לפי שם — לא יתנגש עם
  המיגרציות המקומיות שלכם, גם אם המספור שונה).
- כשספק ה-Claude נכשל בתור עם שגיאת מכסה (usage limit / hard rate-limit /
  credit balance — ראה `QUOTA_ERROR_RE` ב-`container/agent-runner/src/quota.ts`),
  הפרומפט שלא נענה מנוסה שוב אוטומטית על Codex, והמשתמש מקבל הודעה בעברית
  ("⚠️ מכסת Claude נגמרה — ממשיך דרך Codex"). התור הבא חוזר ל-Claude,
  ובתור המוצלח הראשון נשלח "✅ חזרתי לענות דרך Claude".
- לכל ספק continuation נפרד (session_state ב-outbound.db) — ההקשר נשמר.
- כבוי כברירת מחדל. הפעלה פר-קבוצה:
  `ncl groups config update --id <group-id> --fallback-provider codex`
  (ביטול: `--fallback-provider none`). נכנס לתוקף רק ב-restart של הקונטיינר.
- ה-host ממזג את ה-mounts/env של ספק הגיבוי בזמן spawn
  (`resolveProviderContribution` ב-`src/container-runner.ts`).

**ספק Codex** (היה חסר גם אצלכם): הקומיט הראשון בסדרה מתקין את ספק Codex
מגרסת אפריל של branch providers (payload 1e7cb8b) — כולל עדכון Dockerfile
שמצמיד `codex-cli 0.124.0` לתוך אימג' הקונטיינר.

## איך הקוד מגיע לכאן

בשרת של אליה, בתיקייה `/home/exedev/nanoclaw-v2/transfer/`, מחכים:
- `quota-fallback.bundle` — git bundle של 4 הקומיטים (דורש שההיסטוריה
  המקומית מכילה את e263352, שהוא בסיס הענף)
- `0001..0004-*.patch` — אותם קומיטים כקבצי patch עצמאיים (עדיף אם ה-bundle
  לא נטמע חלק)

העברה: בקש מאליה להריץ בטרמינל של שרת eliabc (או עשה זאת אתה אם יש לך
גישת SSH לשם):
```bash
scp /home/exedev/nanoclaw-v2/transfer/*.patch exedev@<daniela-host>:~/nanoclaw-v2/transfer-in/
```
אם אין SSH בין השרתים — אליה יכול לבקש מהסשן בשרת eliabc להנגיש את הקבצים
בדרך אחרת. אל תמציא דרך עוקפת בעצמך בלי לתאם.

## סדר העבודה שלך

### 0. זיהוי המערכת ובדיקת תקינות (לפני כל שינוי!)

אתה על התקנת NanoClaw v2. קרא את `CLAUDE.md` בשורש הריפו. ואז ודא:
```bash
systemctl --user status nanoclaw-v2-*        # השירות רץ
ncl groups list                              # ה-CLI עובד; רשום אילו קבוצות יש כאן
tail -30 logs/nanoclaw.error.log             # אין שגיאות פעילות (במיוחד 401)
df -h /                                      # דיסק — חובה 5GB+ פנוי לפני בניית אימג'
git -C ~/nanoclaw-v2 status && git log --oneline -5   # מצב הריפו המקומי
```
דווח לאליה מה מצאת לפני שאתה ממשיך. אם יש 401-ים או שהשירות לא רץ —
תקן קודם (ראה HANDOFF-DANIELA-VM.md אם קיים כאן; בעיה מוכרת: טוקן
אנתרופיק בכספת פג כל ~8 שעות).

### 1. הכנסת הקוד

```bash
cd ~/nanoclaw-v2
git checkout -b feat/quota-fallback
git am transfer-in/000*.patch      # או: git fetch quota-fallback.bundle ואז cherry-pick
```
**צפוי קונפליקט אחד:** לריפו המקומי כאן יש כבר תיקון "idempotent outbound"
מקומי (commit מקומי ~125cfa6). ה-patch מס' 0002 הוא אותו תיקון בדיוק —
אם `git am` נכשל עליו, דלג עליו (`git am --skip`) והמשך. אם 0003 מתנגש
ב-`poll-loop.ts` — פתור ידנית: החלקים של ה-fallback (quota.ts, QuotaExhaustedError,
runFallbackTurn, writeNotice) חייבים להיכנס; חלקי ה-nudge/dedup כנראה כבר קיימים.

אחרי ההכנסה:
```bash
pnpm run build                                              # קומפילציית host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # typecheck קונטיינר
cd container/agent-runner && bun test && cd ../..           # כולל 7 טסטים חדשים ב-quota-fallback.test.ts
```

### 2. אימות (auth) של Codex — דורש החלטה של אליה

הקונטיינרים מקבלים מפתחות דרך OneCLI gateway. לכספת **המקומית של השרת הזה**
צריך סיקרט OpenAI:
- בדוק: `onecli secrets list` — האם קיים סיקרט עם hostPattern של api.openai.com?
- אם לא: בקש מאליה מפתח OpenAI (יש לו אחד בכספת של שרת eliabc בשם
  "OpenAI Token"). הוסף אותו לכספת כאן עם hostPattern `api.openai.com`.
- ודא שה-agents הרלוונטיים רואים אותו (`onecli agents secrets --id <id>`;
  אם secretMode=selective — או להקצות, או `set-secret-mode --mode all`).
- הוסף ל-.env (placeholder בלבד, לא מפתח אמיתי!):
  `OPENAI_API_KEY=onecli-managed`

### 3. בניית אימג' והפעלה

```bash
df -h /                    # שוב! בנייה צורכת ~4GB; אם צפוף — docker builder prune -af
./container/build.sh       # אימג' חדש עם codex בפנים
systemctl --user restart nanoclaw-v2-*    # מחיל גם את המיגרציה
```
**מלכודת מוכרת:** קבוצה עם `image_tag` מותאם-אישית (בדוק:
`ncl groups config get --id <id>`) לא תקבל את ה-codex מהאימג' החדש —
צריך `ncl groups restart --id <id> --rebuild`. ואם ה-image_tag מצביע על
אימג' שלא קיים בכלל (הקבוצה נכשלת ב-spawn עם "pull access denied") —
נקה עם `--image-tag none` (זה בדיוק מה שה-patch הרביעי מאפשר).

### 4. בדיקה חיה

בחר עם אליה קבוצת בדיקה לא-קריטית. ואז:
1. `ncl groups config update --id <id> --provider codex` + restart לקבוצה
2. שלח הודעה ("על איזה מנוע אתה רץ?") — מצופה תשובה שמזכירה GPT/OpenAI
3. החזר: `--provider claude` + restart
4. הפעל את הגיבוי: `--fallback-provider codex` (בלי לגעת ב-provider)

### 5. על אילו קבוצות להפעיל — לתאם עם אליה

**זהירות עם סוכני הפיילוט (ג'ני):** הם רצים על Haiku עם תקרת עלות יומית
של 1$ — גלישה ל-Codex עוקפת את הנחות התקציב האלה ומחייבת את חשבון
ה-OpenAI. ההמלצה: להפעיל את הגיבוי רק על הסוכנת הראשית של דניאלה,
**לא** על סוכני פיילוט, אלא אם אליה מחליט אחרת במפורש.

## אזהרות

- לא לגעת ב-ONECLI_BIND_HOST ובשרשרת ה-OneCLI. מופע gateway יחיד.
- הפעלות שירות רק דרך `systemctl --user` — לעולם לא `npm run start` ידני.
- לא לגעת ב-TELEGRAM_BOT_TOKEN וב-bot של דניאלה.
- יש pre-commit hook של prettier — commit ראשון עלול לגעת בקבצים רבים; תקין.
- כל שינוי על קבוצה חיה — רק אחרי אישור מפורש של אליה.
- בסיום: דווח לאליה במשפטים פשוטים מה הופעל, על אילו קבוצות, ומה יקרה
  כשמכסת Claude תיגמר (הודעת ⚠️ אוטומטית, תשובה מ-Codex, חזרה אוטומטית).
