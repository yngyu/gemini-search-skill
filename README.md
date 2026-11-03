# gemini-search-skill

An [Agent Skill](https://agentskills.io/specification) that gives any coding agent web search through Gemini on Vertex AI (Gemini Enterprise Agent Platform). Gemini runs the Google searches, reads the pages, and returns a short answer with numbered citations, so the agent's own model, local or hosted, never has to process raw search results.

- `search`: answer a question with Grounding with Google Search, with `[n]` citations and a source list
- `read`: read specific URLs (web pages and PDFs) with Gemini's URL context, or fetch the exact page text with `--raw`
- `get`: page through stored results, so agents with small context windows can read long results in pieces

`SKILL.md` contains the instructions the agent reads. This README is for the person installing the skill.

## Requirements

- Node.js 20.12 or newer (no npm dependencies)
- Outbound network access from the agent's shell
- A Google Cloud project with billing and the Agent Platform API enabled, and a Google Cloud API key for it

The skill only calls Vertex AI (`https://aiplatform.googleapis.com/v1/publishers/google/models/...`). Gemini API keys from Google AI Studio do not work.

## Get a Google Cloud API key

Follow [Get a Google Cloud API key](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys):

- **Express mode**: the console creates the key for you. New Google Cloud users get a 90-day free tier there; existing users link a billing account.
- **Standard project**: enable billing and the Agent Platform API, create a service account with access to it, then create an API key under **APIs & Services > Credentials** with **Authenticate API calls through a service account** selected.

Test the key:

```bash
curl -s -H "x-goog-api-key: $GEMINI_SEARCH_API_KEY" -H "Content-Type: application/json" \
  https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent \
  -d '{"contents":[{"role":"user","parts":[{"text":"Say hi"}]}]}'
```

## Install

Copy or symlink this directory into a skills directory your agent scans, keeping the directory name `gemini-search-skill`. For example, `~/.agents/skills/gemini-search-skill` for agents that support the shared Agent Skills locations, or use your agent's own skills directory or `--skill` option.

## Configure

The script reads settings from the process environment, then from an optional `.env` file next to `SKILL.md` (see `.env.example`). Values in the environment win.

| Variable | Purpose |
|---|---|
| `GEMINI_SEARCH_API_KEY` | Google Cloud API key for Vertex AI. Required except for `read --raw`. |
| `GEMINI_SEARCH_MODEL` | Model ID. Default `gemini-3.8-flash`. |
| `GEMINI_SEARCH_CACHE_DIR` | Where results are stored for `get`. Default `~/.cache/gemini-search-skill`; entries expire after 24 hours. |

The agent's shell must see the key. If you export it from a login-shell file such as `~/.zprofile` or `~/.profile`, agents that run commands in a non-login shell will not see it; put it in `.env` or a file every shell reads instead.

## Cost

Vertex AI is billed through regular Google Cloud billing (postpay), and Google Cloud credits apply to it, including the monthly credits that come with some Google AI plans and the new-customer free trial credit.

- Model tokens are billed at the model's Vertex AI price.
- Grounding with Google Search is billed per search query Gemini runs, with a monthly free allowance for Gemini 3 and newer models. One `search` call often runs several queries.
- Requests that fail with 4xx or 5xx errors are not billed.

Prices change; check [Agent Platform pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing). Setting a Cloud Billing budget alert is a good idea, because postpay usage does not stop on its own.

## Usage

```bash
node scripts/gsearch.mjs search "latest stable Node.js version"
node scripts/gsearch.mjs search "Bun release notes" --recency month --evidence
node scripts/gsearch.mjs read https://example.com/docs --prompt "What are the installation steps?"
node scripts/gsearch.mjs read https://example.com/docs --raw
node scripts/gsearch.mjs get <id> --offset 8000
node scripts/gsearch.mjs --help
```

See `SKILL.md` for every option and the output format.

## Terms of service

Answers from `search` come from Grounding with Google Search. Google's terms for Vertex AI and for grounding include requirements for using grounded results, including how Google Search Suggestions are displayed to end users. This skill does not render Search Suggestions. You are responsible for checking that your use complies with the [Google Cloud terms](https://cloud.google.com/terms) and the service-specific terms that apply to Grounding with Google Search on Vertex AI.

## Limitations and security

- Gemini writes the answers. It can add details that are not in its sources; use `--evidence` or `read --raw` to check important claims.
- YouTube URLs are not supported: Vertex AI rejects them when called with an API key.
- `read --raw` fetches any http(s) URL the agent passes, including `localhost` and private network addresses, from the machine running the agent.
- Page text from `read --raw`, and to a lesser degree Gemini's answers, can contain instructions planted by the page author (prompt injection). The agent sees them as ordinary text, so keep the agent's other permissions appropriate for untrusted web content.
- HTML-to-text conversion in `read --raw` is simple: it keeps headings, lists, tables, and code blocks, but navigation text can remain on some pages. PDFs and videos are not supported with `--raw`.
- Results, including full API responses, are stored unencrypted in the cache directory for 24 hours.
