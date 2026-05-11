// ============================================================
//  The Pulpit — Sermon Helper AI
//  Netlify Serverless Function: generate-sermon.js
//
//  This function is the ONLY place the API key lives.
//  The frontend never sees it. All AI calls go through here.
//
//  Primary provider : OpenRouter (https://openrouter.ai)
//  Fallback model   : deepseek/deepseek-chat-v3-0324
//  Preferred model  : anthropic/claude-sonnet-4
//
//  Environment variable required (set in Netlify dashboard):
//    OPENROUTER_API_KEY=sk-or-v1-...
// ============================================================

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// Model priority list — first available/successful wins
const MODEL_PRIORITY = [
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-r1:free",
  "mistralai/mistral-7b-instruct:free",
];

// Request timeout in milliseconds
const TIMEOUT_MS = 55000; // Netlify functions max out at 60s

// ── Helpers ──────────────────────────────────────────────────

/**
 * Strips markdown code fences and trims whitespace from a string.
 * Handles: ```json ... ```, ``` ... ```, and raw JSON.
 */
function stripMarkdown(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/**
 * Attempts to parse JSON safely, returning null on failure.
 */
function safeParseJSON(text) {
  const cleaned = stripMarkdown(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find a JSON object inside the text as last resort
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Validates that the parsed sermon object has the required fields.
 * Returns { valid: true } or { valid: false, missing: [...] }
 */
function validateSermon(obj) {
  const required = [
    "title",
    "theme_verse",
    "introduction",
    "background_context",
    "main_points",
    "supporting_verses",
    "conclusion",
    "altar_call",
    "closing_prayer",
    "preacher_notes",
  ];
  const missing = required.filter((k) => !(k in obj));
  return missing.length === 0
    ? { valid: true }
    : { valid: false, missing };
}

/**
 * Builds the full system + user prompt payload for OpenRouter.
 */
function buildMessages(body) {
  const {
    title,
    tone = "Inspirational & Uplifting",
    audience = "general congregation",
    scriptureHint = "",
    context = "",
    timeMins = null,
  } = body;

  const timeInstr = timeMins
    ? `Structure the sermon for approximately ${timeMins} minutes. Add estimated_minutes per section.`
    : "";
  const scriptureInstr = scriptureHint
    ? `Incorporate these scriptures where fitting: ${scriptureHint}.`
    : "";
  const contextInstr = context ? `Additional context: ${context}` : "";

  const systemPrompt = `You are a deeply anointed, Spirit-filled sermon writer and theologian with 40 years of pastoral experience.
You write sermons that are HUMANIZED — warm, emotionally intelligent, conversational, deeply touching, and rooted firmly in Scripture.
Your words break through hearts, bring tears of conviction, and lift broken spirits.
You draw from rich biblical scholarship but speak in a way that the everyday person in the pew can feel in their bones.
CRITICAL: Return ONLY valid JSON. No markdown. No backticks. No preamble. No explanation. Raw JSON only.`;

  const userPrompt = `Write a complete, production-ready sermon for the following:

SERMON TITLE: "${title}"
TONE: ${tone}
TARGET AUDIENCE: ${audience}
${scriptureInstr}
${contextInstr}
${timeInstr}

Return ONLY this exact JSON structure (no markdown, no backticks, raw JSON only):
{
  "title": "Final sermon title",
  "theme_verse": { "reference": "Book Chapter:Verse", "text": "Full verse text" },
  "introduction": {
    "hook": "A powerful 2-3 sentence opening that grabs the heart",
    "problem_statement": "What struggle or need this sermon addresses",
    "thesis": "The central truth this sermon declares",
    "estimated_minutes": 5
  },
  "background_context": {
    "historical": "Brief biblical/historical context for the theme",
    "why_it_matters_today": "How this truth is urgently relevant today",
    "estimated_minutes": 3
  },
  "main_points": [
    {
      "number": 1,
      "title": "Point title",
      "scripture": { "reference": "Reference", "text": "Verse text" },
      "exposition": "Deep, touching 3-4 paragraph explanation. Be vulnerable, real, human.",
      "illustration": "A relatable story or analogy that brings this point alive",
      "application": "Specific, practical instruction — what does the listener DO?",
      "estimated_minutes": 7
    },
    {
      "number": 2,
      "title": "Point title",
      "scripture": { "reference": "Reference", "text": "Verse text" },
      "exposition": "Deep, touching exposition. Speak to real pain and real hope.",
      "illustration": "Relatable illustration or story",
      "application": "Practical application",
      "estimated_minutes": 7
    },
    {
      "number": 3,
      "title": "Point title",
      "scripture": { "reference": "Reference", "text": "Verse text" },
      "exposition": "Deep, touching exposition. Touch the heart.",
      "illustration": "Relatable illustration or story",
      "application": "Practical application",
      "estimated_minutes": 7
    }
  ],
  "supporting_verses": [
    { "reference": "Reference", "text": "Verse text", "purpose": "Why this verse supports the message" },
    { "reference": "Reference", "text": "Verse text", "purpose": "Why this verse supports the message" },
    { "reference": "Reference", "text": "Verse text", "purpose": "Why this verse supports the message" },
    { "reference": "Reference", "text": "Verse text", "purpose": "Why this verse supports the message" }
  ],
  "conclusion": {
    "summary": "Powerful 2-3 sentence recap of the sermon's heart",
    "call_to_action": "Direct, compassionate, emotionally resonant call to decision",
    "closing_illustration": "A brief, moving story or image that seals the message",
    "estimated_minutes": 4
  },
  "altar_call": "Warm, Spirit-filled invitation for hearts to respond — speak one-on-one to the soul.",
  "closing_prayer": "Heartfelt pastoral prayer covering the congregation with blessing and sending them out in faith.",
  "preacher_notes": [
    "Practical delivery tip 1",
    "Practical delivery tip 2",
    "Practical delivery tip 3",
    "Practical delivery tip 4"
  ],
  "total_estimated_minutes": 35
}

IMPORTANT: Every exposition, illustration, and prayer must be DEEPLY HUMANIZED. Speak to real pain, real hope, real life. Do not be generic. Touch the heart.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

/**
 * Calls OpenRouter with a given model and messages.
 * Returns the raw response text or throws on failure.
 */
async function callOpenRouter(model, messages, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://the-pulpit.netlify.app", // update with your actual domain
        "X-Title": "The Pulpit - Sermon Helper AI",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        temperature: 0.85,
        messages,
      }),
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      throw new Error(`OpenRouter ${response.status}: ${errText}`);
    }

    const data = await response.json();

    // OpenRouter returns choices[0].message.content like OpenAI
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty response from model");

    return content;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Main Handler ──────────────────────────────────────────────

exports.handler = async function (event) {
  // ── CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  // ── Only accept POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // ── Read API key from environment (NEVER from frontend)
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[The Pulpit] OPENROUTER_API_KEY is not set.");
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        error: "Server configuration error. API key is not set.",
      }),
    };
  }

  // ── Parse request body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Invalid JSON in request body." }),
    };
  }

  // ── Validate required fields
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Sermon title is required." }),
    };
  }

  // Sanitise inputs — strip anything suspiciously long
  body.title = body.title.slice(0, 200);
  body.scriptureHint = (body.scriptureHint || "").slice(0, 200);
  body.context = (body.context || "").slice(0, 500);
  body.audience = (body.audience || "general congregation").slice(0, 100);
  body.tone = (body.tone || "Inspirational & Uplifting").slice(0, 100);
  body.timeMins = body.timeMins
    ? Math.min(Math.max(parseInt(body.timeMins) || 30, 5), 120)
    : null;

  const messages = buildMessages(body);

  // ── Try each model in priority order
  let lastError = null;
  for (const model of MODEL_PRIORITY) {
    try {
      console.log(`[The Pulpit] Trying model: ${model}`);
      const rawText = await callOpenRouter(model, messages, apiKey);
      const parsed = safeParseJSON(rawText);

      if (!parsed) {
        console.warn(`[The Pulpit] Model ${model} returned unparseable JSON. Raw:`, rawText.slice(0, 300));
        lastError = new Error(`Model returned invalid JSON (${model})`);
        continue; // try next model
      }

      const validation = validateSermon(parsed);
      if (!validation.valid) {
        console.warn(`[The Pulpit] Sermon missing fields: ${validation.missing.join(", ")}`);
        // Still return it — frontend can handle partial data gracefully
      }

      console.log(`[The Pulpit] Success with model: ${model}`);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ sermon: parsed, model }),
      };
    } catch (err) {
      console.warn(`[The Pulpit] Model ${model} failed: ${err.message}`);
      lastError = err;
      // Continue to next model
    }
  }

  // ── All models failed
  console.error("[The Pulpit] All models failed. Last error:", lastError?.message);
  return {
    statusCode: 502,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      error:
        "All AI providers are currently unavailable. Please try again in a moment.",
      detail: lastError?.message || "Unknown error",
    }),
  };
};
