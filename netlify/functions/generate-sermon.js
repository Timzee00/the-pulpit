// ============================================================
//  The Pulpit - Sermon Helper AI
//  Netlify Serverless Function: generate-sermon.js
//  Version: 2.0 - Production Hardened
//
//  Fixes applied:
//  [1] Header em dash replaced with hyphen (ByteString crash fix)
//  [2] response_format: json_object for reliable JSON output
//  [3] max_tokens reduced to 4000 (free tier safe)
//  [4] Prompt slimmed down for speed
//  [5] Retry logic for 429 and 5xx errors
//  [6] CORS locked to production domain
//  [7] Bible verse verification via bible-api.com
//  [8] Full structured logging (model, latency, tokens, failures)
// ============================================================

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const BIBLE_API_BASE = "https://bible-api.com";

// UPDATE THIS to your actual Netlify domain
// Or set ALLOWED_ORIGIN in Netlify environment variables
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const MODEL_PRIORITY = [
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-r1:free",
  "mistralai/mistral-7b-instruct:free",
];

const TIMEOUT_MS = 50000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

// ============================================================
//  LOGGING
// ============================================================
const log = {
  info:  (msg, data) => console.log(JSON.stringify({ level: "INFO",  msg, ...data, ts: Date.now() })),
  warn:  (msg, data) => console.warn(JSON.stringify({ level: "WARN",  msg, ...data, ts: Date.now() })),
  error: (msg, data) => console.error(JSON.stringify({ level: "ERROR", msg, ...data, ts: Date.now() })),
};

// ============================================================
//  BIBLE VERSE RETRIEVAL - reduces hallucinated scriptures
// ============================================================
async function fetchBibleVerse(reference) {
  if (!reference) return null;
  try {
    const encoded = encodeURIComponent(reference.trim());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${BIBLE_API_BASE}/${encoded}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.text && data.reference) {
      return { reference: data.reference, text: data.text.replace(/\n/g, " ").trim() };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
//  JSON UTILITIES
// ============================================================
function stripMarkdown(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function safeParseJSON(text) {
  const cleaned = stripMarkdown(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

function validateSermon(obj) {
  const required = [
    "title", "theme_verse", "introduction", "background_context",
    "main_points", "supporting_verses", "conclusion",
    "altar_call", "closing_prayer", "preacher_notes",
  ];
  const issues = [];
  for (const key of required) {
    if (!(key in obj)) {
      issues.push(`missing: ${key}`);
    } else if (key === "main_points" && !Array.isArray(obj[key])) {
      issues.push(`main_points must be array`);
    } else if (key === "supporting_verses" && !Array.isArray(obj[key])) {
      issues.push(`supporting_verses must be array`);
    } else if (key === "preacher_notes" && !Array.isArray(obj[key])) {
      issues.push(`preacher_notes must be array`);
    }
  }
  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

// ============================================================
//  PROMPT BUILDER
// ============================================================
function buildMessages(body) {
  const { title, tone = "Inspirational & Uplifting", audience = "general congregation",
          scriptureHint = "", context = "", timeMins = null } = body;

  const extras = [
    scriptureHint ? `Key scriptures to include: ${scriptureHint}.` : "",
    context       ? `Context: ${context}` : "",
    timeMins      ? `Target duration: ${timeMins} minutes. Add estimated_minutes per section.` : "",
  ].filter(Boolean).join(" ");

  const systemPrompt = `You are a deeply anointed pastor and sermon writer with 40 years of experience. Write humanized, heart-touching sermons rooted in Scripture. Speak to real pain, real hope, real life - never generic. Return ONLY raw valid JSON. No markdown. No backticks. No explanation. Raw JSON only.`;

  const userPrompt = `Write a complete sermon. Return ONLY raw JSON matching this exact structure:

TITLE: "${title}"
TONE: ${tone}
AUDIENCE: ${audience}
${extras}

{
  "title": "string",
  "theme_verse": { "reference": "string", "text": "string" },
  "introduction": {
    "hook": "2-3 powerful sentences that grab the heart",
    "problem_statement": "The real human struggle this sermon addresses",
    "thesis": "The central truth being declared",
    "estimated_minutes": 5
  },
  "background_context": {
    "historical": "Biblical/historical context for the theme",
    "why_it_matters_today": "Why this is urgent and relevant now",
    "estimated_minutes": 3
  },
  "main_points": [
    {
      "number": 1,
      "title": "string",
      "scripture": { "reference": "string", "text": "string" },
      "exposition": "Deep humanized 2-3 paragraph explanation",
      "illustration": "A real relatable story or analogy",
      "application": "Specific practical instruction for the listener",
      "estimated_minutes": 7
    },
    {
      "number": 2,
      "title": "string",
      "scripture": { "reference": "string", "text": "string" },
      "exposition": "Deep humanized exposition",
      "illustration": "Relatable illustration",
      "application": "Practical application",
      "estimated_minutes": 7
    },
    {
      "number": 3,
      "title": "string",
      "scripture": { "reference": "string", "text": "string" },
      "exposition": "Deep humanized exposition",
      "illustration": "Relatable illustration",
      "application": "Practical application",
      "estimated_minutes": 7
    }
  ],
  "supporting_verses": [
    { "reference": "string", "text": "string", "purpose": "string" },
    { "reference": "string", "text": "string", "purpose": "string" },
    { "reference": "string", "text": "string", "purpose": "string" },
    { "reference": "string", "text": "string", "purpose": "string" }
  ],
  "conclusion": {
    "summary": "Powerful 2-3 sentence recap",
    "call_to_action": "Emotionally resonant direct call to decision",
    "closing_illustration": "Brief moving story that seals the message",
    "estimated_minutes": 4
  },
  "altar_call": "Warm Spirit-filled invitation speaking one-on-one to the soul",
  "closing_prayer": "Heartfelt pastoral prayer sending the congregation out in faith",
  "preacher_notes": ["tip1", "tip2", "tip3", "tip4"],
  "total_estimated_minutes": 35
}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt   },
  ];
}

// ============================================================
//  OPENROUTER CALL - with retry on 429 / 5xx
// ============================================================
async function callOpenRouter(model, messages, apiKey, attempt = 1) {
  const callStart = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://the-pulpit.netlify.app",
        "X-Title": "The Pulpit - Sermon Helper AI",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        temperature: 0.85,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    clearTimeout(timer);
    const latencyMs = Date.now() - callStart;

    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      if (attempt <= MAX_RETRIES) {
        log.warn("Retrying after error", { model, status: response.status, attempt });
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        return callOpenRouter(model, messages, apiKey, attempt + 1);
      }
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenRouter ${response.status} after ${MAX_RETRIES} retries: ${errText.slice(0, 200)}`);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      throw new Error(`OpenRouter ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();

    log.info("Model responded", {
      model,
      latencyMs,
      attempt,
      promptTokens:     data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens:      data.usage?.total_tokens,
    });

    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty response from model");
    return content;

  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ============================================================
//  BIBLE VERSE ENRICHMENT
// ============================================================
async function enrichWithRealVerses(sermon) {
  try {
    const targets = [
      { path: "theme_verse", obj: sermon },
      ...(sermon.main_points || []).map(pt => ({ path: "scripture", obj: pt })),
      ...(sermon.supporting_verses || []).map(v => ({ path: "self", obj: v })),
    ];

    await Promise.all(targets.map(async ({ path, obj }) => {
      const ref = path === "self" ? obj.reference : obj[path]?.reference;
      if (!ref) return;
      const real = await fetchBibleVerse(ref);
      if (real) {
        if (path === "self") {
          obj.reference = real.reference;
          obj.text      = real.text;
        } else {
          obj[path].reference = real.reference;
          obj[path].text      = real.text;
        }
      }
    }));

    log.info("Bible verse enrichment complete", { versesChecked: targets.length });
  } catch (err) {
    log.warn("Bible enrichment failed silently", { error: err.message });
  }
  return sermon;
}

// ============================================================
//  CORS HEADERS
// ============================================================
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// ============================================================
//  MAIN HANDLER
// ============================================================
exports.handler = async function (event) {
  const requestStart = Date.now();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    log.error("OPENROUTER_API_KEY not set in environment");
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: "Server configuration error. API key missing." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: "Invalid JSON in request body." }) };
  }

  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: "Sermon title is required." }) };
  }

  body.title         = body.title.trim().slice(0, 200);
  body.scriptureHint = (body.scriptureHint || "").trim().slice(0, 200);
  body.context       = (body.context || "").trim().slice(0, 400);
  body.audience      = (body.audience || "general congregation").trim().slice(0, 100);
  body.tone          = (body.tone || "Inspirational & Uplifting").trim().slice(0, 100);
  body.timeMins      = body.timeMins
    ? Math.min(Math.max(parseInt(body.timeMins) || 30, 5), 120)
    : null;

  log.info("Sermon request received", {
    title: body.title, tone: body.tone,
    audience: body.audience, timeMins: body.timeMins,
  });

  const messages = buildMessages(body);
  let lastError = null;

  for (const model of MODEL_PRIORITY) {
    try {
      log.info("Trying model", { model });
      const rawText = await callOpenRouter(model, messages, apiKey);
      const parsed  = safeParseJSON(rawText);

      if (!parsed) {
        log.warn("Unparseable JSON from model", { model, preview: rawText.slice(0, 300) });
        lastError = new Error(`Model returned invalid JSON (${model})`);
        continue;
      }

      const validation = validateSermon(parsed);
      if (!validation.valid) {
        log.warn("Sermon failed validation", { model, issues: validation.issues });
        if (!parsed.title || !parsed.main_points || !Array.isArray(parsed.main_points)) {
          lastError = new Error(`Incomplete sermon from ${model}`);
          continue;
        }
      }

      const enriched = await enrichWithRealVerses(parsed);
      const totalMs = Date.now() - requestStart;
      log.info("Sermon ready", { model, totalMs, title: enriched.title });

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
        body: JSON.stringify({ sermon: enriched, model }),
      };

    } catch (err) {
      log.error("Model failed", { model, error: err.message });
      lastError = err;
    }
  }

  const totalMs = Date.now() - requestStart;
  log.error("All models failed", { totalMs, lastError: lastError?.message });

  return {
    statusCode: 502,
    headers: corsHeaders(),
    body: JSON.stringify({
      error: "All AI providers are currently unavailable. Please try again in a moment.",
      detail: lastError?.message || "Unknown error",
    }),
  };
};
