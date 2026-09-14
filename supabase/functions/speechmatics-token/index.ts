import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * speechmatics-token — mints a short-lived Speechmatics RT JWT for the browser
 * client. The SPEECHMATICS_API_KEY secret lives in Supabase Secret Manager and
 * NEVER leaves this function (the browser only ever receives a 60-second token).
 *
 * Local mirror of the deployed Edge Function (deployed via the Supabase MCP).
 * Docs: https://docs.speechmatics.com/rt-api-ref/authentication#temporary-tokens
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SPEECHMATICS_API_KEY = Deno.env.get("SPEECHMATICS_API_KEY");
const RT_TOKEN_TTL_SECONDS = 60; // 60-3600 allowed; keep short — mint fresh per session

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Accepts the caller this function is called with:
//  - legacy Supabase access/anon JWTs: three dot-separated base64url parts
//  - modern publishable keys: `sb_publishable_…`
// Before this change the gate ONLY accepted legacy JWTs, so any client
// configured with a modern publishable key got a 401 on every call and voice
// never started ("Speech recognition is temporarily unavailable") even though
// microphone permission worked. The platform gateway still enforces real
// auth/billing; this gate only stops arbitrary internet callers.
function looksLikeSupabaseCredential(value: string | null): boolean {
  if (!value) return false;
  if (value.startsWith("sb_publishable_")) return true;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  if (parts.some((p) => p.length === 0)) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function authOk(req: Request): boolean {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (looksLikeSupabaseCredential(token)) return true;
  }
  const apikey = req.headers.get("apikey");
  return looksLikeSupabaseCredential(apikey?.trim() ?? null);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  if (!authOk(req)) {
    return json({ error: "Unauthorized: missing or invalid bearer token" }, 401);
  }

  if (!SPEECHMATICS_API_KEY) {
    return json({ error: "Server misconfigured: SPEECHMATICS_API_KEY not set" }, 500);
  }

  try {
    const res = await fetch("https://mp.speechmatics.com/v1/api_keys?type=rt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SPEECHMATICS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: RT_TOKEN_TTL_SECONDS }),
    });

    const raw = await res.text();

    if (!res.ok) {
      return json({ error: `Speechmatics token mint failed (${res.status})`, detail: raw.slice(0, 300) }, 502);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ error: "Speechmatics returned non-JSON body", detail: raw.slice(0, 300) }, 502);
    }

    // v1 API returns the temporary JWT under `key_value`.
    const token = (data.key_value as string | undefined) ?? (data.key as string | undefined) ?? (data.token as string | undefined);
    if (!token) {
      return json({ error: "Speechmatics response did not contain a token", detail: raw.slice(0, 300) }, 502);
    }

    return json({ token });
  } catch (err) {
    return json({ error: "Unexpected error minting token", detail: String(err) }, 502);
  }
});