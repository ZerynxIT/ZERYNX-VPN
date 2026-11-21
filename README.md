<div align="center">

<img src="worker/public/assets/banner.jpg" alt="ZERYNX" width="100%">

# ZERYNX

**پنل مدیریت کانفیگ و اشتراک روی Cloudflare Workers — رایگان، بدون VPS**
*Free config & subscription panel on a single Cloudflare Worker + D1 — no VPS needed*


> **🔒 اطلاعیه حقوقی:** این پروژه تحت **مجوز اختصاصی ZERYNX** منتشر شده است، نه مجوز MIT یا سایر مجوزهای متن‌باز. هرگونه تغییر، ساخت نسخه مشتق‌شده، بازبرندسازی یا استفاده تجاری بدون اجازه کتبی مالک ممنوع است. استفاده و بازنشر فقط در محدوده شرایط درج‌شده در فایل [LICENSE](LICENSE) مجاز است.
>
> **🔒 License Notice:** This project is distributed under the **ZERYNX Proprietary Source License**, not MIT or another open-source license. Modification, derivative works, rebranding, and commercial use require prior written permission. See [LICENSE](LICENSE) for the complete terms.


</div>

---

## ✨ امکانات

- **همه‌چیز در یک Worker:** پنل، API، لینک ساب و موتور پروکسی. آدرس Worker را باز می‌کنی و پنل بالا می‌آید.
- **حجم و انقضای دقیق:** حجم با «رزرو اتمیک» در دیتابیس اعمال می‌شود؛ هیچ ترکیبی از اتصال‌های هم‌زمان نمی‌تواند از سقف رد شود. مصرف آپلود + دانلود شمرده می‌شود. هر ۱ گیگ = ۱۰۲۴ مگابایت.
- **ساخت کاربر (پنجره‌ی کوچک):** نام، حجم، مدت، تعداد کانفیگ و بخش «تنظیمات پیشرفته»: سقف مصرف روزانه، محدودیت تعداد IP هم‌زمان، شروع انقضا از «ساخت» یا «اولین اتصال» و یادداشت. **حجم یا مدت ۰ یا خالی = نامحدود**؛ اگر هر دو خالی باشند کاربر کاملاً نامحدود است.
- **حداقل ۱۰ کانفیگ در هر لینک ساب** (قابل افزایش تا ۲۰۰): ترکیب آدرس‌ها × پورت‌های Cloudflare × fingerprintها، با Early Data (0-RTT) روی نیمی از آن‌ها
- **ساب چندفرمتی:** Base64 (Hiddify، v2rayNG، …)، Clash/Mihomo با `url-test`، sing-box با `urltest`، همراه با هدر مصرف و انقضا؛ آی‌پی‌های تمیز قابل تنظیم از پنل
- **صفحه‌ی لینک ساب** برندشده وقتی در مرورگر باز شود (مصرف، انقضا، تعداد کانفیگ، افزودن به اپ‌ها، کپی)
- **داشبورد:** آمار، نمودار ۱۴ و ۳۰ روزه‌ی واقعی، وضعیت سیستم، کاربران اخیر، اشتراک‌ها، ترافیک، گزارش‌ها
- **ریسپانسیو**، فارسی RTL با دکمه‌ی EN، تم تیره/روشن
- **پایدار:** Timeout اتصال، retry با `PROXY_IP`، DNS روی UDP (DoH با دو resolver)، بلاک پورت ۲۵ و آدرس‌های داخلی، دیتابیس و ستون‌ها خودکار ساخته/به‌روز می‌شوند

## 🧱 معماری

```
مرورگر ──► https://<worker>.workers.dev  ──► Worker ──┬─ Static Assets  (worker/public: پنل)
کلاینت (Hiddify, v2rayNG, …) ──► /sub/<token>         ├─ /api/*   مدیریت (توکن امضاشده)
کلاینت ──► WSS /vless                                 ├─ /sub/*   لینک ساب و صفحه‌ی اشتراک
                                                      └─ /vless   رله + شمارش حجم ──► D1 (zx_users, zx_daily, …)
```

## 🚀 راه‌اندازی

راهنمای کامل، گرافیکی و قدم‌به‌قدم: **[docs/DEPLOY.fa.md](docs/DEPLOY.fa.md)**

خلاصه: ۱) یک دیتابیس D1 بساز ← ۲) `database_id` را در `wrangler.toml` بگذار ← ۳) ریپو را در Cloudflare به‌عنوان Worker وصل و Deploy کن ← ۴) آدرس Worker را باز کن و با `admin` / `admin` وارد شو؛ پنل همان لحظه تغییر رمز را اجباری می‌کند.

## 🔐 امنیت

- اولین ورود `admin / admin` است و **تغییر نام کاربری و رمز اجباری** است. تا قبل از تغییر، هیچ بخش دیگری از API کار نمی‌کند. بلافاصله بعد از Deploy وارد شو و تغییرش بده.
- رمز با salt هش می‌شود؛ توکن ورود امضا و محدود به رمز فعلی است (با تغییر رمز، توکن‌های قدیمی باطل می‌شوند).
- محدودیت تلاش ورود: بعد از ۸ تلاش ناموفق در ۱۰ دقیقه، ۴۲۹.
- هیچ رمز یا توکنی در ریپو نیست. هیچ‌وقت توکن API کلودفلر را جایی وارد نکن.

## 🔌 API (خلاصه)

| متد | مسیر | کار |
|---|---|---|
| GET | `/api/health` | سلامت Worker و D1 (عمومی) |
| POST | `/api/login` | `{username,password}` ← `{token, must_change}` |
| POST | `/api/account` | تغییر نام کاربری/رمز |
| GET/POST | `/api/users` | لیست / ساخت `{name, quotaGB, days, cfgCount, dailyGB, ipLimit, startOnUse, note}` (۰ = نامحدود) |
| PATCH/DELETE | `/api/users/:id` | هر کدام از فیلدهای بالا + `enabled`, `resetUsage` / حذف |
| GET | `/api/stats`, `/api/logs`, `/api/status` | آمار روزانه، گزارش‌ها، وضعیت |
| GET/PUT | `/api/settings` | `clean_ips`, `proxy_ip`, `remark` |
| GET | `/sub/:token` | ساب (`?format=clash` / `singbox` / `raw`؛ مرورگر ← صفحه‌ی اشتراک) |

## ⚙️ دقت حجم و انقضا چطور کار می‌کند

- قبل از عبور هر داده، حجم در D1 با یک `UPDATE` اتمیک «رزرو» می‌شود که از حجم کل، سقف روزانه، انقضا و وضعیت فعال/غیرفعال عبور نمی‌کند. اتصال‌های یک کاربر در یک ایزوله یک استخر مشترک دارند؛ حجم رزروشده‌ی استفاده‌نشده هنگام بسته‌شدن آخرین اتصال برگردانده می‌شود.
- هنگام پایان حجم، آخرین بسته به‌صورت جزئی ارسال می‌شود و اتصال قطع می‌شود؛ خطا حداکثر چند کیلوبایت است.
- انقضا هنگام اتصال، در هر رزرو و هر ۳۰ ثانیه برای اتصال‌های جاری بررسی می‌شود؛ غیرفعال‌کردن کاربر هم اتصال‌های جاری را قطع می‌کند.
- مصرف «پیلود پروکسی» است (بدون سربار TLS/WebSocket)، پس ممکن است چند درصد کمتر از آمار شبکه‌ی خود دستگاه باشد.

## ⚠️ محدودیت‌های صادقانه

- فقط **VLESS روی WebSocket** (بدون Trojan/Shadowsocks/Mux). UDP فقط برای DNS. Workers نمی‌تواند TCP/UDP خام مثل یک سرور Xray انجام دهد.
- Workers نمی‌تواند مستقیم به بعضی آی‌پی‌های Cloudflare وصل شود؛ برای آن `PROXY_IP` را در تنظیمات پنل بگذار.
- پورت‌های متنوع (۸۴۴۳، ۲۰۵۳، ۲۰۸۳، ۲۰۸۷، ۲۰۹۶) و fingerprintهای مختلف در کانفیگ‌ها برای تنوع است؛ همه‌ی آن‌ها روی هر شبکه‌ای کار نمی‌کنند و کلاینت (با `url-test`) بهترین را انتخاب می‌کند.
- سقف رایگان D1: حدود ۱۰۰ هزار نوشتن در روز. استخر مشترک تعداد نوشتن‌ها را کم می‌کند، اما ترافیک بسیار سنگین ممکن است به سقف برسد.
- شرایط استفاده‌ی Cloudflare پروکسی روی Workers را محدود می‌کند و ممکن است حساب محدود شود. **مسئولیت استفاده با خودت است.**
- تست‌های خودکار با دیتابیس و سوکت شبیه‌سازی‌شده اجرا شده‌اند؛ **اتصال واقعی از کلاینت شما را جایگزین نمی‌کند.**

## 📄 لایسنس

MIT — Copyright (c) 2026 ZERYNX. اعتبارها و الهام‌ها: [`NOTICE.md`](NOTICE.md) · متن لایسنس: [`LICENSE`](LICENSE)

---

<details><summary><b>English summary</b></summary>

ZERYNX is a single Cloudflare Worker that serves the admin panel (Static Assets), a JSON API, subscription
links (with a branded browser page) and a VLESS-over-WebSocket relay with per-user quota/expiry stored in D1.
Deploy: create a D1 database, put its id into `wrangler.toml`, import the repo as a Worker with deploy command
`npx wrangler deploy`, open the Worker URL, log in with `admin`/`admin` and set your own credentials (forced on first login).
See [docs/DEPLOY.fa.md](docs/DEPLOY.fa.md). MIT licensed.

</details>
