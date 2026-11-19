# راهنمای راه‌اندازی ZERYNX (کاملاً گرافیکی)

بدون ترمینال. فقط مرورگر، حساب GitHub و حساب Cloudflare.

---

## گام ۰ — پاک‌سازی ریپو (یک‌بار)

در ریپو فایل‌ها و پوشه‌های قدیمی را حذف کن (در GitHub: فایل را باز کن ← سه‌نقطه ← Delete file، برای پوشه همین کار را برای هر فایل داخلش):

`index.html` (ریشه) · `preview.py` · `assets/` · `worker/schema/` · `worker/public/` (قدیمی) · `worker/wrangler.toml` (اگر هست) · `.github/workflows/` (تست‌های قدیمی که با ساختار جدید جور نیستند)

سپس این ساختار را بساز (Add file ← Upload files؛ پوشه‌ها را می‌توانی با Drag & Drop بیندازی):

```
wrangler.toml
README.md · LICENSE · NOTICE.md · .gitignore
docs/DEPLOY.fa.md
worker/src/index.js
worker/public/index.html
worker/public/assets/logo.svg
worker/public/assets/banner.jpg
```

> اگر از گوشی کار می‌کنی: Add file ← **Create new file** و در کادر نام، مسیر کامل را بنویس (مثلاً `worker/src/index.js`) تا پوشه‌ها خودکار ساخته شوند. برای `banner.jpg` از Upload files استفاده کن.

## گام ۱ — ساخت دیتابیس D1

1. وارد [dash.cloudflare.com](https://dash.cloudflare.com) شو.
2. منوی چپ: **Storage & databases** ← **D1 SQL database** (یا Workers & Pages ← D1).
3. **Create database** ← نام: `zerynx-panel-db` ← Create.
   (اگر قبلاً ساخته‌ای، همان را نگه دار؛ جدول‌های ما با پیشوند `zx_` هستند و با جدول‌های قدیمی قاطی نمی‌شوند.)
4. در صفحه‌ی Overview مقدار **Database ID** را کپی کن. محرمانه نیست.

## گام ۲ — گذاشتن Database ID در ریپو

1. در GitHub فایل `wrangler.toml` را باز کن ← آیکن مداد (Edit).
2. `PASTE-YOUR-D1-DATABASE-ID-HERE` را با Database ID جایگزین کن.
3. `name = "zerynx-vpn"` را فقط وقتی عوض کن که Worker موجودت اسم دیگری دارد (باید دقیقاً یکی باشد).
4. **Commit changes** روی شاخه‌ی `main`.

## گام ۳ — اتصال ریپو به Cloudflare و Deploy

1. Cloudflare ← **Workers & Pages** ← **Create** ← **Import a repository** (Connect to Git).
2. حساب GitHub را وصل کن و ریپوی `ZERYNX-VPN` و شاخه‌ی `main` را انتخاب کن.
3. تنظیمات Build:
   - **Project name:** `zerynx-vpn` (همان `name` داخل `wrangler.toml`)
   - **Root directory:** `/` (خالی یا ریشه؛ فایل `wrangler.toml` در ریشه است)
   - **Build command:** خالی
   - **Deploy command:** `npx wrangler deploy`
4. **Save and Deploy**. صبر کن تا Build سبز شود.
5. اگر Worker از قبل وصل بوده: **Settings ← Builds** را باز کن، Deploy command را همین مقدار بگذار (اگر قبلاً `d1 migrations apply` بود حذفش کن) و یک Commit کوچک بزن تا دوباره Deploy شود.

> نیازی به ساختن Secret یا Variable نیست. اتصال D1 با نام `DB` از `wrangler.toml` خودکار ساخته می‌شود.

## گام ۴ — تست سلامت

آدرس Worker را از صفحه‌ی Worker ← **Settings ← Domains & Routes** (یا Visit) بردار؛ شکلش `https://zerynx-vpn.<نام-تو>.workers.dev` است.

آدرس زیر را باز کن:

```
https://آدرس-worker-تو/api/health
```

- ✅ باید `"ok": true` و `"database": "connected"` ببینی.
- ❌ اگر `database: error` بود: Database ID را در `wrangler.toml` چک کن و اینکه باینِدینگ `DB` در Worker ← Settings ← Bindings هست.

## گام ۵ — اولین ورود (همین الان انجام بده)

1. آدرس اصلی Worker (بدون `/api/health`) را باز کن؛ پنل با لوگوی زرینیکس بالا می‌آید.
2. نام کاربری `admin` و رمز `admin`.
3. پنجره‌ی **تغییر اجباری رمز** باز می‌شود: نام کاربری و رمز اختصاصی (حداقل ۶ کاراکتر) بگذار.
4. تا این کار را نکنی، هیچ بخش دیگری از پنل کار نمی‌کند. **بلافاصله بعد از Deploy انجامش بده**، چون تا آن لحظه هر کسی که آدرس را بداند می‌تواند با admin/admin وارد شود.

## گام ۶ — ساخت کاربر و تست اتصال

1. منوی **ساخت کاربر جدید**: نام، حجم (گیگ) و مدت (روز) را بنویس ← «ساخت و دریافت لینک».
2. لینک ساب یا QR را در **Hiddify** یا **v2rayNG** اضافه کن.
3. اتصال بزن و یک سایت را باز کن. بعد در پنل مصرف را ببین.
4. لینک ساب را در مرورگر هم باز کن تا صفحه‌ی اشتراک برندشده را ببینی.

## عیب‌یابی

| مشکل | علت و راه‌حل |
|---|---|
| صفحه‌ی پنل باز نمی‌شود (۴۰۴) | پوشه‌ی `worker/public` و `assets` در `wrangler.toml` درست است؟ Build موفق بوده؟ |
| `/api/health` خطای database می‌دهد | Database ID اشتباه است یا باینِدینگ `DB` ساخته نشده |
| پنل می‌گوید «ارتباط با Worker برقرار نشد» | آدرس را از ریشه‌ی workers.dev باز کن، نه از جای دیگر |
| لاگین «اشتباه است» | اگر رمز را عوض کرده‌ای دیگر `admin/admin` کار نمی‌کند |
| «تلاش زیاد» | ۱۰ دقیقه صبر کن |
| کانفیگ وصل می‌شود ولی بعضی سایت‌ها باز نمی‌شوند | سایت پشت Cloudflare است: در تنظیمات پنل یک `PROXY_IP` بگذار |
| وصل نمی‌شود | ساعت دستگاه، پورت ۴۴۳، و اینکه کاربر فعال و منقضی/تمام‌حجم نباشد را چک کن |

اگر Build قرمز شد، متن خطا را برای من بفرست.
