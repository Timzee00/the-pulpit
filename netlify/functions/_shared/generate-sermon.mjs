import { protect } from './access.mjs';
// ============================================================
//  The Pulpit - Sermon Helper AI
//  Netlify Function: generate-sermon.js | Version 6.3
//  (6.3: Azure AI Translator is now the primary translation engine —
//  real NMT, no hallucination risk — with the LLM-based approach kept
//  only as a fallback for when AZURE_TRANSLATOR_KEY isn't set.
//  6.2: swapped the Yoruba/Hausa/Igbo verse safety-net from the
//  wldeh/bible-api GitHub dataset — confirmed NOT to carry these
//  languages — to API.Bible, which needs a free BIBLE_API_KEY.
//  6.1: tightened per-attempt timeout + overall deadline so the function
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

// The application uses a bounded request budget. Every retry/
// fallback loop must leave room for Scripture enrichment, or Netlify
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
const GROQ_MODELS = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

// -----------------------------------------------------------
//  OPENROUTER FREE MODELS — fallback pool
// -----------------------------------------------------------
const OPENROUTER_MODELS = ["openrouter/free"];

// -----------------------------------------------------------
//  MULTI-LANGUAGE BIBLE VERSES via API.Bible (scripture.api.bible,
//  run by American Bible Society). Used to fetch REAL verse text in
//  the target language after translation, instead of trusting the
//  LLM to translate Scripture accurately.
//
//  Needs a free API key: sign up at https://scripture.api.bible,
//  create an app, and set BIBLE_API_KEY in Netlify env vars. Without
//  it, this lookup is skipped entirely and the AI's own translated
//  verse text is left in place (same graceful-degradation pattern as
//  everywhere else in this file).
//
//  The wldeh/bible-api free GitHub dataset used previously turned out
//  not to carry Yoruba/Hausa/Igbo at all (confirmed via 404), so it's
//  been replaced here.
//
//  IMPORTANT: the bibleId values below are the "Open ... Contemporary
//  Bible" editions as referenced by a third-party integration example
//  (not Anthropic- or user-verified against the live API.Bible
//  catalog). Once you have your API key, confirm/refresh these by
//  calling GET https://api.scripture.api.bible/v1/bibles with your
//  api-key header and filtering the response for language codes
//  "yor", "hau", "ibo" — update the IDs below if they've changed.
// -----------------------------------------------------------
const BIBLE_API_BASE_URL = "https://api.scripture.api.bible/v1";

// Bible editions are resolved from API.Bible at runtime instead of relying on
// hard-coded IDs that can become invalid or unavailable for a particular key.
// Optional env overrides can pin a specific edition when desired.
const BIBLE_ENV_ID_BY_LANG = {
  yo: process.env.BIBLE_YO_ID || "",
  ha: process.env.BIBLE_HA_ID || "",
  ig: process.env.BIBLE_IG_ID || "",
};
const BIBLE_ISO3_BY_LANG = { yo: "yor", ha: "hau", ig: "ibo" };
const bibleIdCache = new Map();

const LANGUAGE_LABELS = { yo: "Yoruba", ha: "Hausa", ig: "Igbo" };

// Book-name -> USFM 3-letter code, the format API.Bible's verseId uses
// (e.g. "HEB.13.4"). Standard USFM codes per the Unified Standard
// Format Markers spec.
const BOOK_USFM_CODES = {
  "genesis": "GEN", "exodus": "EXO", "leviticus": "LEV",
  "numbers": "NUM", "deuteronomy": "DEU", "joshua": "JOS",
  "judges": "JDG", "ruth": "RUT", "1 samuel": "1SA",
  "2 samuel": "2SA", "1 kings": "1KI", "2 kings": "2KI",
  "1 chronicles": "1CH", "2 chronicles": "2CH",
  "ezra": "EZR", "nehemiah": "NEH", "esther": "EST", "job": "JOB",
  "psalm": "PSA", "psalms": "PSA", "proverbs": "PRO",
  "ecclesiastes": "ECC", "song of solomon": "SNG",
  "song of songs": "SNG", "isaiah": "ISA", "jeremiah": "JER",
  "lamentations": "LAM", "ezekiel": "EZK", "daniel": "DAN",
  "hosea": "HOS", "joel": "JOL", "amos": "AMO", "obadiah": "OBA",
  "jonah": "JON", "micah": "MIC", "nahum": "NAM",
  "habakkuk": "HAB", "zephaniah": "ZEP", "haggai": "HAG",
  "zechariah": "ZEC", "malachi": "MAL", "matthew": "MAT",
  "mark": "MRK", "luke": "LUK", "john": "JHN", "acts": "ACT",
  "romans": "ROM", "1 corinthians": "1CO",
  "2 corinthians": "2CO", "galatians": "GAL",
  "ephesians": "EPH", "philippians": "PHP",
  "colossians": "COL", "1 thessalonians": "1TH",
  "2 thessalonians": "2TH", "1 timothy": "1TI",
  "2 timothy": "2TI", "titus": "TIT", "philemon": "PHM",
  "hebrews": "HEB", "james": "JAS", "1 peter": "1PE",
  "2 peter": "2PE", "1 john": "1JN", "2 john": "2JN",
  "3 john": "3JN", "jude": "JUD", "revelation": "REV",
};

// ============================================================
//  BUILD PROVIDER LIST from available env keys
// ============================================================
function buildProviders(groqKey, openrouterKey, groqModels = GROQ_MODELS, openrouterModels = OPENROUTER_MODELS) {
  const list = [];

  if (groqKey) {
    for (const model of groqModels) {
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
    for (const model of openrouterModels) {
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

// -----------------------------------------------------------
//  TRANSLATION-ONLY MODEL LISTS — low-resource languages like
//  Yoruba, Hausa, and Igbo need the largest available model to get
//  fluent, correct output. Small/fast models (llama-3.1-8b-instant,
//  llama-3.2-3b) tend to garble words or drift into English mid-
//  sentence for these languages, so they're excluded here even
//  though they're fine (and fast) for English sermon generation.
// -----------------------------------------------------------
const TRANSLATION_GROQ_MODELS = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"];

const TRANSLATION_OPENROUTER_MODELS = ["openrouter/free"];

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

async function resolveBibleId(lang) {
  const configured = BIBLE_ENV_ID_BY_LANG[lang];
  if (configured) return configured;
  if (bibleIdCache.has(lang)) return bibleIdCache.get(lang);

  const apiKey = process.env.BIBLE_LICENSE_CONFIRMED === "true" ? process.env.BIBLE_API_KEY : "";
  const iso3 = BIBLE_ISO3_BY_LANG[lang];
  if (!apiKey || !iso3) return null;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${BIBLE_API_BASE_URL}/bibles?language=${iso3}`, {
      signal: ctrl.signal,
      headers: { "api-key": apiKey },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const d = await res.json();
    const bibles = Array.isArray(d?.data) ? d.data : [];
    if (!bibles.length) return null;

    // Prefer a full Bible over a New Testament-only edition where metadata
    // makes that distinction visible; otherwise use the first authorized edition.
    const full = bibles.find(b => !/new testament|nt only|testament only/i.test(`${b.name} ${b.nameLocal || ""}`));
    const id = (full || bibles[0]).id;
    bibleIdCache.set(lang, id);
    return id;
  } catch (err) {
    log.warn("Unable to resolve Bible edition", { lang, error: err.message });
    return null;
  }
}

async function fetchVerseInLanguage(reference, lang) {
  const apiKey = process.env.BIBLE_LICENSE_CONFIRMED === "true" ? process.env.BIBLE_API_KEY : "";
  if (!apiKey) return null; // no key configured — caller falls back to AI's own translation

  const bibleId = await resolveBibleId(lang);
  if (!bibleId) return null;

  const parsed = parseReference(reference);
  if (!parsed) return null;

  const usfmBook = BOOK_USFM_CODES[parsed.book.toLowerCase()];
  if (!usfmBook) {
    log.warn("No USFM book code mapping", { book: parsed.book });
    return null;
  }

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const verseId = `${usfmBook}.${parsed.chapter}.${parsed.verse}`;
    const url = `${BIBLE_API_BASE_URL}/bibles/${bibleId}/verses/${verseId}` +
      `?content-type=text&include-verse-numbers=false&include-chapter-numbers=false&include-notes=false`;
    const res = await fetch(url, { signal: ctrl.signal, headers: { "api-key": apiKey } });
    clearTimeout(timer);
    if (!res.ok) {
      log.warn("API.Bible lookup failed", { status: res.status, verseId, lang });
      return null;
    }
    const d = await res.json();
    const text = d?.data?.content;
    if (text) return { text: text.replace(/\n/g, " ").trim() };
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
- Use natural, everyday ${langLabel} as spoken/preached in church — the register a real pastor uses from the pulpit, not a stiff literal word-for-word rendering
- Do NOT mix in English words or phrases unless a term has no ${langLabel} equivalent at all (e.g. a proper name) — do not code-switch mid-sentence
- Do NOT invent or guess unfamiliar ${langLabel} words — prefer a common, widely understood word or short phrase over a rare or made-up one
- If a theological term has a standard, well-known ${langLabel} rendering used in churches, use that standard rendering rather than a literal translation

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
async function callProvider(provider, messages, attempt = 1, temperature = 0.8) {
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
        temperature,
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
        return callProvider(provider, messages, attempt + 1, temperature);
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
// -----------------------------------------------------------
//  AZURE AI TRANSLATOR — real NMT, used as the PRIMARY translation
//  path when configured (no hallucination risk, unlike the LLM
//  fallback below). Needs AZURE_TRANSLATOR_KEY + AZURE_TRANSLATOR_REGION
//  env vars (free F0 tier: 2M characters/month). Falls through to the
//  LLM-based translation further down if these aren't set, or if the
//  Azure call itself fails.
// -----------------------------------------------------------
const AZURE_TRANSLATOR_ENDPOINT = "https://api.cognitive.microsofttranslator.com";

// Walks the sermon object and collects every translatable string field
// paired with a setter, so results can be written back onto a clone in
// place. Deliberately explicit (not a generic deep-walker) so "reference"
// fields and numeric fields (estimated_minutes) never get sent for
// translation by accident.
function collectTranslatableFields(sermon) {
  const items = [];
  const add = (obj, key) => {
    if (obj && typeof obj[key] === "string" && obj[key].trim()) {
      items.push({ text: obj[key], set: (t) => { obj[key] = t; } });
    }
  };

  add(sermon, "title");
  if (sermon.theme_verse) add(sermon.theme_verse, "text");

  const intro = sermon.introduction || {};
  add(intro, "hook"); add(intro, "problem_statement"); add(intro, "thesis");

  const bg = sermon.background_context || {};
  add(bg, "historical"); add(bg, "why_it_matters_today");

  (sermon.main_points || []).forEach(pt => {
    add(pt, "title"); add(pt, "exposition"); add(pt, "illustration"); add(pt, "application");
    if (pt.scripture) add(pt.scripture, "text");
  });

  (sermon.supporting_verses || []).forEach(v => {
    add(v, "text");
    add(v, "purpose");
  });

  const c = sermon.conclusion || {};
  add(c, "summary"); add(c, "call_to_action"); add(c, "closing_illustration");

  add(sermon, "altar_call");
  add(sermon, "closing_prayer");

  (sermon.preacher_notes || []).forEach((note, idx) => {
    if (typeof note === "string" && note.trim()) {
      items.push({ text: note, set: (t) => { sermon.preacher_notes[idx] = t; } });
    }
  });

  return items;
}

// Returns a translated clone of the sermon, or null if Azure isn't
// configured (caller should fall back to the LLM path in that case).
// Throws on an actual API failure so the caller can distinguish
// "not configured" (silent fallback) from "configured but broken"
// (also falls back, but logs a warning).
async function translateWithAzure(sermon, targetLangCode) {
  const key    = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;
  if (!key || !region) return null;

  const clone = JSON.parse(JSON.stringify(sermon));
  const items = collectTranslatableFields(clone);
  if (!items.length) return clone;

  // Azure limits: 100 array elements / 50,000 chars per request. A sermon
  // fits comfortably in one batch, but chunk defensively just in case.
  const BATCH_SIZE = 90;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const url = `${AZURE_TRANSLATOR_ENDPOINT}/translate?api-version=3.0&from=en&to=${targetLangCode}`;

    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Ocp-Apim-Subscription-Key":    key,
        "Ocp-Apim-Subscription-Region": region,
        "Content-Type":                 "application/json",
      },
      body: JSON.stringify(batch.map(b => ({ Text: b.text }))),
    });
    clearTimeout(timer);

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Azure Translator HTTP ${res.status}: ${t.slice(0, 200)}`);
    }

    const data = await res.json();
    data.forEach((entry, idx) => {
      const translated = entry?.translations?.[0]?.text;
      if (translated) batch[idx].set(translated);
    });
  }

  return clone;
}

async function handleTranslate(body, groqKey, openrouterKey) {
  const targetLang = (body.targetLang || "").trim();
  const sermon      = body.sermon;

  if (!LANGUAGE_LABELS[targetLang]) {
    return respond(400, { error: `Unsupported or missing targetLang. Use one of: ${Object.keys(LANGUAGE_LABELS).join(", ")}` });
  }
  if (!sermon || typeof sermon !== "object") {
    return respond(400, { error: "A sermon object is required for translation." });
  }

  // Preferred path: Azure AI Translator (real NMT, no hallucination
  // risk). Falls through to the LLM-based translation below only if
  // Azure isn't configured, or the call itself fails.
  try {
    const azureResult = await translateWithAzure(sermon, targetLang);
    if (azureResult) {
      const enriched = await enrichVersesForLanguage(azureResult, targetLang);
      log.info("Translation complete (Azure)", { targetLang });
      return respond(200, { sermon: enriched, model: "azure-translator" });
    }
  } catch (err) {
    log.warn("Azure translation failed, falling back to LLM", { error: err.message });
  }

  // Fallback: LLM-based translation. Only reached if AZURE_TRANSLATOR_KEY/
  // AZURE_TRANSLATOR_REGION aren't set, or the Azure call above failed.
  const providers = buildProviders(groqKey, openrouterKey, TRANSLATION_GROQ_MODELS, TRANSLATION_OPENROUTER_MODELS);
  const messages   = buildTranslationMessages(sermon, LANGUAGE_LABELS[targetLang]);
  let   lastError  = null;
  const deadline   = Date.now() + FUNCTION_BUDGET_MS;
  const perAttemptBuffer = TIMEOUT_MS + 500;
  const TRANSLATION_TEMPERATURE = 0.2; // low — fidelity matters far more than creativity here

  for (const provider of providers) {
    if (Date.now() + perAttemptBuffer > deadline) {
      log.warn("Stopping translation before budget exhausted", { provider: provider.name });
      lastError = lastError || new Error("Time budget exhausted before all providers were tried");
      break;
    }
    log.info("Trying provider (translation)", { provider: provider.name, targetLang });
    try {
      const raw    = await callProvider(provider, messages, 1, TRANSLATION_TEMPERATURE);
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
    
  });
}

// ============================================================
//  MAIN HANDLER
// ============================================================
const run = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed." });
  }

  const denied = await protect(event, { cost: 3 });
  if (denied) return denied;
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
  if (!body || Array.isArray(body)) return respond(400, {error:"A JSON object is required."});
  if (["title","tone","audience","scriptureHint","context"].some(key => body[key] !== undefined && typeof body[key] !== "string")) return respond(400,{error:"Invalid text field."});
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

  log.info("Request received");

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
        log.warn("Could not parse JSON", { provider: provider.name,  });
        lastError = new Error(`Bad JSON from ${provider.name}`);
        continue;
      }

      if (!validate(parsed)) {
        log.warn("Validation failed", { provider: provider.name });
        lastError = new Error(`Incomplete sermon from ${provider.name}`);
        continue;
      }

      const enriched = await enrichVerses(parsed);
      log.info("Sermon complete", { provider: provider.name });
      return respond(200, { sermon: enriched, model: provider.name });

    } catch (err) {
      log.error("Provider failed", { provider: provider.name, error: err.message });
      lastError = err;
    }
  }

  log.error("All providers exhausted", { error: lastError?.message });
  return respond(502, {
    error:  "All AI providers are currently unavailable. Please try again in a moment.",
    
  });
};

export {run};
export default {run};
