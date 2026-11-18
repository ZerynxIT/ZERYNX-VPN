/**
 * ZERYNX VPN
 * Cloudflare Worker API
 * Version: 1.0.0
 */

const DEFAULT_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
};

function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...DEFAULT_HEADERS,
            ...headers
        }
    });
}

function getAllowedOrigin(request, env) {
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
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin"
    };
}

function unauthorized() {
    return json({
        ok: false,
        error: "UNAUTHORIZED",
        message: "Authentication required."
    }, 401);
}

async function health(env) {
    let database = "not_configured";

    if (env.DB) {
        try {
            await env.DB.prepare("SELECT 1").first();
            database = "connected";
        } catch {
            database = "error";
        }
    }

    return {
        ok: true,
        service: "ZERYNX VPN API",
        version: "1.0.0",
        database,
        timestamp: new Date().toISOString()
    };
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && path === "/api/health") {
        return json(await health(env));
    }

    if (method === "GET" && path === "/api") {
        return json({
            ok: true,
            name: "ZERYNX VPN",
            message: "API is running.",
            endpoints: [
                "GET /api/health",
                "GET /api"
            ]
        });
    }

    return json({
        ok: false,
        error: "NOT_FOUND",
        message: "The requested endpoint does not exist."
    }, 404);
}

export default {
    async fetch(request, env) {
        const origin = getAllowedOrigin(request, env);

        if (request.method === "OPTIONS") {
            if (!origin) {
                return new Response(null, { status: 403 });
            }

            return new Response(null, {
                status: 204,
                headers: corsHeaders(origin)
            });
        }

        if (request.headers.get("Origin") && !origin) {
            return json({
                ok: false,
                error: "ORIGIN_NOT_ALLOWED"
            }, 403);
        }

        try {
            const response = await handleRequest(request, env);

            if (!origin) return response;

            const headers = new Headers(response.headers);

            Object.entries(corsHeaders(origin)).forEach(([key, value]) => {
                headers.set(key, value);
            });

            return new Response(response.body, {
                status: response.status,
                headers
            });

        } catch (error) {
            console.error("ZERYNX API Error:", error);

            return json({
                ok: false,
                error: "INTERNAL_SERVER_ERROR",
                message: "An unexpected server error occurred."
            }, 500);
        }
    }
};
