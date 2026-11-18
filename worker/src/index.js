// ZERYNX VPN - Deployment verification
const VERSION = "1.1.0";
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 210000;

const HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
};

function response(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...HEADERS,
            ...headers
        }
    });
}

function getOrigin(request, env) {
    const origin = request.headers.get("Origin");

    if (!origin) return null;

    const allowed = (env.ALLOWED_ORIGINS || "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);

    return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin"
    };
}

function unauthorized() {
    return response({
        ok: false,
        error: "UNAUTHORIZED"
    }, 401);
}

function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));

    return Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function sha256(value) {
    const encoded = new TextEncoder().encode(value);

    const digest = await crypto.subtle.digest(
        "SHA-256",
        encoded
    );

    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function hashPassword(password, salt) {
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        "PBKDF2",
        false,
        ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits({
        name: "PBKDF2",
        salt: encoder.encode(salt),
        iterations: PASSWORD_ITERATIONS,
        hash: "SHA-256"
    }, key, 256);

    const hash = Array.from(new Uint8Array(bits))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");

    return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
    try {
        const parts = stored.split("$");

        if (parts.length !== 4 || parts[0] !== "pbkdf2") {
            return false;
        }

        const iterations = Number(parts[1]);

        if (
            !Number.isInteger(iterations) ||
            iterations < 100000 ||
            iterations > 500000
        ) {
            return false;
        }

        const encoder = new TextEncoder();

        const key = await crypto.subtle.importKey(
            "raw",
            encoder.encode(password),
            "PBKDF2",
            false,
            ["deriveBits"]
        );

        const bits = await crypto.subtle.deriveBits({
            name: "PBKDF2",
            salt: encoder.encode(parts[2]),
            iterations,
            hash: "SHA-256"
        }, key, 256);

        const calculated = Array.from(new Uint8Array(bits))
            .map(byte => byte.toString(16).padStart(2, "0"))
            .join("");

        return calculated === parts[3];
    } catch {
        return false;
    }
}

function getCookie(request, name) {
    const cookie = request.headers.get("Cookie") || "";

    const item = cookie
        .split(";")
        .map(value => value.trim())
        .find(value => value.startsWith(`${name}=`));

    return item ? item.substring(name.length + 1) : null;
}

function sessionCookie(token, maxAge) {
    return [
        `zerynx_session=${token}`,
        "HttpOnly",
        "Secure",
        "SameSite=None",
        "Path=/",
        `Max-Age=${maxAge}`
    ].join("; ");
}

async function readJSON(request) {
    const contentType = request.headers.get("Content-Type") || "";

    if (!contentType.includes("application/json")) {
        throw new Error("INVALID_CONTENT_TYPE");
    }

    const length = Number(request.headers.get("Content-Length") || 0);

    if (length > 10000) {
        throw new Error("REQUEST_TOO_LARGE");
    }

    return await request.json();
}

async function setupStatus(env) {
    const result = await env.DB
        .prepare("SELECT COUNT(*) AS total FROM admin_users")
        .first();

    return {
        installed: Number(result.total) > 0
    };
}

async function authenticate(request, env) {
    const token = getCookie(request, "zerynx_session");

    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        return null;
    }

    const tokenHash = await sha256(token);

    const admin = await env.DB.prepare(`
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
    `).bind(tokenHash).first();

    if (!admin || admin.status !== "active") {
        return null;
    }

    if (Date.parse(admin.expires_at) <= Date.now()) {
        await env.DB.prepare(
            "DELETE FROM admin_sessions WHERE id = ?"
        ).bind(admin.session_id).run();

        return null;
    }

    return admin;
}

async function handleAPI(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (!env.DB) {
        return response({
            ok: false,
            error: "DATABASE_NOT_CONFIGURED"
        }, 503);
    }

    if (method === "GET" && path === "/api/health") {
        await env.DB.prepare("SELECT 1").first();

        return response({
            ok: true,
            service: "ZERYNX VPN API",
            version: VERSION,
            database: "connected",
            timestamp: new Date().toISOString()
        });
    }

    if (method === "GET" && path === "/api/setup/status") {
        return response({
            ok: true,
            ...(await setupStatus(env))
        });
    }

    if (method === "POST" && path === "/api/setup") {
        if (!env.BOOTSTRAP_SECRET) {
            return response({
                ok: false,
                error: "BOOTSTRAP_NOT_CONFIGURED"
            }, 503);
        }

        const data = await readJSON(request);

        if (
            typeof data.setupKey !== "string" ||
            data.setupKey !== env.BOOTSTRAP_SECRET
        ) {
            return unauthorized();
        }

        const username = String(data.username || "").trim();
        const password = String(data.password || "");

        if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
            return response({
                ok: false,
                error: "INVALID_USERNAME"
            }, 400);
        }

        if (password.length < 12 || password.length > 128) {
            return response({
                ok: false,
                error: "PASSWORD_MUST_BE_12_TO_128_CHARACTERS"
            }, 400);
        }

        const result = await env.DB.prepare(
            "SELECT COUNT(*) AS total FROM admin_users"
        ).first();

        if (Number(result.total) > 0) {
            return response({
                ok: false,
                error: "ALREADY_INSTALLED"
            }, 409);
        }

        const id = crypto.randomUUID();
        const salt = randomToken().substring(0, 32);
        const passwordHash = await hashPassword(password, salt);

        await env.DB.prepare(`
            INSERT INTO admin_users (
                id,
                username,
                password_hash,
                role,
                status
            )
            VALUES (?, ?, ?, 'owner', 'active')
        `).bind(
            id,
            username,
            passwordHash
        ).run();

        await env.DB.prepare(`
            INSERT INTO activity_logs (
                id,
                actor_type,
                actor_id,
                action,
                target_type,
                target_id
            )
            VALUES (?, 'system', NULL, 'OWNER_CREATED', 'admin', ?)
        `).bind(
            crypto.randomUUID(),
            id
        ).run();

        return response({
            ok: true,
            message: "Owner account created successfully."
        }, 201);
    }

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

        const admin = await env.DB.prepare(`
            SELECT id, username, password_hash, role, status
            FROM admin_users
            WHERE username = ?
            LIMIT 1
        `).bind(username).first();

        if (
            !admin ||
            admin.status !== "active" ||
            !(await verifyPassword(password, admin.password_hash))
        ) {
            return unauthorized();
        }

        const token = randomToken();
        const tokenHash = await sha256(token);
        const expiresAt = new Date(
            Date.now() + SESSION_DURATION
        ).toISOString();

        await env.DB.prepare(`
            INSERT INTO admin_sessions (
                id,
                admin_id,
                session_hash,
                expires_at
            )
            VALUES (?, ?, ?, ?)
        `).bind(
            crypto.randomUUID(),
            admin.id,
            tokenHash,
            expiresAt
        ).run();

        await env.DB.prepare(`
            UPDATE admin_users
            SET last_login_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).bind(
            new Date().toISOString(),
            admin.id
        ).run();

        return response({
            ok: true,
            admin: {
                id: admin.id,
                username: admin.username,
                role: admin.role
            }
        }, 200, {
            "Set-Cookie": sessionCookie(
                token,
                SESSION_DURATION / 1000
            )
        });
    }

    if (method === "POST" && path === "/api/auth/logout") {
        const token = getCookie(request, "zerynx_session");

        if (token && /^[a-f0-9]{64}$/.test(token)) {
            const tokenHash = await sha256(token);

            await env.DB.prepare(
                "DELETE FROM admin_sessions WHERE session_hash = ?"
            ).bind(tokenHash).run();
        }

        return response({
            ok: true,
            message: "Logged out."
        }, 200, {
            "Set-Cookie": sessionCookie("", 0)
        });
    }

    if (method === "GET" && path === "/api/auth/me") {
        const admin = await authenticate(request, env);

        if (!admin) return unauthorized();

        return response({
            ok: true,
            admin: {
                id: admin.id,
                username: admin.username,
                role: admin.role
            }
        });
    }

    return response({
        ok: false,
        error: "NOT_FOUND"
    }, 404);
}

export default {
    async fetch(request, env) {
        const origin = getOrigin(request, env);

        if (request.method === "OPTIONS") {
            if (!origin) {
                return new Response(null, {
                    status: 403
                });
            }

            return new Response(null, {
                status: 204,
                headers: corsHeaders(origin)
            });
        }

        if (
            request.headers.get("Origin") &&
            !origin
        ) {
            return response({
                ok: false,
                error: "ORIGIN_NOT_ALLOWED"
            }, 403);
        }

        try {
            const result = await handleAPI(request, env);

            if (!origin) return result;

            const headers = new Headers(result.headers);

            Object.entries(corsHeaders(origin)).forEach(
                ([key, value]) => headers.set(key, value)
            );

            return new Response(result.body, {
                status: result.status,
                headers
            });
        } catch (error) {
            console.error("ZERYNX API Error:", error);

            return response({
                ok: false,
                error: "INTERNAL_SERVER_ERROR"
            }, 500);
        }
    }
};
