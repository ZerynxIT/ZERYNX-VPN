<div align="center">

<img src="worker/public/assets/banner.jpg" alt="ZERYNX" width="100%">

# ZERYNX

**پنل مدیریت کانفیگ و اشتراک روی Cloudflare Workers — رایگان، بدون VPS**
*Free config & subscription panel on a single Cloudflare Worker + D1 — no VPS needed*

</div>

---

## ✨ امکانات

- **همه‌چیز در یک Worker:** پنل، API، لینک ساب و موتور پروکسی. آدرس Worker را باز می‌کنی و پنل بالا می‌آید.
- **داشبورد:** آمار کاربران، نمودار مصرف روزانه، وضعیت سیستم، کاربران اخیر
- **کاربران:** ساخت با حجم (گیگ) و انقضا (روز)، ویرایش، روشن/خاموش، ریست حجم، حذف، جستجو، QR
- **اشتراک‌ها، ترافیک و گزارش‌ها** (۱۰۰ رویداد مدیریتی اخیر)
- **صفحه‌ی لینک ساب** با برند زرینیکس وقتی در مرورگر باز شود (مصرف، انقضا، افزودن به Hiddify / v2rayNG / Clash / sing-box)
- **ساب** سازگار با Hiddify، v2rayNG، Clash/Mihomo، sing-box، با هدر مصرف و انقضا و چند آی‌پی تمیز
- **موتور پروکسی** VLESS روی WebSocket + TLS با سقف حجم/انقضا، DNS روی UDP (از طریق DoH)، IPv4/IPv6/دامنه، Timeout و retry با `PROXY_IP`
- **ریسپانسیو** (موبایل و دسکتاپ)، فارسی RTL با دکمه‌ی EN، تم تیره/روشن
- دیتابیس **خودکار** ساخته می‌شود (جدول‌های `zx_*`)؛ migration دستی لازم نیست

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
| GET/POST | `/api/users` | لیست / ساخت `{name, quotaGB, days}` (۰ = نامحدود) |
| PATCH/DELETE | `/api/users/:id` | `enabled`, `quotaGB`, `days`, `resetUsage` / حذف |
| GET | `/api/stats`, `/api/logs`, `/api/status` | آمار روزانه، گزارش‌ها، وضعیت |
| GET/PUT | `/api/settings` | `clean_ips`, `proxy_ip`, `remark` |
| GET | `/sub/:token` | ساب (`?format=clash` برای Clash؛ مرورگر ← صفحه‌ی اشتراک) |

## ⚠️ محدودیت‌های صادقانه

- فقط **VLESS روی WebSocket** (بدون Trojan/Shadowsocks/Mux/Early Data). UDP فقط برای DNS.
- Workers نمی‌تواند مستقیم به بعضی آی‌پی‌های Cloudflare وصل شود؛ برای آن `PROXY_IP` را در تنظیمات پنل بگذار.
- شمارش حجم هر ~۵۰۰ کیلوبایت و هنگام بسته‌شدن اتصال در D1 ثبت می‌شود. برای اتصال‌های هم‌زمان زیاد، سقف حجم تقریبی است (مقداری فراتر از سقف ممکن است).
- شرایط استفاده‌ی Cloudflare پروکسی روی Workers را محدود می‌کند و ممکن است حساب محدود شود. **مسئولیت استفاده با خودت است.**
- تست‌های خودکار پروژه منطق را با دیتابیس و سوکت شبیه‌سازی‌شده می‌سنجد؛ **اتصال واقعی از کلاینت شما را جایگزین نمی‌کند.**

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
