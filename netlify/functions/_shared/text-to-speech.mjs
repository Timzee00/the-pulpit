import { protect } from './access.mjs';
// ============================================================
//  Netlify Function: text-to-speech.js | Version 1.0
//
//  Generates spoken audio via ElevenLabs. Used specifically for
//  Yoruba/Hausa/Igbo, where the browser's built-in Web Speech API
//  (used for English, for free) mostly has no native voice at all.
//
//  Needs ELEVENLABS_API_KEY (free tier: ~10K characters/month — small,
//  so this is deliberately only called for the three languages that
//  actually need it, not for English).
//
//  Optional per-language voice overrides:
//    ELEVENLABS_VOICE_ID_YO, ELEVENLABS_VOICE_ID_HA, ELEVENLABS_VOICE_ID_IG
//  Falls back to ELEVENLABS_VOICE_ID, then to a default public voice if
//  none are set. ElevenLabs doesn't sell dedicated "Yoruba/Hausa/Igbo"
//  voices — its multilingual model reads whatever language the text is
//  in with one of its general voices — so it's worth trying a few voice
//  IDs from your ElevenLabs dashboard and picking whichever pronounces
//  these languages best, rather than trusting the default blindly.
// ============================================================

const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID    = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs' well-known "Rachel" demo voice — UNVERIFIED for Yoruba/Hausa/Igbo quality, swap via env var once you've tested alternatives in your dashboard
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || "*";
const MAX_CHARS_PER_CALL   = 2500; // keep each request well within latency/quota comfort
const TIMEOUT_MS           = 20000;

const VOICE_ID_BY_LANG = {
  yo: process.env.ELEVENLABS_VOICE_ID_YO || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
  ha: process.env.ELEVENLABS_VOICE_ID_HA || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
  ig: process.env.ELEVENLABS_VOICE_ID_IG || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function respondJSON(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(obj),
  };
}

const run = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return respondJSON(405, { error: "Method not allowed." });
  }

  const denied = await protect(event, { cost: 3 });
  if (denied) return denied;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return respondJSON(501, { error: "Voice reading isn't configured yet (missing ELEVENLABS_API_KEY)." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return respondJSON(400, { error: "Invalid request body." }); }

  if (!body || typeof body.text !== "string" || typeof body.lang !== "string") return respondJSON(400,{error:"Text and language are required."});
  const text = (body.text || "").trim();
  const lang = (body.lang || "").trim();

  if (!text) return respondJSON(400, { error: "text is required." });
  if (text.length > MAX_CHARS_PER_CALL) {
    return respondJSON(400, { error: `Text too long for one request (max ${MAX_CHARS_PER_CALL} characters) — the frontend should be chunking this.` });
  }

  const voiceId = VOICE_ID_BY_LANG[lang] || DEFAULT_VOICE_ID;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {

    const res = await fetch(`${ELEVENLABS_ENDPOINT}/${voiceId}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "xi-api-key":    apiKey,
        "Content-Type":  "application/json",
        "Accept":        "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });


    if (!res.ok) {
      const t = await res.text().catch(() => "");
      // 401 on ElevenLabs commonly means quota exhausted, not just a bad key
      const status = res.status === 401 ? 429 : res.status;
      return respondJSON(status, { error: "Voice generation failed (the free quota may be used up for this month).",  });
    }

    const arrayBuffer = await res.arrayBuffer();
    const base64Audio  = Buffer.from(arrayBuffer).toString("base64");

    return {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg", ...corsHeaders() },
      body: base64Audio,
      isBase64Encoded: true,
    };
  } catch (err) {
    return respondJSON(502, { error: "Voice generation failed." });
  } finally { clearTimeout(timer); }
};

export {run};
export default {run};
