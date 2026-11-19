export const active = (u) =>
  !!u &&
  u.status === "active" &&
  Number.isFinite(Date.parse(u.expires_at)) &&
  Date.parse(u.expires_at) > Date.now() &&
  u.used_bytes < u.quota_bytes;
export async function subscriberAPI(
  req,
  { DB },
  { sha256, randomToken, readJSON, response, errorResponse },
) {
  const url = new URL(req.url),
    p = url.pathname;
  const link = (t) => `${url.origin}/s/${t}`;
  const log = async (action, targetId) => {
    try {
      await DB.prepare("INSERT INTO activity_logs (id, actor_type, action, target_type, target_id) VALUES (?, 'admin', ?, 'user', ?)")
        .bind(crypto.randomUUID(), action, targetId)
        .run();
    } catch {}
  };
  if (p.startsWith("/s/") && req.method === "GET") {
    const key = p.slice(3);
    if (!/^[a-f0-9]{64}$/.test(key)) return errorResponse("NOT_FOUND", 404);
    const u = await DB.prepare(
      "SELECT u.* FROM users u JOIN subscriptions s ON s.user_id=u.id WHERE s.token_hash=? AND s.status='active'",
    )
      .bind(await sha256(key))
      .first();
    if (!u) return errorResponse("NOT_FOUND", 404);
    const valid = active(u),
      name = u.username.replace(/[^a-zA-Z0-9_-]/g, "");
    const h = {
      "Cache-Control": "private,no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    };
    if (
      req.headers.get("Accept")?.includes("text/html") &&
      !url.searchParams.has("raw")
    )
      return new Response(
        `<!doctype html><html dir="rtl" lang="fa"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اشتراک زرینیکس</title><style>body{background:#080e19;color:#eff5ff;font:16px/2 Tahoma,sans-serif;display:grid;place-items:center;min-height:92vh}main{width:min(80vw,390px);background:#101c2d;padding:32px;border:1px solid #31465c;border-radius:20px}b,a{color:#70dcff}small{letter-spacing:3px}progress{width:100%;accent-color:#70dcff}</style><main><small>ZERYNX / SUBSCRIPTION</small><h1>${name}</h1><b>${valid ? "اشتراک فعال" : "اشتراک غیرفعال"}</b><p>مصرف ${(u.used_bytes / 1e9).toFixed(3)} از ${u.quota_bytes / 1e9} گیگابایت</p><progress value="${Number(u.used_bytes)}" max="${Number(u.quota_bytes)}"></progress><p>پایان اعتبار: ${new Date(u.expires_at).toLocaleDateString("fa-IR", { timeZone: "UTC" })}</p>${valid ? '<a href="?raw=1">دریافت کانفیگ کلاینت</a>' : ""}</main></html>`,
        {
          headers: {
            ...h,
            "Content-Type": "text/html;charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none';style-src 'unsafe-inline';frame-ancestors 'none'",
          },
        },
      );
    if (!valid) return errorResponse("INACTIVE", 403);
    const params = new URLSearchParams({
      encryption: "none",
      security: "tls",
      sni: url.hostname,
      type: "ws",
      host: url.hostname,
      path: "/stream",
    });
    const config = `vless://${u.id}@${url.hostname}:443?${params}#ZERYNX-${name}`;
    return new Response(btoa(config), {
      headers: {
        ...h,
        "Content-Type": "text/plain;charset=utf-8",
        "Subscription-Userinfo": `upload=0; download=${u.used_bytes}; total=${u.quota_bytes}; expire=${Math.floor(Date.parse(u.expires_at) / 1000)}`,
      },
    });
  }
  if (p === "/api/users" && req.method === "GET")
    return response({
      users: (
        await DB.prepare(
          "SELECT id,username,used_bytes,quota_bytes,expires_at,status FROM users ORDER BY created_at DESC,rowid DESC",
        ).all()
      ).results,
    });
  if (p === "/api/users" && req.method === "POST") {
    const { username, gb, days } = await readJSON(req);
    if (
      typeof username !== "string" ||
      !/^[a-zA-Z0-9_-]{3,32}$/.test(username) ||
      !Number.isFinite(gb) ||
      gb < 0.001 ||
      gb > 10000 ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 3650
    )
      return errorResponse("INVALID_INPUT");
    const id = crypto.randomUUID(),
      t = randomToken(),
      end = new Date(Date.now() + days * 86400000).toISOString();
    try {
      await DB.batch([
        DB.prepare(
          "INSERT INTO users(id,username,quota_bytes,expires_at) VALUES(?,?,?,?)",
        ).bind(id, username, Math.round(gb * 1e9), end),
        DB.prepare(
          "INSERT INTO subscriptions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)",
        ).bind(crypto.randomUUID(), id, await sha256(t), end),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE")) return errorResponse("DUPLICATE", 409);
      throw e;
    }
    await log("SUBSCRIPTION_CREATED", id);
    return response({ link: link(t) }, 201);
  }
  const m = p.match(/^\/api\/users\/([a-f0-9-]{36})\/(rotate|toggle)$/);
  if (m && req.method === "POST") {
    const t = randomToken();
    const r =
      m[2] === "rotate"
        ? await DB.prepare(
            "UPDATE subscriptions SET token_hash=? WHERE user_id=?",
          )
            .bind(await sha256(t), m[1])
            .run()
        : await DB.prepare(
            "UPDATE users SET status=CASE WHEN status='active' THEN 'disabled' ELSE 'active' END WHERE id=?",
          )
            .bind(m[1])
            .run();
    if (!r.meta.changes) return errorResponse("NOT_FOUND", 404);
    await log(m[2] === "rotate" ? "SUBSCRIPTION_LINK_ROTATED" : "USER_STATUS_CHANGED", m[1]);
    return response(m[2] === "rotate" ? { link: link(t) } : { ok: true });
  }
  return errorResponse("NOT_FOUND", 404);
}
