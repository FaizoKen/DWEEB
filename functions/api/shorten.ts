// Cloudflare Pages Function — create a temporary short link for a share token.
//
// DWEEB's default share link keeps the whole message in the URL hash (`#s=…`),
// so it never leaves the browser. A *short* link is the opt-in exception: the
// browser POSTs the compressed share token here, we store it in Cloudflare KV
// under a random id with a 7-day TTL, and return the id. The short URL
// (`/s/<id>`) is then resolved back by `GET /api/s/<id>` when someone opens it.
//
// Because this is the one path where message contents reach our server, the
// feature is opt-in in the UI and the stored value auto-expires.
//
// Setup: bind a KV namespace named `SHORT_LINKS` to the Pages project
// (Cloudflare dashboard → the project → Settings → Functions → KV namespace
// bindings, or `wrangler.toml` for Wrangler deploys). Without the binding this
// endpoint returns 503 and the UI falls back to the hash link.
//
// Abuse guard: the value must look like a DWEEB share token (`<version>.<lz>`)
// and stay under a size cap, so the endpoint can't be used as a general blob
// store. KV's free-tier daily write cap is itself a natural ceiling.

// 7 days. KV requires expirationTtl >= 60.
const TTL_SECONDS = 7 * 24 * 60 * 60;

// A generous cap — even a maxed-out message compresses well under this. Keeps a
// single value small and blocks oversized payloads.
const MAX_TOKEN_LEN = 30_000;

// `<digits>.<lz-string url-safe body>`. lz-string's URL-safe alphabet is
// [A-Za-z0-9] plus `+ - $`; the prefix is the numeric schema version.
const TOKEN_RE = /^[0-9]+\.[A-Za-z0-9+\-$]+$/;

// base62 — URL-clean, no escaping needed in `/s/<id>`.
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ID_LEN = 8;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Unbiased random id via rejection sampling (256 % 62 != 0, so reject the tail).
function newShortId() {
  const max = 256 - (256 % ID_ALPHABET.length);
  let id = "";
  while (id.length < ID_LEN) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LEN));
    for (let i = 0; i < bytes.length && id.length < ID_LEN; i++) {
      const b = bytes[i];
      if (b < max) id += ID_ALPHABET[b % ID_ALPHABET.length];
    }
  }
  return id;
}

export async function onRequestPost(context) {
  const kv = context.env.SHORT_LINKS;
  if (!kv) {
    return json({ error: "Short links are not configured on this deployment." }, 503);
  }

  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

  const token = payload?.token;
  if (typeof token !== "string" || token.length === 0) {
    return json({ error: "Missing share token." }, 400);
  }
  if (token.length > MAX_TOKEN_LEN) {
    return json({ error: "Message is too large to shorten." }, 413);
  }
  if (!TOKEN_RE.test(token)) {
    return json({ error: "That doesn't look like a share token." }, 400);
  }

  // Pick an id that isn't already taken. Collisions are astronomically unlikely
  // at 62^8, so a couple of checked attempts is plenty.
  let id = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = newShortId();
    if ((await kv.get(candidate)) === null) {
      id = candidate;
      break;
    }
  }
  if (!id) {
    return json({ error: "Couldn't allocate a short link, please retry." }, 503);
  }

  try {
    await kv.put(id, token, { expirationTtl: TTL_SECONDS });
  } catch {
    return json({ error: "Couldn't store the short link." }, 502);
  }

  return json({ id }, 201);
}
