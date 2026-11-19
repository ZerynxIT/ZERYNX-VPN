const $ = (s) => document.querySelector(s),
  box = $("#content"),
  dlg = $("#dialog"),
  fields = $("#fields"),
  form = $("#form");
let api = "",
  token = "",
  users = [],
  view = "home",
  account = "",
  handler;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const num = (n) =>
  Number(n).toLocaleString("fa-IR", { maximumFractionDigits: 2 });
const labels = {
  home: "داشبورد",
  users: "کاربران و اشتراک‌ها",
  settings: "تنظیمات",
};
function clear() {
  token = "";
  account = "";
  users = [];
  render();
}
async function call(path, body) {
  let r;
  try {
    r = await fetch(api + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  } catch {
    throw Error("ورکر پاسخ نداد. آدرس و مجوز دامنهٔ پنل را بررسی کنید.");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token) clear();
    throw Error(
      {
        UNAUTHORIZED: "اطلاعات ورود یا کلید نصب درست نیست.",
        DUPLICATE: "این نام قبلاً استفاده شده است.",
        INVALID_INPUT: "نام، حجم و مدت اعتبار را بررسی کنید.",
      }[d.error] ||
        d.error ||
        "درخواست ناموفق بود.",
    );
  }
  return d;
}
function modal(title, html, action, label = "تأیید") {
  form.reset();
  $("#title").textContent = title;
  fields.innerHTML = html;
  $("#error").textContent = "";
  $("#submit").textContent = label;
  handler = action;
  if (!dlg.open) dlg.showModal();
  (fields.querySelector("input") || $("#submit")).focus();
}
const input = (name, title, type = "text", attrs = "") =>
  `<label>${title}<input name="${name}" type="${type}" required ${attrs}></label>`;
function connect() {
  modal(
    "اتصال به Cloudflare Worker",
    input(
      "address",
      "نشانی HTTPS ورکر",
      "url",
      `value="${esc(api)}" placeholder="https://your-worker.workers.dev"`,
    ),
    async (d) => {
      const u = new URL(d.address);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        u.hash
      )
        throw Error("فقط نشانی اصلی HTTPS ورکر را وارد کنید.");
      clear();
      api = u.origin;
      const status = await call("/api/setup/status");
      login(!status.installed);
    },
    "بررسی اتصال",
  );
}
function login(setup = false) {
  modal(
    setup ? "راه‌اندازی مدیر" : "ورود مدیر",
    input(
      "username",
      "نام کاربری",
      "text",
      'value="admin" pattern="[a-zA-Z0-9_\\-]{3,32}"',
    ) +
      input(
        "password",
        setup ? "رمز جدید (۱۲ تا ۱۲۸ نویسه)" : "رمز عبور",
        "password",
        setup
          ? 'minlength="12" maxlength="128" autocomplete="new-password"'
          : 'autocomplete="current-password"',
      ) +
      (setup ? input("setupKey", "کلید نصب یک‌بارمصرف", "password") : ""),
    async (d) => {
      if (setup) await call("/api/setup", d);
      const a = await call("/api/auth/login", {
        username: d.username,
        password: d.password,
      });
      token = a.token;
      account = a.admin.username;
      await refresh();
      dlg.close();
    },
    setup ? "ثبت مدیر و ورود" : "ورود",
  );
}
async function refresh() {
  users = (await call("/api/users")).users;
  render();
}
function issue(link) {
  modal(
    "اشتراک آماده است",
    `<p>این لینک خصوصی است؛ آن را فقط به صاحب اشتراک بدهید.</p><label>لینک اشتراک<input readonly value="${esc(link)}"></label>`,
    async () => {
      await navigator.clipboard.writeText(link);
      dlg.close();
      $("#message").textContent = "لینک اشتراک کپی شد.";
    },
    "کپی لینک",
  );
}
function create() {
  if (!token) return connect();
  modal(
    "ساخت اشتراک",
    input("username", "نام کاربر", "text", 'pattern="[a-zA-Z0-9_\\-]{3,32}"') +
      input(
        "gb",
        "حجم (گیگابایت)",
        "number",
        'min="0.001" max="10000" step="0.001" value="10"',
      ) +
      input("days", "اعتبار (روز)", "number", 'min="1" max="3650" value="30"'),
    async (d) => {
      const r = await call("/api/users", {
        ...d,
        gb: Number(d.gb),
        days: Number(d.days),
      });
      await refresh();
      issue(r.link);
    },
    "ساخت و دریافت لینک",
  );
}
function render() {
  const alive = (u) =>
    u.status === "active" &&
    Date.parse(u.expires_at) > Date.now() &&
    u.used_bytes < u.quota_bytes;
  $("#connect").textContent = token ? account + " · خروج" : "اتصال به ورکر";
  $("#section").textContent = labels[view];
  document
    .querySelectorAll("[data-view]")
    .forEach((b) =>
      b.setAttribute(
        "aria-current",
        b.dataset.view === view ? "page" : "false",
      ),
    );
  const stats = [
    ["کل کاربران", "USR", users.length],
    ["اشتراک فعال", "SUB", users.filter(alive).length],
    ["مصرف • GB", "NET", users.reduce((n, u) => n + u.used_bytes, 0) / 1e9],
  ];
  let html =
    view === "home"
      ? `<div class="stats">${stats.map(([a, b, c]) => `<div class="stat"><span>${a}</span><i>${b}</i><b>${token ? num(c) : "—"}</b></div>`).join("")}</div>`
      : "";
  if (view === "settings")
    html += `<section class="panel"><small>WORKSPACE / SETTINGS</small><h2>تنظیمات اتصال</h2><p>${esc(api || "هنوز ورکری متصل نیست.")}</p><button data-action="connect" class="outline">تنظیم اتصال</button> ${token ? '<button data-action="credentials">تغییر مشخصات مدیر</button>' : ""}</section>`;
  else
    html += `<section class="panel"><div class="row"><div><small>SUBSCRIPTION DIRECTORY</small><h2>${view === "home" ? "آخرین اشتراک‌ها" : "فهرست اشتراک‌ها"}</h2></div><button class="outline" data-action="${token ? "refresh" : "connect"}">${token ? "تازه‌سازی" : "اتصال"}</button></div>${
      !users.length
        ? `<div class="empty">${token ? "هنوز اشتراکی نساخته‌اید." : "برای مشاهدهٔ اشتراک‌ها، ورکر خود را متصل کنید."}</div>`
        : `<div class="table"><table><thead><tr><th>کاربر</th><th>مصرف / سقف GB</th><th>انقضا</th><th>وضعیت</th><th>مدیریت</th></tr></thead><tbody>${users
            .slice(0, view === "home" ? 5 : undefined)
            .map(
              (u) =>
                `<tr><td>${esc(u.username)}</td><td>${num(u.used_bytes / 1e9)} / ${num(u.quota_bytes / 1e9)}</td><td>${new Date(u.expires_at).toLocaleDateString("fa-IR")}</td><td>${alive(u) ? "فعال" : "غیرفعال"}</td><td><button data-id="${esc(u.id)}" data-action="rotate" class="outline">لینک جدید</button> <button data-id="${esc(u.id)}" data-action="toggle" class="outline">${u.status === "active" ? "تعلیق" : "فعال‌سازی"}</button></td></tr>`,
            )
            .join("")}</tbody></table></div>`
    }</section>`;
  box.innerHTML = html;
}
form.onsubmit = async (e) => {
  e.preventDefault();
  const b = $("#submit");
  b.disabled = true;
  try {
    await handler(Object.fromEntries(new FormData(form)));
  } catch (e) {
    $("#error").textContent = e.message;
  } finally {
    b.disabled = false;
  }
};
$("#close").onclick = () => dlg.close();
$("#connect").onclick = () => {
  if (!token) return connect();
  modal(
    "خروج مدیر",
    "<p>نشست فعلی پایان می‌یابد.</p>",
    async () => {
      await call("/api/auth/logout", {});
      clear();
      dlg.close();
    },
    "خروج",
  );
};
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.view) {
    view = b.dataset.view;
    render();
    return;
  }
  const a = b.dataset.action;
  try {
    if (a === "connect") connect();
    if (a === "create") create();
    if (a === "refresh") await refresh();
    if (a === "credentials")
      modal(
        "تغییر مشخصات مدیر",
        input("current", "رمز فعلی", "password") +
          input("username", "نام جدید", "text", `value="${esc(account)}"`) +
          input(
            "password",
            "رمز جدید",
            "password",
            'minlength="12" maxlength="128"',
          ),
        async (d) => {
          await call("/api/credentials", d);
          clear();
          login();
        },
      );
    if (["rotate", "toggle"].includes(a))
      modal(
        a === "rotate" ? "جایگزینی لینک قبلی" : "تغییر وضعیت اشتراک",
        "<p>این تغییر روی دسترسی کاربر اثر می‌گذارد.</p>",
        async () => {
          const r = await call("/api/users/" + b.dataset.id + "/" + a, {});
          await refresh();
          if (r.link) issue(r.link);
          else dlg.close();
        },
      );
  } catch (e) {
    $("#message").textContent = e.message;
  }
});
render();
