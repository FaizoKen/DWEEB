// Cloudflare Pages Function — same-origin proxy for AI provider calls.
//
// The static site ships a strict Content-Security-Policy whose `connect-src`
// only allows our own origin (plus Discord + analytics). Calling an AI
// provider straight from the browser therefore gets blocked by CSP, and even
// without CSP many providers refuse cross-origin browser requests.
//
// The browser instead POSTs the intended provider request here; we forward it
// server-side and stream the response back. The page never leaves its own
// origin (so `connect-src 'self'` is satisfied) and there is no CORS to fight.
//
// The user's API key passes through this function, but the function runs on
// the very same deployment the user is already trusting — it is never sent to
// any third party beyond the provider the user chose.
//
// SSRF guard: https only, and refuse loopback / link-local / private hosts so
// the proxy can't be turned into a relay for probing internal addresses.

const BLOCKED_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fe80:|\[?fc00:|\[?fd)/i;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost(context) {
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

  const { targetUrl, method, headers, body } = payload ?? {};
  if (typeof targetUrl !== "string") return json({ error: "Missing targetUrl." }, 400);

  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    return json({ error: "Invalid targetUrl." }, 400);
  }
  if (url.protocol !== "https:") {
    return json({ error: "Only https targets are allowed." }, 403);
  }
  if (BLOCKED_HOST_RE.test(url.hostname)) {
    return json({ error: "Target host is not allowed." }, 403);
  }

  const fwdHeaders = {};
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") fwdHeaders[key] = value;
    }
  }

  let res;
  try {
    res = await fetch(url.toString(), {
      method: typeof method === "string" ? method : "POST",
      headers: fwdHeaders,
      body: typeof body === "string" ? body : undefined,
    });
  } catch {
    return json({ error: "The provider request failed upstream." }, 502);
  }

  // Stream the upstream body straight back rather than buffering it with
  // `res.text()`. For non-streaming calls this is just a pass-through; for
  // streaming calls (Server-Sent Events) it lets tokens reach the browser as
  // the provider emits them. We preserve the upstream content-type so the
  // client can tell an SSE stream (`text/event-stream`) from a JSON error.
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}
