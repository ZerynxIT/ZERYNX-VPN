// ======================================================
// ZERYNX VPN - CLOUDFLARE WORKER API
// Version: 1.4.0
// ======================================================

import { subscriberAPI } from "./subscriptions.js";
import { transport } from "./transport.js";
const VERSION = "2.0.0";

const SESSION_DURATION = 30 * 60 * 1000;
const PASSWORD_ITERATIONS = 100000;

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

// ======================================================
// RESPONSE
// ======================================================

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...HEADERS,
      ...headers,
    },
  });
}

function errorResponse(error, status = 400) {
  return response(
    {
      ok: false,
      error,
    },
    status,
  );
}

// ======================================================
// CORS
// ======================================================

function getOrigin(request, env) {
  const origin = request.headers.get("Origin");

  if (!origin) return null;

  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(result, origin) {
  if (!origin) return result;

  const headers = new Headers(result.headers);

  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }

  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  });
}

// ======================================================
// SECURITY
// ======================================================

function unauthorized() {
  return errorResponse("UNAUTHORIZED", 401);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function secureCompare(first, second) {
  const encoder = new TextEncoder();

  const a = encoder.encode(first);
  const b = encoder.encode(second);

  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a[i] ^ b[i];
  }

  return difference === 0;
}

// ======================================================
// PASSWORD HASHING
// ======================================================

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: PASSWORD_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    256,
  );

  const hash = Array.from(new Uint8Array(bits))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
  try {
    if (typeof stored !== "string") return false;

    const parts = stored.split("$");

    if (parts.length !== 4 || parts[0] !== "pbkdf2") {
      return false;
    }

    const iterations = Number(parts[1]);

    if (
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > PASSWORD_ITERATIONS
    ) {
      return false;
    }

    if (!/^[a-f0-9]{32}$/.test(parts[2])) {
      return false;
    }

    if (!/^[a-f0-9]{64}$/.test(parts[3])) {
      return false;
    }

    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: encoder.encode(parts[2]),
        iterations,
        hash: "SHA-256",
      },
      key,
      256,
    );

    const calculated = Array.from(new Uint8Array(bits))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return secureCompare(calculated, parts[3]);
  } catch (error) {
    console.error("Password verification error:", error?.message);
    return false;
  }
}

// ======================================================
// COOKIE
// ======================================================

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";

  const item = cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));

  return item ? item.substring(name.length + 1) : null;
}

function sessionCookie(token, maxAge) {
  return [
    `zerynx_session=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Path=/",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

// ======================================================
// REQUEST VALIDATION
// ======================================================

async function readJSON(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("INVALID_CONTENT_TYPE");
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 10000) {
    throw new Error("REQUEST_TOO_LARGE");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 10000) {
    throw new Error("REQUEST_TOO_LARGE");
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("INVALID_JSON");
  }
  return data;
}

// ======================================================
// DATABASE
// ======================================================

async function setupStatus(env) {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM admin_users",
  ).first();

  return {
    installed: Number(result?.total || 0) > 0,
  };
}

// ======================================================
// AUTHENTICATION
// ======================================================

async function authenticate(request, env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return null;
  }

  const tokenHash = await sha256(token);

  const admin = await env.DB.prepare(
    `
        SELECT
            a.id,
            a.username,
            a.role,
            a.status,
            s.id AS session_id,
            s.expires_at
        FROM admin_sessions s
        JOIN admin_users a ON a.id = s.admin_id
        WHERE s.session_hash = ?
        LIMIT 1
    `,
  )
    .bind(tokenHash)
    .first();

  if (!admin || admin.status !== "active") {
    return null;
  }

  if (Date.parse(admin.expires_at) <= Date.now()) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE id = ?")
      .bind(admin.session_id)
      .run();

    return null;
  }

  return admin;
}

// ======================================================
// OWNER SETUP
// ======================================================

async function createOwner(request, env) {
  const configuredKey = env.BOOTSTRAP_SECRET;

  if (typeof configuredKey !== "string" || configuredKey.length === 0) {
    return errorResponse("BOOTSTRAP_NOT_CONFIGURED", 503);
  }

  const data = await readJSON(request);

  const providedKey =
    typeof data.setupKey === "string" ? data.setupKey.trim() : "";

  if (!providedKey || !secureCompare(providedKey, configuredKey.trim())) {
    return unauthorized();
  }

  const username = String(data.username || "").trim();
  const password = String(data.password || "");

  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return errorResponse("INVALID_USERNAME", 400);
  }

  if (password.length < 12 || password.length > 128) {
    return errorResponse("PASSWORD_MUST_BE_12_TO_128_CHARACTERS", 400);
  }

  const id = crypto.randomUUID();
  const salt = randomToken().substring(0, 32);
  const passwordHash = await hashPassword(password, salt);

  // Atomic first-owner creation: concurrent setup requests cannot create
  // multiple owner accounts between a separate COUNT and INSERT.
  const created = await env.DB.prepare(
    `
      INSERT INTO admin_users (id, username, password_hash, role, status)
      SELECT ?, ?, ?, 'owner', 'active'
      WHERE NOT EXISTS (SELECT 1 FROM admin_users)
    `,
  ).bind(id, username, passwordHash).run();

  if (created.meta.changes !== 1) {
    return errorResponse("ALREADY_INSTALLED", 409);
  }

  try {
    await env.DB.prepare(
      `
            INSERT INTO activity_logs (
                id,
                actor_type,
                actor_id,
                action,
                target_type,
                target_id
            )
            VALUES (?, 'system', NULL, 'OWNER_CREATED', 'admin', ?)
        `,
    )
      .bind(crypto.randomUUID(), id)
      .run();
  } catch (error) {
    console.error("Owner activity log failed:", error?.message);
  }

  return response(
    {
      ok: true,
      message: "Owner account created successfully.",
    },
    201,
  );
}

// ======================================================
// API ROUTER
// ======================================================

async function handleAPI(request, env) {
  const url = new URL(request.url);

  const path = url.pathname;
  const method = request.method;

  if (!env.DB) {
    return errorResponse("DATABASE_NOT_CONFIGURED", 503);
  }

  // HEALTH

  if (method === "GET" && path === "/api/health") {
    await env.DB.prepare("SELECT 1").first();

    return response({
      ok: true,
      service: "ZERYNX VPN API",
      version: VERSION,
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  }

  // SETUP STATUS

  if (method === "GET" && path === "/api/setup/status") {
    return response({
      ok: true,
      ...(await setupStatus(env)),
    });
  }

  // INITIAL OWNER SETUP

  if (method === "POST" && path === "/api/setup") {
    return await createOwner(request, env);
  }

  // LOGIN

  if (method === "POST" && path === "/api/auth/login") {
    const data = await readJSON(request);

    const username = String(data.username || "").trim();
    const password = String(data.password || "");

    if (
      username.length > 32 ||
      password.length > 128 ||
      !username ||
      !password
    ) {
      return unauthorized();
    }

    const admin = await env.DB.prepare(
      `
            SELECT
                id,
                username,
                password_hash,
                role,
                status
            FROM admin_users
            WHERE username = ?
            LIMIT 1
        `,
    )
      .bind(username)
      .first();

    if (
      !admin ||
      admin.status !== "active" ||
      !(await verifyPassword(password, admin.password_hash))
    ) {
      return unauthorized();
    }

    const token = randomToken();
    const tokenHash = await sha256(token);

    const expiresAt = new Date(Date.now() + SESSION_DURATION).toISOString();

    await env.DB.prepare(
      `
            INSERT INTO admin_sessions (
                id,
                admin_id,
                session_hash,
                expires_at
            )
            VALUES (?, ?, ?, ?)
        `,
    )
      .bind(crypto.randomUUID(), admin.id, tokenHash, expiresAt)
      .run();

    await env.DB.prepare(
      `
            UPDATE admin_users
            SET last_login_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `,
    )
      .bind(new Date().toISOString(), admin.id)
      .run();

    return response({
      ok: true,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
      },
      token,
    });
  }

  // LOGOUT

  if (method === "POST" && path === "/api/auth/logout") {
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");

    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const tokenHash = await sha256(token);

      await env.DB.prepare("DELETE FROM admin_sessions WHERE session_hash = ?")
        .bind(tokenHash)
        .run();
    }

    return response(
      {
        ok: true,
        message: "Logged out.",
      },
      200,
      {
        "Set-Cookie": sessionCookie("", 0),
      },
    );
  }

  // CURRENT ADMIN

  if (method === "GET" && path === "/api/auth/me") {
    const admin = await authenticate(request, env);

    if (!admin) return unauthorized();

    return response({
      ok: true,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
      },
    });
  }

  if (path === "/api/credentials" && method === "POST") {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== "owner") return unauthorized();
    const { current, username, password } = await readJSON(request);
    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 128 ||
      typeof username !== "string" ||
      !/^[a-zA-Z0-9_-]{3,32}$/.test(username)
    )
      return errorResponse("INVALID_INPUT");
    const old = await env.DB.prepare(
      "SELECT password_hash FROM admin_users WHERE id=?",
    )
      .bind(admin.id)
      .first();
    if (
      typeof current !== "string" ||
      !(await verifyPassword(current, old.password_hash))
    )
      return unauthorized();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE admin_users SET username=?,password_hash=? WHERE id=?",
      ).bind(
        username,
        await hashPassword(password, randomToken().slice(0, 32)),
        admin.id,
      ),
      env.DB.prepare("DELETE FROM admin_sessions WHERE admin_id=?").bind(
        admin.id,
      ),
    ]);
    return response({ ok: true });
  }
  if (method === "GET" && path === "/api/activity") {
    const admin = await authenticate(request, env);
    if (!admin || admin.role !== "owner") return unauthorized();
    const result = await env.DB.prepare(
      "SELECT id, action, target_type, target_id, created_at FROM activity_logs ORDER BY created_at DESC, rowid DESC LIMIT 50",
    ).all();
    return response({ items: result.results || [] });
  }

  if (path.startsWith("/s/") || path.startsWith("/api/users")) {
    if (!path.startsWith("/s/")) {
      const admin = await authenticate(request, env);
      if (!admin || admin.role !== "owner") return unauthorized();
    }
    return subscriberAPI(request, env, {
      sha256,
      randomToken,
      readJSON,
      response,
      errorResponse,
    });
  }
  // NOT FOUND

  return errorResponse("NOT_FOUND", 404);
}

// ======================================================
// MAIN WORKER
// ======================================================

export default {
  async fetch(request, env) {
    const requestPath = new URL(request.url).pathname;
    const origin = getOrigin(request, env);

    if (requestPath === "/stream") {
      if (request.headers.get("Origin") && !origin) {
        return new Response("ORIGIN_NOT_ALLOWED", { status: 403 });
      }
      return transport(request, env);
    }

    // PREFLIGHT

    if (request.method === "OPTIONS") {
      if (!origin) {
        return new Response(null, {
          status: 403,
        });
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // ORIGIN VALIDATION

    if (request.headers.get("Origin") && !origin) {
      return response(
        {
          ok: false,
          error: "ORIGIN_NOT_ALLOWED",
        },
        403,
      );
    }

    try {
      const result = await handleAPI(request, env);

      return withCors(result, origin);
    } catch (error) {
      console.error(
        "ZERYNX API Error:",
        error?.stack || error?.message || error,
      );

      let message = "INTERNAL_SERVER_ERROR";
      let status = 500;

      if (error?.message === "INVALID_CONTENT_TYPE") {
        message = "INVALID_CONTENT_TYPE";
        status = 415;
      }

      if (error?.message === "INVALID_JSON") {
        message = "INVALID_JSON";
        status = 400;
      }

      if (error?.message === "REQUEST_TOO_LARGE") {
        message = "REQUEST_TOO_LARGE";
        status = 413;
      }

      return withCors(errorResponse(message, status), origin);
    }
  },
};
