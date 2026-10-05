import { protect } from './access.mjs';
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const LOC_API = "https://www.loc.gov/search/";
const IA_API = "https://archive.org/advancedsearch.php";
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const researchCache = new Map();

const headers = () => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
});

const respond = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...headers() },
  body: JSON.stringify(body),
});

function cleanText(value, max = 700) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "ThePulpit/1.0 research; contact via project site", Accept: "application/json" }, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Reference service timed out.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`Reference service returned HTTP ${res.status}`);
  return data;
}

async function wikipediaSearch(q) {
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=6&format=json&origin=*`;
  const data = await fetchJson(url);
  const hits = Array.isArray(data?.query?.search) ? data.query.search : [];
  return hits.map(h => ({
    title: cleanText(h.title, 180),
    description: cleanText(h.snippet.replace(/<[^>]+>/g, " "), 500),
    type: "Secondary reference",
    publisher: "Wikimedia / Wikipedia",
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
  }));
}

async function locSearch(q) {
  const url = `${LOC_API}?q=${encodeURIComponent(q)}&fo=json&c=6`;
  const data = await fetchJson(url);
  const docs = Array.isArray(data?.results) ? data.results : [];
  return docs.map(d => ({
    title: cleanText(d.title || d.id || "Library of Congress record", 180),
    description: cleanText(Array.isArray(d.description) ? d.description.join(" ") : d.description, 500),
    type: "Library / archival record",
    publisher: "Library of Congress",
    url: d.id || "https://www.loc.gov/",
  }));
}

async function archiveSearch(q) {
  const params = new URLSearchParams({
    q: `title:(${q}) OR description:(${q})`,
    fl: "identifier,title,description,creator,date",
    rows: "6",
    output: "json",
  });
  const data = await fetchJson(`${IA_API}?${params}`);
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
  return docs.map(d => ({
    title: cleanText(d.title || d.identifier || "Internet Archive record", 180),
    description: cleanText(d.description, 500),
    type: "Digital library record",
    publisher: "Internet Archive",
    url: d.identifier ? `https://archive.org/details/${encodeURIComponent(d.identifier)}` : "https://archive.org/",
  }));
}

async function synthesize(query, sources) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || !sources.length) return null;
  const evidence = sources.map((s, i) => `[${i + 1}] ${s.title}\nPublisher: ${s.publisher}\nType: ${s.type}\nURL: ${s.url}\nDescription: ${s.description}`).join("\n\n");
  const prompt = `You are the evidence editor for The Pulpit, a Christian research application.\n\nTopic: ${query}\n\nUse ONLY the supplied source descriptions. Do not invent facts, citations, dates, quotations, or biblical claims. Distinguish canonical Scripture from later Jewish/Christian literature, historical scholarship, folklore, medieval tradition, occult literature, and modern speculation. If the supplied evidence is insufficient, say so. Never call a later work a biblical book. Return strict JSON with keys: summary (string), distinctions (array of strings), caution (string). Keep the summary concise and factual.\n\nSOURCES:\n${evidence}`;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.PULPITPEDIA_RESEARCH_MODEL || "openrouter/free",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 900,
      response_format: { type: "json_object" },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Research synthesis failed (${res.status})`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Research provider returned invalid JSON."); }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    const match = String(content).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

const run = async (event) => {
  if (event.httpMethod === "OPTIONS") return respond(204, {});
  if (event.httpMethod !== "GET") return respond(405, { error: "Method not allowed." });
  const denied = await protect(event, { cost: 1 });
  if (denied) return denied;
  const q = String(event.queryStringParameters?.q || "").trim().slice(0, 160);
  if (!q) return respond(400, { error: "A research topic is required." });

  try {
    const cached = researchCache.get(q.toLowerCase());
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return respond(200, cached.value);
    const settled = await Promise.allSettled([wikipediaSearch(q), locSearch(q), archiveSearch(q)]);
    const wiki = settled[0].status === "fulfilled" ? settled[0].value : [];
    const loc = settled[1].status === "fulfilled" ? settled[1].value : [];
    const archive = settled[2].status === "fulfilled" ? settled[2].value : [];
    const seen = new Set();
    const sources = [...wiki, ...loc, ...archive].filter(s => /^https?:\/\//i.test(s.url || "") && !seen.has(s.url) && seen.add(s.url)).slice(0, 10);
    const answer = await synthesize(q, sources).catch(err => {
      console.error("[pedia-research] synthesis:", err.message);
      return null;
    });
    const value = {
      query: q,
      answer,
      sources,
      methodology: "External source discovery from Wikimedia, Library of Congress, and Internet Archive; synthesis is constrained to returned source descriptions and explicitly labels uncertainty.",
    };
    if (researchCache.size >= 100) researchCache.delete(researchCache.keys().next().value);
    researchCache.set(q.toLowerCase(), { value, at: Date.now() });
    return respond(200, value);
  } catch (err) {
    console.error("[pedia-research] error:", err.message);
    return respond(502, { error: "Research sources are temporarily unavailable." });
  }
};

export {run};
export default {run};
