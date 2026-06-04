// Cloudflare Pages Function — resolve a short link back to its share token.
//
// Counterpart to `POST /api/shorten`. The public short URL is `/s/<id>` (served
// by the SPA shell via `_redirects`); the SPA reads the id from the path and
// calls this endpoint to fetch the stored token, then decodes it like any other
// share link. Returns 404 once the KV entry has expired (7-day TTL) or never
// existed. See `functions/api/shorten.ts` for the required `SHORT_LINKS` binding.

const ID_RE = /^[0-9A-Za-z]{4,16}$/;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestGet(context) {
  const kv = context.env.SHORT_LINKS;
  if (!kv) {
    return json({ error: "Short links are not configured on this deployment." }, 503);
  }

  const id = context.params.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return json({ error: "Invalid short link." }, 400);
  }

  let token;
  try {
    token = await kv.get(id);
  } catch {
    return json({ error: "Couldn't read the short link." }, 502);
  }
  if (token === null) {
    return json({ error: "This short link has expired or doesn't exist." }, 404);
  }

  return json({ token }, 200);
}
