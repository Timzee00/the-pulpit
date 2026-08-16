const API_BIBLE_BASE = "https://api.scripture.api.bible/v1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const LANGUAGE_CODES = { yo: "yor", ha: "hau", ig: "ibo" };
const languageCache = new Map();
const bibleCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 9000;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

function isSafeId(value) {
  return /^[A-Za-z0-9._-]{1,120}$/.test(String(value || ""));
}

function normalizeReference(value) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
}

const cors = () => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
});

const respond = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", ...cors() },
  body: JSON.stringify(body),
});

async function apiFetch(path) {
  const key = process.env.BIBLE_API_KEY;
  if (!key) throw new Error("BIBLE_API_KEY is not configured.");
  const { controller, done } = withTimeout(REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_BIBLE_BASE}${path}`, {
      headers: { "api-key": key, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Bible service timed out. Please try again.");
    throw err;
  } finally {
    done();
  }
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(data?.message || `API.Bible returned HTTP ${res.status}`);
  }
  return data;
}

async function getLanguages() {
  const result = {};
  const entries = Object.entries(LANGUAGE_CODES);
  const settled = await Promise.allSettled(entries.map(async ([lang, iso3]) => {
    const cached = languageCache.get(lang);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return [lang, cached.value];
    const data = await apiFetch(`/bibles?language=${iso3}`);
    const bibles = Array.isArray(data?.data) ? data.data : [];
    const normalized = bibles.map(b => ({
      id: b.id,
      name: b.name,
      nameLocal: b.nameLocal,
      abbreviation: b.abbreviation,
      copyrightStatement: b.copyrightStatement || "",
      language: b.language || { id: iso3 },
    }));
    languageCache.set(lang, { value: normalized, at: Date.now() });
    return [lang, normalized];
  }));
  for (const item of settled) {
    if (item.status === "fulfilled") result[item.value[0]] = item.value[1];
    else console.error("[bible] language catalog error:", item.reason?.message || item.reason);
  }
  return result;
}

async function getPassage(bibleId, reference) {
  if (!isSafeId(bibleId)) throw new Error("Invalid Bible edition.");
  reference = normalizeReference(reference);
  if (!reference) throw new Error("Bible reference is required.");

  // API.Bible's search endpoint understands references such as John 3:16
  // and ranges. We use it as the primary resolver so book-name spelling
  // differences between editions don't break the UI.
  const data = await apiFetch(
    `/bibles/${encodeURIComponent(bibleId)}/search?query=${encodeURIComponent(reference)}&limit=20`
  );

  const results = data?.data?.passages || [];
  if (!results.length) throw new Error("Passage not found — check the reference.");

  const first = results[0];
  return {
    reference: first.reference || reference,
    text: String(first.content || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return respond(204, {});
  if (event.httpMethod !== "GET") return respond(405, { error: "Method not allowed." });

  try {
    const params = event.queryStringParameters || {};
    const action = params.action || "bibles";

    if (action === "bibles") {
      return respond(200, { languages: await getLanguages() });
    }

    if (action === "passage") {
      const bibleId = params.bibleId || "";
      const reference = params.reference || "";
      const passage = await getPassage(bibleId, reference);

      // Return metadata as well so the frontend can show the required
      // copyright/version attribution alongside the Scripture.
      let bible = bibleCache.get(bibleId);
      if (!bible) {
        try {
          const data = await apiFetch(`/bibles/${encodeURIComponent(bibleId)}`);
          bible = data?.data || {};
          if (bible?.id) bibleCache.set(bibleId, bible);
        } catch { bible = {}; }
      }
      return respond(200, { passage, bible });
    }

    return respond(400, { error: "Unknown action." });
  } catch (err) {
    console.error("[bible] error:", err.message);
    return respond(502, { error: err.message || "Bible service unavailable." });
  }
};
