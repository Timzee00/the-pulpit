# The Pulpit — Scripture for study, teaching and everyday life

Built by Timzee. Sermon preparation, Bible reading and notes, Pulpitpedia, and Versiah (Talk / Study Scripture / Pray). English, Yoruba, Hausa and Igbo explanations are AI-generated. Versiah's retrieved Scripture is World English Bible (WEB) English.

## Deploy on Netlify

1. Import `Timzee00/the-pulpit`. The repository config publishes `public`, bundles `netlify/functions` and runs `npm test` before publishing. Node 22 is pinned. Do not deploy only the public directory: the backend must be bundled too.
2. Choose your final HTTPS URL. Set `PUBLIC_SITE_URL` to exactly that origin in Netlify environment variables. The widget opens this whole site, not an iframe.
3. Add at least one of `GROQ_API_KEY` or `OPENROUTER_API_KEY`. Groq is primary; OpenRouter is fallback when both are present. Required keys must be valid, funded/within quota, and authorize the configured model. Model availability must be checked when deploying.
4. Create a Cloudflare Turnstile managed widget for your final hostname. Add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. The server checks success, hostname and action `pulpit_access`. Do not use dummy testing keys in production.
5. Create an Upstash Redis database. Add its REST URL and write token as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Keep it available for shared quotas and Scripture caching. Redis failures deny AI access rather than bypassing protection.
6. Generate a random signing secret (for example `openssl rand -hex 32`) and set `SESSION_SIGNING_SECRET`. At least 32 characters are required. Changing it invalidates existing guest cookies.
7. Set these variables in the **Functions scope**, for production and any preview context you intend to test. Secrets belong in Netlify UI/CLI/API, not `netlify.toml`, public JavaScript or Git. Redeploy after changing variables. A custom-domain change requires updating `PUBLIC_SITE_URL` and Turnstile's hostname.
8. Visit `/setup.html`. Missing configuration is listed without secret values. `/api/health` is configuration readiness, not proof of provider availability. Click **Run live AI check**, complete verification, then inspect the real answer and passages.
9. Run the checks below before promotion. Public traffic can consume your provider and hosting quotas. Set account-level spend caps/alerts and platform rate rules for both `/api/*` and `/.netlify/functions/*` in your hosting account; application limits do not prevent all invocation-level traffic.

No hosting deployment or live credential verification is performed by changing this repository.

## Public access controls

Visitor verification issues a signed HttpOnly Secure SameSite=Strict guest cookie lasting 15 minutes, bound to a hashed network identifier. It is a bot-control session, not a user account. Limits are atomic and shared through Redis across function instances. `PULPIT_REQUESTS_PER_MINUTE` defaults to 10 per network identifier; shared networks can hit this limit. `PULPIT_DAILY_BUDGET` defaults to 100 weighted units at 00:00 UTC: Versiah costs 2, sermons/voice 3, and research/licensed Bible calls 1. Failures also consume the reserved allowance. These are request allowances, not exact currency spend limits. Configure provider billing limits separately.

Direct function URLs receive the same application checks. An Origin allowlist is an additional browser check, not authorization. No API keys are delivered to the browser. The public Turnstile site key is intentionally visible. An emergency-support response can bypass paid provider access because it makes no provider call; this does not guarantee crisis detection in all wording/languages.

## Scripture and AI response discipline

Versiah selects at most three focused references, retrieves WEB passages, and caches them in Redis for seven days. Upstream misses share a rolling allowance of 12 calls per 30 seconds. Throttled/unavailable retrieval fails clearly. An empty reference selection does not replace the topic with unrelated verses. AI responses must cite evidence IDs; unknown IDs, direct quotations and explicit reference strings outside retrieved evidence are rejected. Study plans can use up to seven days and only retrieved passages.

Passage retrieval and citation validation do not establish the correctness of every explanation, interpretation, translation or emotional response. Read the original text in context. OpenRouter's free router can change the selected model; verify its outputs at deployment. Provider calls and verification have bounded timeouts. Unsupported `timeout=26` entries were removed: current Netlify synchronous functions have a documented 60-second platform limit, separate from application budgets.

## Optional features and licensing

Versiah uses WEB from https://bible-api.com, a public-domain translation served by an independently operated API. Public-domain text does not imply unlimited API service or an uptime guarantee. Attribution remains visible. Do not bulk-download Scripture through that endpoint. Source data/code are available from the provider if you later host the corpus yourself.

`BIBLE_API_KEY` enables optional Yoruba/Hausa/Igbo edition discovery only when `BIBLE_LICENSE_CONFIRMED=true`. Confirm the selected editions' copyright, attribution, usage, storage and commercial permissions, and your API.Bible plan, before enabling them. Record the plan and selected edition IDs in your private deployment records. API.Bible Starter is non-commercial; commercial access and each edition's rights need separate confirmation. Do not assume that access under an API key grants every right. See https://scripture.api.bible/signup and https://api.bible/terms-and-conditions.

Azure translation uses `AZURE_TRANSLATOR_KEY` and `AZURE_TRANSLATOR_REGION`; otherwise the existing AI translation fallback is used. Non-English voice needs `ELEVENLABS_API_KEY` and tested per-language voice IDs. Leave untested optional features disabled. Test pronunciation with native speakers before making quality claims.

## Release checks

- `npm test`: all function/frontend scripts plus backend regression tests, security negative cases, configuration readiness and widget behavior. These tests use mocks; they do not contact paid providers.
- `npm run verify:deploy -- https://YOUR-SITE.netlify.app`: verifies public pages/assets, health and unauthenticated endpoint protection without AI spend.
- `/setup.html` live check: verifies a real AI+Scripture round trip after human verification. Test with primary only and fallback only in separate preview contexts to establish each configured provider works.
- Test desktop and phone at 375px; refresh, language/mode changes, Enter/Shift+Enter, IME typing, failure/retry, optional history persistence, disabled storage, clear and export. Check developer console and actual CSP.
- Verify sermon generation, translation, Bible reading/notes, Pulpitpedia and enabled audio. Exercise provider outage, exhausted quota, Redis failure, expired cookies and failed Turnstile challenges.
- Review example answers and each advertised language with competent readers. No automated suite can certify theological or clinical safety.

## Featuring the whole site

A standard link to your production homepage is the simplest placement. The optional feature card also opens the whole site:

```html
<div id="pulpit-feature"></div>
<script src="https://YOUR-SITE.netlify.app/versiah-widget.js" data-target="#pulpit-feature"></script>
```

Optional `data-url` overrides the destination with an HTTP(S) URL. The partner's CSP must permit the script origin and widget styles. `X-Frame-Options: DENY` remains in place. No LagosLife placement, endorsement or affiliation is claimed.

## Development

```sh
npm test
cp .env.example .env
# Fill in development configuration; never commit .env.
netlify dev
```

Turnstile hostname and PUBLIC_SITE_URL checks use the configured production/preview HTTPS host. For end-to-end verification use a real deploy preview with its own configuration. Backend unit tests do not bypass access controls in deployed code. `versiah.mjs` is the modern Netlify entry point; core logic lives under `_shared`. All public APIs now use modern Request/Response entry points with the trusted Netlify context IP; core logic lives under `_shared`. Do not reintroduce a `versiah.js` file, which could shadow the modern entry point.

Sermon model lists are `GROQ_MODELS` / `OPENROUTER_MODELS` in `_shared/generate-sermon.mjs`; Versiah candidates are in `_shared/versiah.mjs`. Review current provider documentation before changing them.
