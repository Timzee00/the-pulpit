# ✝ The Pulpit — Sermon Helper AI

> *"Preach the word; be ready in season and out of season." — 2 Timothy 4:2*

A production-grade AI sermon generator built by Timzee Tech.  
Secure, deployable on Netlify, powered by OpenRouter.

---

## Project Structure

```
the-pulpit/
├── public/
│   └── index.html               ← The complete frontend (UI, rendering, history)
├── netlify/
│   └── functions/
│       ├── generate-sermon.js   ← Sermon generation + translation + Scripture enrichment
│       ├── bible.js              ← Secure API.Bible catalog/passage proxy
├── netlify.toml                 ← Netlify build & routing config
├── .env.example                 ← Template for local environment variables
├── .gitignore                   ← Protects .env from being committed
└── README.md                    ← This file
```

---

## How the Security Architecture Works

```
Browser (index.html)
       │
       │  POST /api/generate-sermon
       │  { title, tone, audience, ... }   ← NO API key
       ▼
Netlify Function (generate-sermon.js)
       │
       │  Reads OPENROUTER_API_KEY from environment
       │  POST https://openrouter.ai/api/v1/chat/completions
       ▼
OpenRouter API  →  claude-sonnet-4 / grok-3 / deepseek
       │
       ▼
Netlify Function parses + validates JSON
       │
       ▼
Browser receives { sermon: {...}, model: "..." }
```

**The API key never touches the browser. Ever.**

---

## Deployment — Step by Step

### 1. Get an OpenRouter API Key

1. Go to [openrouter.ai](https://openrouter.ai)
2. Create a free account
3. Go to **Keys** → **Create Key**
4. Copy the key (starts with `sk-or-v1-...`)

### 2. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit — The Pulpit"
git remote add origin https://github.com/YOUR_USERNAME/the-pulpit.git
git push -u origin main
```

> Make sure `.gitignore` is committed. The `.env` file must NOT be pushed.

### 3. Deploy on Netlify

1. Go to [netlify.com](https://netlify.com) → **Add new site** → **Import from Git**
2. Connect your GitHub repo
3. Netlify will auto-detect `netlify.toml`
4. Build settings will be:
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions`
5. Click **Deploy site**

### 4. Set the Environment Variable

1. In Netlify: **Site Settings** → **Environment Variables**
2. Click **Add a variable**
3. Set:
   - **Key:** `OPENROUTER_API_KEY`
   - **Value:** `sk-or-v1-your-actual-key`
4. Click **Save**
5. Go to **Deploys** → **Trigger deploy** → **Deploy site**

That's it. Your site is live and secure.

---

## Local Development

To run locally with Netlify Dev:

```bash
# Install Netlify CLI globally
npm install -g netlify-cli

# Create your local .env file
cp .env.example .env
# Edit .env and paste your real key

# Run the local dev server
netlify dev
```

Netlify Dev will:
- Serve your `public/` folder
- Run your function at `/.netlify/functions/generate-sermon`
- Proxy `/api/generate-sermon` correctly via `netlify.toml`

---

## Changing the AI Model

Open `netlify/functions/generate-sermon.js` and edit `MODEL_PRIORITY`:

```js
const MODEL_PRIORITY = [
  "anthropic/claude-sonnet-4",   // Try this first
  "x-ai/grok-3-beta",            // Fallback 1
  "deepseek/deepseek-chat-v3-0324", // Fallback 2
];
```

The function tries each model in order until one succeeds.  
See all available models at [openrouter.ai/models](https://openrouter.ai/models).

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes* | OpenRouter fallback/generation key |
| `GROQ_API_KEY` | Yes* | Groq fallback/generation key |
| `BIBLE_API_KEY` | Recommended | API.Bible access for verified Yoruba/Hausa/Igbo Scripture |
| `AZURE_TRANSLATOR_KEY` | Recommended | Primary NMT translation engine |
| `AZURE_TRANSLATOR_REGION` | Recommended | Azure Translator resource region |
| `ELEVENLABS_API_KEY` | Optional | Yoruba/Hausa/Igbo read-aloud fallback |
| `PULPITPEDIA_RESEARCH_MODEL` | Optional | OpenRouter model used for constrained Pulpitpedia research synthesis |

---

## Built by

**Timzee Tech** — Lagos, Nigeria  
Independent developer. TIMA. The Pulpit. Pushing limits on mobile hardware.


## Nigerian Language and Bible Support

The language system supports English, Yoruba, Hausa, and Igbo. Sermon translations use Azure Translator when configured, with the existing LLM providers as fallback. Yoruba, Hausa, and Igbo are currently supported by Microsoft Translator.

Bible editions are **not hard-coded**. The Bible proxy asks API.Bible for the editions authorized for your API key and exposes the available Yoruba (`yor`), Hausa (`hau`), and Igbo (`ibo`) editions to the frontend. This prevents stale Bible IDs from silently breaking Scripture lookup. API.Bible also provides the version copyright statement that the UI displays with Scripture.

For API.Bible usage and edition availability, see the official documentation: https://scripture.api.bible/docs

Important: API.Bible's current Starter plan is strictly non-commercial. If The Pulpit will be commercial, use an API.Bible plan/permission appropriate to that use and comply with each Bible version's copyright requirements.

## Pulpitpedia

The Pulpit now includes a curated Pulpitpedia reference section covering biblical subjects, biblical history, ancient texts, textual history, archaeology, Christian history, medieval Christianity, and later traditions.

### Source discipline

Pulpitpedia deliberately labels entries by evidence/status, including:

- Canonical Scripture
- Historical event/figure
- Ancient Jewish or Christian literature
- Textual history
- Later tradition/legend
- Scholarly classification

It does not present later books, folklore, occult literature, or internet claims as additional books of the Bible. Entries link to external reference sources instead of reproducing copyrighted source material.

The initial index is intentionally curated rather than pretending to be an exhaustive encyclopedia. A future research layer can be added without weakening this source-labeling model.


## Pulpitpedia research layer

Pulpitpedia has two deliberately separate layers:

1. **Curated entries** — reviewed, application-owned reference records.
2. **Research mode** — discovers external reference records from Wikimedia/Wikipedia and the Library of Congress, then optionally asks the configured OpenRouter model to synthesize only the returned source descriptions.

Research mode is not presented as infallible. It explicitly distinguishes source types and tells the user when evidence is insufficient. It must not be used to turn later tradition, occult literature, folklore, or speculative claims into Scripture.

The research function is server-side; no AI key is exposed to the browser.

## Production hardening in this release

- Bible catalog requests are cached per function instance and fetched independently so one unavailable language does not hide the others.
- Bible API calls have input validation and request timeouts.
- Bible edition metadata is retrieved from API.Bible instead of relying on guessed edition IDs.
- Pulpitpedia research uses Wikimedia, Library of Congress, and Internet Archive discovery, with short-lived server-side caching.
- Pulpitpedia synthesis is constrained to returned source metadata and explicitly separates Scripture, history, tradition, folklore, occult literature, and uncertainty.
- Research-provider JSON parsing has a safe fallback for models that return fenced or wrapped JSON.
- A `/api/health` endpoint is included for deployment checks.
- `npm test` performs a syntax/smoke audit of every Netlify function and the frontend JavaScript and checks the frontend for obvious API-key exposure.

## Important licensing note

API.Bible's current Starter plan is strictly non-commercial and has a 5,000-call monthly allowance. A commercial public launch should use an API.Bible plan/license that permits the intended use, or use appropriately licensed/public-domain/Creative Commons Scripture editions. Do not redistribute copyrighted Bible text beyond the applicable license.

## Deployment verification

After deploying, check:

1. `/api/health` returns `ok: true`.
2. Bible catalog loads without exposing `BIBLE_API_KEY` to the browser.
3. Yoruba, Hausa, and Igbo entries appear only when your API.Bible account actually authorizes editions for those languages.
4. Pulpitpedia returns source records even when AI synthesis is unavailable.
5. `npm test` passes before pushing a release.

## Versiah — Scripture companion

The Pulpit now includes **Versiah**, a standalone Scripture-grounded AI companion at `/versiah.html`. Users can bring a personal question, choose Talk / Study Scripture / Pray, and receive an AI response grounded in Bible passages that are verified server-side before being shown.

Versiah reuses the existing `GROQ_API_KEY` and `OPENROUTER_API_KEY` environment variables. It uses the World English Bible (WEB) through `bible-api.com` for verified Scripture text, avoiding redistribution of copyrighted Bible translations. Conversation history is stored locally in the user's browser; messages are sent to the secure Netlify function for processing.

### Featuring Versiah on another site

The repository includes `public/versiah-widget.js`, a small embeddable feature card intended for partner or feature sites such as LagosLife. It opens the standalone companion in a new tab instead of using an iframe, so the existing `X-Frame-Options: DENY` security policy can remain in place.

Example:

```html
<div id="versiah-feature"></div>
<script src="https://YOUR-PULPIT-DOMAIN/versiah-widget.js" data-target="#versiah-feature"></script>
```

Replace `YOUR-PULPIT-DOMAIN` with the live Pulpit domain. No AI key is exposed to the embedding site.
