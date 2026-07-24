// ============================================================
//  The Pulpit - Sermon Helper AI
//  Netlify Function: generate-sermon.js | Version 6.1
//  (6.1: tightened per-attempt timeout + overall deadline so the function
//  always returns before Netlify's own 26s hard timeout kills it — see
//  FUNCTION_BUDGET_MS below)
//
//  PROVIDERS (tried in order):
//  1. Groq    — fastest, generous free tier, no credit card
//  2. OpenRouter — fallback with free model pool
//
//  Set in Netlify → Site Settings → Environment Variables:
//    GROQ_API_KEY        = from console.groq.com (free, no card)
//    OPENROUTER_API_KEY  = from openrouter.ai   (free backup)
//    ALLOWED_ORIGIN      = https://your-site.netlify.app
//
//  To switch providers: just set/unset the env variables.
//  If only GROQ_API_KEY is set   → uses Groq only
//  If only OPENROUTER_API_KEY    → uses OpenRouter only
//  If both are set               → Groq first, OpenRouter fallback
// ============================================================

const GROQ_ENDPOINT       = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const BIBLE_API_BASE      = "https://bible-api.com";
const ALLOWED_ORIGIN      = process.env.ALLOWED_ORIGIN || "*";

// Netlify's function hard-timeout is 26s (see netlify.toml). Every retry/
// fallback loop below must fit inside that with room to spare, or Netlify
// kills the whole function and the caller gets a bare platform 502 instead
// of our own JSON error response.
const FUNCTION_BUDGET_MS = 22000; // total wall-clock budget for all attempts combined
const TIMEOUT_MS         = 9000;  // per-attempt timeout (was 50000 — far too long)
const MAX_RETRIES        = 1;     // only retry once, and only on 5xx (see callProvider)
const RETRY_DELAY_MS     = 1200;

// -----------------------------------------------------------
//  GROQ FREE MODELS — confirmed working May 2026
//  Ordered by quality for sermon writing
// -----------------------------------------------------------
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",   // Best quality, great for long JSON
  "qwen-qwq-32b",              // Strong reasoning model
  "llama-4-scout-17b-16e-instruct", // Fast, multimodal capable
  "mistral-saba-24b",          // Good multilingual support
  "llama-3.1-8b-instant",      // Fastest, last resort
];

// -----------------------------------------------------------
//  OPENROUTER FREE MODELS — fallback pool
// -----------------------------------------------------------
const OPENROUTER_MODELS = [
  "openrouter/free",                                // Auto-picks best available
  "meta-llama/llama-3.3-70b-instruct:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "meta-llama/llama-3.2-3b-instruct:free",
];

// -----------------------------------------------------------
//  MULTI-LANGUAGE BIBLE VERSES (wldeh/bible-api via jsDelivr CDN,
//  free + unlimited, no API key). Used to fetch REAL verse text in
//  the target language after translation, instead of trusting the
//  LLM to translate Scripture accurately.
// -----------------------------------------------------------
const WLDEH_BASE = "https://cdn.jsdelivr.net/gh/wldeh/bible-api/bibles";

const BIBLE_VERSION_BY_LANG = {
  yo: "yo-oycb", // Biblica Open Yoruba Contemporary Bible 2017
  ha: "ha-bsrk", // Biblica Open Hausa Contemporary Bible 2020
  ig: "ig-biuo", // Biblica Open Igbo Contemporary Bible 2020
};

const LANGUAGE_LABELS = { yo: "Yoruba", ha: "Hausa", ig: "Igbo" };

// Book-name -> wldeh URL slug. NOTE: confirmed against the API's own
// README example ("genesis", "john"); numbered/multi-word book slugs
// (e.g. "1corinthians", "songofsolomon") are the standard convention
// for this dataset but haven't been individually verified against
// every version — if a specific reference 404s, enrichVersesForLanguage
// just leaves the AI's translated text in place rather than failing.
const BOOK_SLUGS = {
  "genesis": "genesis", "exodus": "exodus", "leviticus": "leviticus",
  "numbers": "numbers", "deuteronomy": "deuteronomy", "joshua": "joshua",
  "judges": "judges", "ruth": "ruth", "1 samuel": "1samuel",
  "2 samuel": "2samuel", "1 kings": "1kings", "2 kings": "2kings",
  "1 chronicles": "1chronicles", "2 chronicles": "2chronicles",
  "ezra": "ezra", "nehemiah": "nehemiah", "esther": "esther", "job": "job",
  "psalm": "psalms", "psalms": "psalms", "proverbs": "proverbs",
  "ecclesiastes": "ecclesiastes", "song of solomon": "songofsolomon",
  "song of songs": "songofsolomon", "isaiah": "isaiah", "jeremiah": "jeremiah",
  "lamentations": "lamentations", "ezekiel": "ezekiel", "daniel": "daniel",
  "hosea": "hosea", "joel": "joel", "amos": "amos", "obadiah": "obadiah",
  "jonah": "jonah", "micah": "micah", "nahum": "nahum",
  "habakkuk": "habakkuk", "zephaniah": "zephaniah", "haggai": "haggai",
  "zechariah": "zechariah", "malachi": "malachi", "matthew": "matthew",
  "mark": "mark", "luke": "luke", "john": "john", "acts": "acts",
  "romans": "romans", "1 corinthians": "1corinthians",
  "2 corinthians": "2corinthians", "galatians": "galatians",
  "ephesians": "ephesians", "philippians": "philippians",
  "colossians": "colossians", "1 thessalonians": "1thessalonians",
  "2 thessalonians": "2thessalonians", "1 timothy": "1timothy",
  "2 timothy": "2timothy", "titus": "titus", "philemon": "philemon",
  "hebrews": "hebrews", "james": "james", "1 peter": "1peter",
  "2 peter": "2peter", "1 john": "1john", "2 john": "2john",
  "3 john": "3john", "jude": "jude", "revelation": "revelation",
};

// ============================================================
//  BUILD PROVIDER LIST from available env keys
// ============================================================
function buildProviders(groqKey, openrouterKey) {
  const list = [];

  if (groqKey) {
    for (const model of GROQ_MODELS) {
      list.push({
        name:     `groq/${model}`,
        endpoint: GROQ_ENDPOINT,
        apiKey:   groqKey,
        model,
        isGroq:   true,
      });
    }
  }

  if (openrouterKey) {
    for (const model of OPENROUTER_MODELS) {
      list.push({
        name:     `openrouter/${model}`,
        endpoint: OPENROUTER_ENDPOINT,
        apiKey:   openrouterKey,
        model,
        isGroq:   false,
      });
    }
  }

  return list;
}

// ============================================================
//  LOGGING
// ============================================================
const log = {
  info:  (msg, d = {}) => console.log(JSON.stringify({ level: "INFO",  msg, ...d, ts: Date.now() })),
  warn:  (msg, d = {}) => console.warn(JSON.stringify({ level: "WARN",  msg, ...d, ts: Date.now() })),
  error: (msg, d = {}) => console.error(JSON.stringify({ level: "ERROR", msg, ...d, ts: Date.now() })),
};

// ============================================================
//  BIBLE API — real verse text, prevents hallucination
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
      ...(sermon.theme_verse       ? [{ obj: sermon,           key: "theme_verse" }] : []),
      ...(sermon.main_points    || []).map(pt => ({ obj: pt,   key: "scripture"   })),
      ...(sermon.supporting_verses || []).map(v => ({ obj: v,  key: "self"        })),
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

// -----------------------------------------------------------
//  MULTI-LANGUAGE VERSE LOOKUP — replaces LLM-translated Scripture
//  with real verse text in the target language after a translation.
// -----------------------------------------------------------
function parseReference(reference) {
  if (!reference) return null;
  const m = reference.trim().match(/^(.*?)\s+(\d+):(\d+)$/);
  if (!m) return null;
  return { book: m[1].trim(), chapter: m[2], verse: m[3] };
}

async function fetchVerseInLanguage(reference, lang) {
  const version = BIBLE_VERSION_BY_LANG[lang];
  if (!version) return null;
  const parsed = parseReference(reference);
  if (!parsed) return null;
  const slug = BOOK_SLUGS[parsed.book.toLowerCase()];
  if (!slug) {
    log.warn("No book slug mapping", { book: parsed.book });
    return null;
  }
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const url   = `${WLDEH_BASE}/${version}/books/${slug}/chapters/${parsed.chapter}/verses/${parsed.verse}.json`;
    const res   = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const d = await res.json();
    if (d?.text) return { text: d.text.replace(/\n/g, " ").trim() };
    return null;
  } catch { return null; }
}

async function enrichVersesForLanguage(sermon, lang) {
  try {
    const targets = [
      ...(sermon.theme_verse       ? [{ obj: sermon,           key: "theme_verse" }] : []),
      ...(sermon.main_points    || []).map(pt => ({ obj: pt,   key: "scripture"   })),
      ...(sermon.supporting_verses || []).map(v => ({ obj: v,  key: "self"        })),
    ];
    let hits = 0;
    await Promise.all(targets.map(async ({ obj, key }) => {
      // Reference should have stayed in English per the translation
      // prompt — that's what we look up against the language Bible.
      const ref = key === "self" ? obj.reference : obj[key]?.reference;
      if (!ref) return;
      const real = await fetchVerseInLanguage(ref, lang);
      if (!real) return; // leave the AI's translated text in place — don't break the sermon
      hits++;
      if (key === "self") { obj.text = real.text; }
      else                { obj[key].text = real.text; }
    }));
    log.info("Language verses enriched", { lang, hits, of: targets.length });
  } catch (e) {
    log.warn("Language verse enrichment failed silently", { lang, error: e.message });
  }
  return sermon;
}

// ============================================================
//  JSON UTILITIES
// ============================================================
function parseJSON(raw) {
  if (!raw) return null;
  let text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try { return JSON.parse(text); } catch { /* try harder */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return null;
}

function validate(obj) {
  if (!obj || typeof obj !== "object") return false;
  const required = [
    "title", "theme_verse", "introduction", "background_context",
    "main_points", "supporting_verses", "conclusion",
    "altar_call", "closing_prayer", "preacher_notes",
  ];
  for (const k of required) {
    if (!(k in obj)) { log.warn("Missing field", { field: k }); return false; }
  }
  if (!Array.isArray(obj.main_points)       || obj.main_points.length === 0) return false;
  if (!Array.isArray(obj.supporting_verses))                                   return false;
  if (!Array.isArray(obj.preacher_notes))                                      return false;
  return true;
}

// ============================================================
//  PROMPT BUILDER
// ============================================================
function buildMessages(input) {
  const {
    title, tone = "Inspirational & Uplifting",
    audience = "general congregation",
    scriptureHint = "", context = "", timeMins = null,
  } = input;

  const extras = [
    scriptureHint ? `Include these scriptures: ${scriptureHint}.` : "",
    context       ? `Special context: ${context}`                 : "",
    timeMins      ? `Target length: ${timeMins} minutes.`         : "",
  ].filter(Boolean).join(" ");

  const system = `You are a deeply anointed pastor and sermon writer with 40 years of experience. You write humanized, heart-touching sermons rooted in Scripture. You speak to real pain, real hope, real life — never generic. Every word must touch the heart.

CRITICAL: Respond with ONLY a raw JSON object. No markdown fences. No backticks. No explanation. No text before or after. Your entire response must start with { and end with }.`;

  const user = `Write a complete, deeply moving sermon. Return ONLY raw JSON.

TITLE: "${title}"
TONE: ${tone}
AUDIENCE: ${audience}
${extras}

Required JSON structure (return ONLY this, nothing else):
{
  "title": "The sermon title",
  "theme_verse": { "reference": "Book Chapter:Verse", "text": "Full verse text" },
  "introduction": {
    "hook": "A gripping 2-3 sentence opening that makes every person lean forward",
    "problem_statement": "The real human pain or question this sermon answers",
    "thesis": "The one central truth this entire sermon declares",
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
      "exposition": "Deep vulnerable humanized 3-paragraph explanation. Touch real struggles.",
      "illustration": "A vivid real-life story or analogy that makes this point unforgettable",
      "application": "What the listener must specifically do or believe after this",
      "estimated_minutes": 7
    },
    {
      "number": 2,
      "title": "Point title",
      "scripture": { "reference": "Book Chapter:Verse", "text": "Verse text" },
      "exposition": "Deep humanized exposition. Speak to every broken heart.",
      "illustration": "Vivid relatable illustration",
      "application": "Specific practical application",
      "estimated_minutes": 7
    },
    {
      "number": 3,
      "title": "Point title",
      "scripture": { "reference": "Book Chapter:Verse", "text": "Verse text" },
      "exposition": "Deep humanized exposition. Leave no heart unmoved.",
      "illustration": "Vivid relatable illustration",
      "application": "Specific practical application",
      "estimated_minutes": 7
    }
  ],
  "supporting_verses": [
    { "reference": "Book Chapter:Verse", "text": "Verse text", "purpose": "How this verse strengthens the message" },
    { "reference": "Book Chapter:Verse", "text": "Verse text", "purpose": "How this verse strengthens the message" },
    { "reference": "Book Chapter:Verse", "text": "Verse text", "purpose": "How this verse strengthens the message" },
    { "reference": "Book Chapter:Verse", "text": "Verse text", "purpose": "How this verse strengthens the message" }
  ],
  "conclusion": {
    "summary": "Powerful 2-3 sentence recap that locks the whole message into the heart",
    "call_to_action": "Direct emotionally resonant challenge to the person who almost did not come today",
    "closing_illustration": "Brief moving final story or image that seals this message forever",
    "estimated_minutes": 4
  },
  "altar_call": "Warm personal Spirit-filled invitation. Speak to the broken person in the back row. Make them feel seen. Make them want to respond.",
  "closing_prayer": "Pastoral prayer that covers blesses and sends the congregation out with renewed faith",
  "preacher_notes": ["Delivery tip 1", "Delivery tip 2", "Delivery tip 3", "Delivery tip 4"],
  "total_estimated_minutes": 35
}`;

  return [
    { role: "system", content: system },
    { role: "user",   content: user   },
  ];
}

// -----------------------------------------------------------
//  TRANSLATION PROMPT BUILDER — dedicated prompt, not a reuse of
//  the sermon-writing prompt. Keeps reference fields untouched
//  (verse TEXT gets replaced server-side via enrichVersesForLanguage,
//  so the translation only needs to preserve which reference is which).
// -----------------------------------------------------------
function buildTranslationMessages(sermon, langLabel) {
  const system = `You are an expert Bible-literate translator working on pastoral/sermon material. You translate faithfully into ${langLabel}, preserving pastoral tone, theological meaning, and emotional register. You never add, remove, summarize, or reinterpret content — only translate it.

CRITICAL: Respond with ONLY a raw JSON object. No markdown fences. No backticks. No explanation. Your entire response must start with { and end with }.`;

  const user = `Translate every string value in the sermon JSON below into ${langLabel}.

Rules:
- Keep every JSON key exactly as-is in English (do not translate keys)
- Keep the exact same JSON structure, nesting, and array lengths as the input
- Do NOT translate any "reference" field (e.g. "John 3:16") — copy those exactly as given, unchanged
- Translate all other string values naturally and fluently: titles, hooks, exposition, illustrations, applications, prayers, notes, everything else
- Numbers (like estimated_minutes) stay as numbers, unchanged

Sermon JSON to translate:
${JSON.stringify(sermon)}`;

  return [
    { role: "system", content: system },
    { role: "user",   content: user   },
  ];
}

// ============================================================
//  API CALL WITH RETRY
// ============================================================
async function callProvider(provider, messages, attempt = 1) {
  const t0    = Date.now();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const headers = {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${provider.apiKey}`,
    };

    // OpenRouter needs extra tracking headers
    if (!provider.isGroq) {
      headers["HTTP-Referer"] = "https://the-pulpit.netlify.app";
      headers["X-Title"]      = "The Pulpit - Sermon Helper AI";
    }

    const res = await fetch(provider.endpoint, {
      method:  "POST",
      signal:  ctrl.signal,
      headers,
      body: JSON.stringify({
        model:       provider.model,
        max_tokens:  4000,
        temperature: 0.8,
        messages,
        // No response_format — breaks many free models on both providers
      }),
    });

    clearTimeout(timer);

    // 429 = rate limited. Retrying the same model won't help within a few
    // seconds, so fail fast and let the caller move to the next model.
    if (res.status === 429) {
      const t = await res.text().catch(() => "");
      throw new Error(`HTTP 429 (rate limited): ${t.slice(0, 150)}`);
    }

    // Retry on server error only — transient, worth one quick retry.
    if (res.status >= 500 && res.status < 600) {
      if (attempt <= MAX_RETRIES) {
        log.warn("Retrying", { provider: provider.name, status: res.status, attempt });
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        return callProvider(provider, messages, attempt + 1);
      }
      const t = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries: ${t.slice(0, 150)}`);
    }

    if (!res.ok) {
      const t = await res.text().catch(() => "Unknown error");
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
    }

    const data = await res.json();
    log.info("Provider responded", {
      provider: provider.name,
      ms:       Date.now() - t0,
      attempt,
      tokens:   data.usage?.total_tokens,
    });

    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty content in API response");
    return content;

  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ============================================================
//  CORS + RESPONSE HELPERS
// ============================================================
const cors = () => ({
  "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

const respond = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", ...cors() },
  body: JSON.stringify(body),
});

// ============================================================
//  TRANSLATION HANDLER
// ============================================================
async function handleTranslate(body, groqKey, openrouterKey) {
  const targetLang = (body.targetLang || "").trim();
  const sermon      = body.sermon;

  if (!LANGUAGE_LABELS[targetLang]) {
    return respond(400, { error: `Unsupported or missing targetLang. Use one of: ${Object.keys(LANGUAGE_LABELS).join(", ")}` });
  }
  if (!sermon || typeof sermon !== "object") {
    return respond(400, { error: "A sermon object is required for translation." });
  }

  const providers = buildProviders(groqKey, openrouterKey);
  const messages   = buildTranslationMessages(sermon, LANGUAGE_LABELS[targetLang]);
  let   lastError  = null;
  const deadline   = Date.now() + FUNCTION_BUDGET_MS;
  const perAttemptBuffer = TIMEOUT_MS + 500;

  for (const provider of providers) {
    if (Date.now() + perAttemptBuffer > deadline) {
      log.warn("Stopping translation before budget exhausted", { provider: provider.name });
      lastError = lastError || new Error("Time budget exhausted before all providers were tried");
      break;
    }
    log.info("Trying provider (translation)", { provider: provider.name, targetLang });
    try {
      const raw    = await callProvider(provider, messages);
      const parsed = parseJSON(raw);

      if (!parsed || !validate(parsed)) {
        log.warn("Translation failed validation", { provider: provider.name });
        lastError = new Error(`Bad or incomplete translation from ${provider.name}`);
        continue;
      }

      const enriched = await enrichVersesForLanguage(parsed, targetLang);
      log.info("Translation complete", { provider: provider.name, targetLang });
      return respond(200, { sermon: enriched, model: provider.name });

    } catch (err) {
      log.error("Provider failed (translation)", { provider: provider.name, error: err.message });
      lastError = err;
    }
  }

  log.error("All providers exhausted (translation)", { error: lastError?.message });
  return respond(502, {
    error:  "Translation is currently unavailable. Please try again in a moment.",
    detail: lastError?.message || "Unknown error",
  });
}

// ============================================================
//  MAIN HANDLER
// ============================================================
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed." });
  }

  const groqKey       = process.env.GROQ_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!groqKey && !openrouterKey) {
    log.error("No API keys found in environment");
    return respond(500, {
      error: "Server misconfiguration. Set GROQ_API_KEY or OPENROUTER_API_KEY in Netlify environment variables."
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid request body." });
  }

  // Translation requests are a different shape entirely — handle them
  // with their own prompt and verse lookup instead of reusing the
  // sermon-generation path (previously done by stuffing the whole
  // sermon into scriptureHint, which produced unreliable translations).
  if (body.tone === "translation") {
    return handleTranslate(body, groqKey, openrouterKey);
  }

  if (!body.title?.trim()) {
    return respond(400, { error: "Sermon title is required." });
  }

  // Sanitize
  const input = {
    title:         body.title.trim().slice(0, 200),
    tone:          (body.tone          || "Inspirational & Uplifting").slice(0, 100),
    audience:      (body.audience      || "general congregation").slice(0, 100),
    scriptureHint: (body.scriptureHint || "").trim().slice(0, 200),
    context:       (body.context       || "").trim().slice(0, 400),
    timeMins:      body.timeMins
      ? Math.min(Math.max(parseInt(body.timeMins) || 30, 5), 120)
      : null,
  };

  log.info("Request received", { title: input.title, tone: input.tone });

  const providers   = buildProviders(groqKey, openrouterKey);
  const messages    = buildMessages(input);
  let   lastError   = null;
  const deadline    = Date.now() + FUNCTION_BUDGET_MS;
  const perAttemptBuffer = TIMEOUT_MS + 500; // don't start an attempt we can't finish

  for (const provider of providers) {
    if (Date.now() + perAttemptBuffer > deadline) {
      log.warn("Stopping before budget exhausted", { provider: provider.name });
      lastError = lastError || new Error("Time budget exhausted before all providers were tried");
      break;
    }
    log.info("Trying provider", { provider: provider.name });
    try {
      const raw    = await callProvider(provider, messages);
      const parsed = parseJSON(raw);

      if (!parsed) {
        log.warn("Could not parse JSON", { provider: provider.name, preview: raw.slice(0, 200) });
        lastError = new Error(`Bad JSON from ${provider.name}`);
        continue;
      }

      if (!validate(parsed)) {
        log.warn("Validation failed", { provider: provider.name });
        lastError = new Error(`Incomplete sermon from ${provider.name}`);
        continue;
      }

      const enriched = await enrichVerses(parsed);
      log.info("Sermon complete", { provider: provider.name, title: enriched.title });
      return respond(200, { sermon: enriched, model: provider.name });

    } catch (err) {
      log.error("Provider failed", { provider: provider.name, error: err.message });
      lastError = err;
    }
  }

  log.error("All providers exhausted", { error: lastError?.message });
  return respond(502, {
    error:  "All AI providers are currently unavailable. Please try again in a moment.",
    detail: lastError?.message || "Unknown error",
  });
};
