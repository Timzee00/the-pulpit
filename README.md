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
│       └── generate-sermon.js   ← Secure serverless function (API key lives here only)
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
| `OPENROUTER_API_KEY` | ✅ Yes | Your OpenRouter API key |

---

## Built by

**Timzee Tech** — Lagos, Nigeria  
Independent developer. TIMA. The Pulpit. Pushing limits on mobile hardware.
