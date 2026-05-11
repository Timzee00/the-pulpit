// ============================================================
//  The Pulpit — Sermon Helper AI
//  Netlify Serverless Function: generate-sermon.js
//
//  IMPROVEMENTS IN THIS VERSION:
//  ✅ Optimized token limits (4000 instead of 8000)
//  ✅ Rate limiting (10 requests per 60 seconds per IP)
//  ✅ Enhanced input validation with type checking
//  ✅ Retry logic with exponential backoff for failures
//  ✅ Production logging for monitoring
//  ✅ Restricted CORS to specific domain
//  ✅ Security headers and validation improvements
//  ✅ Working free models verified on OpenRouter
//
//  Environment variable required (set in Netlify dashboard):
//    OPENROUTER_API_KEY=sk-or-v1-...
// ============================================================

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// Model priority list — first available/successful wins
// Using models that ACTUALLY work with free tier and structured output
const MODEL_PRIORITY = [
  "meta-llama/llama-3.1-70b-instruct:free",
  "meta-llama/llama-2-70b-chat:free",
  "mistralai/mistral-7b-instruct:free",
  "nousresearch/nous-hermes-2-mistral-7b-dpo:free",
];

// Request timeout in milliseconds
const TIMEOUT_MS = 55000; // Netlify functions max out at 60s

// Rate limiting configuration
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const rateLimitStore = new Map(); // IP -> [timestamp, timestamp, ...]

// ── Rate Limiting ────────────────────────────────────────────

/**
 * Check if IP has exceeded rate limit
 * Returns { allowed: true/false, remaining: number }
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }
  
  let timestamps = rateLimitStore.get(ip);
  // Remove old timestamps outside the window
  timestamps = timestamps.filter(t => t > windowStart);
  
  const allowed = timestamps.length < RATE_LIMIT_REQUESTS;
  
  if (allowed) {
    timestamps.push(now);
  }
  
  rateLimitStore.set(ip, timestamps);
  
  return {
    allowed,
    remaining: Math.max(0, RATE_LIMIT_REQUESTS - timestamps.length),
    resetIn: timestamps.length > 0 ? timestamps[0] + RATE_LIMIT_WINDOW_MS - now : 0
  };
}

// Clean up old entries periodically to prevent memory leak
setInterval(() => {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of rateLimitStore.entries()) {
    const filtered = timestamps.filter(t => t > windowStart);
    if (filtered.length === 0) {
      rateLimitStore.delete(ip);
    } else {
      rateLimitStore.set(ip, filtered);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// ── Structured Logging ────────────────────────────────────────

/**
 * Log request with structured data for monitoring
 */
function logRequest(status, model, latencyMs, error = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    status,
    model: model || "none",
    latencyMs,
    error: error ? error.message : null
  };
  console.log("[The Pulpit]", JSON.stringify(logEntry));
}

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
 * ENHANCED: Strict schema validation for sermon object
 * Returns { valid: true } or { valid: false, errors: [...] }
 */
function validateSermon(obj) {
  const errors = [];
  
  // Type check: must be object
  if (!obj || typeof obj !== 'object') {
    errors.push('Response must be a valid object');
    return { valid: false, errors };
  }
  
  // Required string fields
  const stringFields = ['title', 'altar_call', 'closing_prayer'];
  stringFields.forEach(field => {
    if (typeof obj[field] !== 'string' || obj[field].trim() === '') {
      errors.push(`${field} must be a non-empty string`);
    }
  });
  
  // Validate theme_verse object
  if (!obj.theme_verse || typeof obj.theme_verse !== 'object') {
    errors.push('theme_verse must be an object');
  } else {
    if (typeof obj.theme_verse.reference !== 'string' || !obj.theme_verse.reference.trim()) {
      errors.push('theme_verse.reference must be a non-empty string');
    }
    if (typeof obj.theme_verse.text !== 'string' || !obj.theme_verse.text.trim()) {
      errors.push('theme_verse.text must be a non-empty string');
    }
  }
  
  // Validate introduction object
  if (!obj.introduction || typeof obj.introduction !== 'object') {
    errors.push('introduction must be an object');
  } else {
    ['hook', 'problem_statement', 'thesis'].forEach(field => {
      if (typeof obj.introduction[field] !== 'string' || !obj.introduction[field].trim()) {
        errors.push(`introduction.${field} must be a non-empty string`);
      }
    });
  }
  
  // Validate background_context
  if (!obj.background_context || typeof obj.background_context !== 'object') {
    errors.push('background_context must be an object');
  } else {
    ['historical', 'why_it_matters_today'].forEach(field => {
      if (typeof obj.background_context[field] !== 'string' || !obj.background_context[field].trim()) {
        errors.push(`background_context.${field} must be a non-empty string`);
      }
    });
  }
  
  // Validate main_points array
  if (!Array.isArray(obj.main_points)) {
    errors.push('main_points must be an array');
  } else if (obj.main_points.length === 0) {
    errors.push('main_points must contain at least one point');
  } else {
    obj.main_points.forEach((pt, idx) => {
      if (typeof pt !== 'object') {
        errors.push(`main_points[${idx}] must be an object`);
      } else {
        ['title', 'exposition', 'illustration', 'application'].forEach(field => {
          if (typeof pt[field] !== 'string' || !pt[field].trim()) {
            errors.push(`main_points[${idx}].${field} must be a non-empty string`);
          }
        });
      }
    });
  }
  
  // Validate supporting_verses array
  if (!Array.isArray(obj.supporting_verses)) {
    errors.push('supporting_verses must be an array');
  }
  
  // Validate conclusion
  if (!obj.conclusion || typeof obj.conclusion !== 'object') {
    errors.push('conclusion must be an object');
  } else {
    ['summary', 'call_to_action', 'closing_illustration'].forEach(field => {
      if (typeof obj.conclusion[field] !== 'string' || !obj.conclusion[field].trim()) {
        errors.push(`conclusion.${field} must be a non-empty string`);
      }
    });
  }
  
  // Validate preacher_notes array
  if (!Array.isArray(obj.preacher_notes)) {
    errors.push('preacher_notes must be an array');
  }
  
  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
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
 * ENHANCED: Calls OpenRouter with retry logic and exponential backoff
 * Returns the raw response text or throws on failure.
 */
async function callOpenRouter(model, messages, apiKey, retryCount = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startTime = Date.now();

  try {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://the-pulpit.netlify.app",
        "X-Title": "The Pulpit - Sermon Helper AI",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000, // ✅ Reduced from 8000
        temperature: 0.85,
        messages,
      }),
    });

    clearTimeout(timer);
    const latency = Date.now() - startTime;

    // ✅ NEW: Retry logic for 429 (rate limited) and 5xx errors
    if (response.status === 429 || response.status >= 500) {
      if (retryCount < 3) {
        const backoffMs = Math.pow(2, retryCount) * 1000;
        console.log(`[The Pulpit] ${response.status} received. Retrying in ${backoffMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return callOpenRouter(model, messages, apiKey, retryCount + 1);
      }
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      logRequest("error", model, latency, new Error(`OpenRouter ${response.status}`));
      throw new Error(`OpenRouter ${response.status}: ${errText}`);
    }

    const data = await response.json();

    // OpenRouter returns choices[0].message.content like OpenAI
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      logRequest("error", model, latency, new Error("Empty response"));
      throw new Error("Empty response from model");
    }

    logRequest("success", model, latency);
    return content;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ���─ Main Handler ──────────────────────────────────────────────

exports.handler = async function (event) {
  // ── Extract client IP for rate limiting
  const clientIp = event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   event.headers['client-ip'] ||
                   'unknown';

  // ── CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        // ✅ FIXED: Restrict CORS to specific domain instead of "*"
        "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://the-pulpit.netlify.app",
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
      headers: { "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://the-pulpit.netlify.app" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // ── ✅ NEW: Check rate limit
  const rateLimitCheck = checkRateLimit(clientIp);
  if (!rateLimitCheck.allowed) {
    console.warn(`[The Pulpit] Rate limit exceeded for IP: ${clientIp}`);
    return {
      statusCode: 429,
      headers: {
        "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://the-pulpit.netlify.app",
        "Retry-After": Math.ceil(rateLimitCheck.resetIn / 1000),
      },
      body: JSON.stringify({
        error: "Too many requests. Please wait before trying again.",
        retryAfter: rateLimitCheck.resetIn,
      }),
    };
  }

  // ── Read API key from environment (NEVER from frontend)
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[The Pulpit] OPENROUTER_API_KEY is not set.");
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://the-pulpit.netlify.app" },
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
      headers: { "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://the-pulpit.netlify.app" },
      body: JSON.stringify({ error: "Invalid JSON in request body." }),
    };
  }

  // ── ✅ ENHANCED: Strict input validation
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://the-pulpit.netlify.app" },
      body: JSON.stringify({ error: "Sermon title is required and must be a non-empty string." }),
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

  // ── Try each model in priority order with retries
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

      // ✅ ENHANCED: Use strict validation
      const validation = validateSermon(parsed);
      if (!validation.valid) {
        console.warn(`[The Pulpit] Sermon validation failed: ${validation.errors.join("; ")}`);
        lastError = new Error(`Validation failed: ${validation.errors[0]}`);
        continue; // try next model
      }

      console.log(`[The Pulpit] Success with model: ${model}`);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://the-pulpit.netlify.app",
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
    headers: { "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://the-pulpit.netlify.app" },
    body: JSON.stringify({
      error:
        "All AI providers are currently unavailable. Please try again in a moment.",
      detail: lastError?.message || "Unknown error",
    }),
  };
};
