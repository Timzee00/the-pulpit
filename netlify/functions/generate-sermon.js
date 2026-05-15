// ============================================================
//  The Pulpit - Sermon Helper AI
//  Netlify Function: generate-sermon.js  |  Version 4.0 FINAL
//
//  Strategy:
//  1. openrouter/free is PRIMARY — it auto-picks the best
//     available free model at request time. No guessing.
//  2. Confirmed May 2026 free model IDs as fallbacks.
//  3. response_format REMOVED — causes errors on models that
//     don't support it. We rely on prompt engineering instead.
//  4. Retry on 429 / 5xx with backoff.
//  5. Bible verse enrichment via bible-api.com.
//  6. Full structured logging.
// ============================================================

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const BIBLE_API_BASE      = "https://bible-api.com";
const ALLOWED_ORIGIN      = process.env.ALLOWED_ORIGIN || "*";

// -----------------------------------------------------------
//  MODEL LIST — ordered by preference
//  openrouter/free = OpenRouter's smart auto-router.
//  It picks the best available free model for your request.
//  The others are direct fallbacks if the router fails.
// -----------------------------------------------------------
const MODELS = [
  "openrouter/free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "meta-llama/llama-3.2-3b-instruct:free",
];

const TIMEOUT_MS      = 50000;
const MAX_RETRIES     = 2;
const RETRY_DELAY_MS  = 2000;

// ============================================================
//  LOGGING
// ============================================================
const log = {
  info:  (msg, d = {}) => console.log(JSON.stringify({ level: "INFO",  msg, ...d, ts: Date.now() })),
  warn:  (msg, d = {}) => console.warn(JSON.stringify({ level: "WARN",  msg, ...d, ts: Date.now() })),
  error: (msg, d = {}) => console.error(JSON.stringify({ level: "ERROR", msg, ...d, ts: Date.now() })),
};

// ============================================================
//  BIBLE API — fetch real verse text to prevent hallucination
// ============================================================
async function fetchVerse(reference) {
  if (!reference) return null;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res   = await fetch(
      `${BIBLE_API_BASE}/${encodeURIComponent(reference.trim())}`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const d = await res.json();
    if (d?.text && d?.reference) {
      return { reference: d.reference, text: d.text.replace(/\n/g, " ").trim() };
    }
    return null;
  } catch { return null; }
}

async function enrichVerses(sermon) {
  try {
    const targets = [
      ...(sermon.theme_verse      ? [{ obj: sermon,           key: "theme_verse"  }] : []),
      ...(sermon.main_points || []).map(pt => ({ obj: pt,    key: "scripture"    })),
      ...(sermon.supporting_verses || []).map(v => ({ obj: v, key: "self"        })),
    ];

    await Promise.all(targets.map(async ({ obj, key }) => {
      const ref  = key === "self" ? obj.reference : obj[key]?.reference;
      const real = await fetchVerse(ref);
      if (!real) return;
      if (key === "self") {
        obj.reference = real.reference;
        obj.text      = real.text;
      } else {
        obj[key].reference = real.reference;
        obj[key].text      = real.text;
      }
    }));

    log.info("Verses enriched", { count: targets.length });
  } catch (e) {
    log.warn("Verse enrichment failed silently", { error: e.message });
  }
  return sermon;
}

// ============================================================
//  JSON PARSING — strips markdown fences, finds JSON object
// ============================================================
function parseJSON(raw) {
  if (!raw) return null;
  let text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  // find first { ... } block
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

function validate(obj) {
  if (!obj || typeof obj !== "object") return false;
  const need = ["title","theme_verse","introduction","background_context",
                "main_points","supporting_verses","conclusion",
                "altar_call","closing_prayer","preacher_notes"];
  for (const k of need) {
    if (!(k in obj)) { log.warn("Sermon missing field", { field: k }); return false; }
  }
  if (!Array.isArray(obj.main_points)       || obj.main_points.length === 0)  return false;
  if (!Array.isArray(obj.supporting_verses))                                    return false;
  if (!Array.isArray(obj.preacher_notes))                                       return false;
  return true;
}

// ============================================================
//  PROMPT — tight and clear so any model can follow it
// ============================================================
function buildPrompt(body) {
  const {
    title, tone = "Inspirational & Uplifting",
    audience = "general congregation",
    scriptureHint = "", context = "", timeMins = null,
  } = body;

  const extras = [
    scriptureHint ? `Include these scriptures: ${scriptureHint}.` : "",
    context       ? `Special context: ${context}`                 : "",
    timeMins      ? `Target length: ${timeMins} minutes.`         : "",
  ].filter(Boolean).join(" ");

  // Two-shot example tells the model exactly the format we want.
  // This is more reliable than response_format on free models.
  const system = `You are a deeply anointed pastor and sermon writer with 40 years of experience. You write humanized, heart-touching sermons rooted in Scripture — speaking to real pain, real hope, real life. You ALWAYS respond with ONLY a raw JSON object. No markdown. No backticks. No explanation text before or after. Just the JSON object starting with { and ending with }.`;

  const user = `Write a full sermon for the following request and return it as a raw JSON object.

TITLE: "${title}"
TONE: ${tone}
AUDIENCE: ${audience}
${extras}

The JSON must have exactly these fields:

{
  "title": "The sermon title",
  "theme_verse": {
    "reference": "e.g. John 3:16",
    "text": "Full verse text here"
  },
  "introduction": {
    "hook": "A gripping 2-3 sentence opening that makes the listener lean forward",
    "problem_statement": "The real human pain or question this sermon answers",
    "thesis": "The one central truth this sermon declares",
    "estimated_minutes": 5
  },
  "background_context": {
    "historical": "The biblical and historical background of this theme",
    "why_it_matters_today": "Why every person in the room needs to hear this today",
    "estimated_minutes": 3
  },
  "main_points": [
    {
      "number": 1,
      "title": "Point title",
      "scripture": { "reference": "Book Chapter:Verse", "text": "Verse text" },
      "exposition": "A deep, humanized 3-paragraph explanation. Touch the heart. Be real.",
      "illustration": "A vivid, relatable real-life story or analogy that drives the point home",
      "application": "What the listener must specifically do or believe after hearing this",
      "estimated_minutes": 7
    },
    {
      "number": 2,
      "title": "Point title",
      "scripture": { "reference": "Book Chapter:Verse", "text": "Verse text" },
      "exposition": "Deep, humanized exposition. Never generic.",
      "illustration": "A vivid relatable illustration",
      "application": "Specific practical application",
      "estimated_minutes": 7
    },
    {
      "number": 3,
      "title": "Point title",
      "scripture": { "reference": "Book Chapter:Verse", "text": "Verse text" },
      "exposition": "Deep, humanized exposition. Touch every heart.",
      "illustration": "A vivid relatable illustration",
      "application": "Specific practical application",
      "estimated_minutes": 7
    }
  ],
  "supporting_verses": [
    { "reference": "Book Chapter:Verse", "text": "Verse text", "purpose": "Why this verse reinforces the message" },
    { "reference": "Book Chapter:Verse", "text": "Verse text", "purpose": "Why this verse reinforces the message" },
    { "reference": "Book Chapter:Verse", "text": "Verse text", "purpose": "Why this verse reinforces the message" },
    { "reference": "Book Chapter:Verse", "text": "Verse text", "purpose": "Why this verse reinforces the message" }
  ],
  "conclusion": {
    "summary": "A powerful 2-3 sentence recap that locks the message into the heart",
    "call_to_action": "A direct, emotionally resonant challenge to make a decision or take action",
    "closing_illustration": "A brief, moving final story or image that seals the message forever",
    "estimated_minutes": 4
  },
  "altar_call": "A warm, personal, Spirit-filled invitation — speak directly to the person who came in broken and needs to respond today",
  "closing_prayer": "A pastoral prayer that covers, blesses, and sends the congregation out with faith",
  "preacher_notes": [
    "Delivery tip 1",
    "Delivery tip 2",
    "Delivery tip 3",
    "Delivery tip 4"
  ],
  "total_estimated_minutes": 35
}

Remember: respond with ONLY the raw JSON object. Nothing else.`;

  return [
    { role: "system", content: system },
    { role: "user",   content: user   },
  ];
}

// ============================================================
//  CALL OPENROUTER — with retry on 429 / 5xx
// ============================================================
async function callModel(modelId, messages, apiKey, attempt = 1) {
  const t0   = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer":  "https://the-pulpit.netlify.app",
        "X-Title":       "The Pulpit - Sermon Helper AI",
      },
      body: JSON.stringify({
        model:       modelId,
        max_tokens:  4000,
        temperature: 0.8,
        messages,
        // NO response_format — many free models reject it or break with it
      }),
    });

    clearTimeout(timer);

    // Retry on rate limit or temporary server error
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt <= MAX_RETRIES) {
        log.warn("Retrying", { model: modelId, status: res.status, attempt });
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        return callModel(modelId, messages, apiKey, attempt + 1);
      }
      const t = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries: ${t.slice(0, 150)}`);
    }

    if (!res.ok) {
      const t = await res.text().catch(() => "Unknown");
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 150)}`);
    }

    const data = await res.json();
    const ms   = Date.now() - t0;

    log.info("Model responded", {
      model:   modelId,
      ms,
      attempt,
      tokens:  data.usage?.total_tokens,
    });

    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty content in response");
    return content;

  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ============================================================
//  CORS
// ============================================================
const cors = () => ({
  "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...cors() },
  body: JSON.stringify(body),
});

// ============================================================
//  HANDLER
// ============================================================
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    log.error("OPENROUTER_API_KEY not set in Netlify environment variables");
    return json(500, { error: "Server misconfiguration. API key not set." });
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  // Validate
  if (!body.title?.trim()) {
    return json(400, { error: "Sermon title is required." });
  }

  // Sanitize
  const input = {
    title:         body.title.trim().slice(0, 200),
    tone:          (body.tone || "Inspirational & Uplifting").slice(0, 100),
    audience:      (body.audience || "general congregation").slice(0, 100),
    scriptureHint: (body.scriptureHint || "").trim().slice(0, 200),
    context:       (body.context || "").trim().slice(0, 400),
    timeMins:      body.timeMins
      ? Math.min(Math.max(parseInt(body.timeMins) || 30, 5), 120)
      : null,
  };

  log.info("Request received", { title: input.title, tone: input.tone, audience: input.audience });

  const messages  = buildPrompt(input);
  let   lastError = null;

  for (const modelId of MODELS) {
    log.info("Trying model", { model: modelId });
    try {
      const raw    = await callModel(modelId, messages, apiKey);
      const parsed = parseJSON(raw);

      if (!parsed) {
        log.warn("Could not parse JSON", { model: modelId, preview: raw.slice(0, 200) });
        lastError = new Error(`Bad JSON from ${modelId}`);
        continue;
      }

      if (!validate(parsed)) {
        log.warn("Sermon failed validation", { model: modelId });
        lastError = new Error(`Incomplete sermon from ${modelId}`);
        continue;
      }

      // Enrich with real Bible verses
      const enriched = await enrichVerses(parsed);

      log.info("Sermon complete", { model: modelId, title: enriched.title });
      return json(200, { sermon: enriched, model: modelId });

    } catch (err) {
      log.error("Model failed", { model: modelId, error: err.message });
      lastError = err;
    }
  }

  log.error("All models exhausted", { error: lastError?.message });
  return json(502, {
    error:  "All AI providers are currently unavailable. Please try again in a moment.",
    detail: lastError?.message || "Unknown error",
  });
};
