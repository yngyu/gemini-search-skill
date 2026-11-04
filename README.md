# gemini-search-skill

An [Agent Skill](https://agentskills.io/specification) that gives any coding agent web search through Gemini. Gemini runs the Google searches, reads the pages, and returns a short answer with numbered citations, so the agent's own model, local or hosted, never has to process raw search results.

- `search`: answer a question with Grounding with Google Search, with `[n]` citations and a source list
- `read`: read specific URLs (web pages, PDFs, and YouTube videos) with Gemini's URL context, or fetch the exact page text with `--raw`
- `get`: page through stored results, so agents with small context windows can read long results in pieces

`SKILL.md` contains the instructions the agent reads. This README is for the person installing the skill.

## Requirements

- Node.js 20.12 or newer (no npm dependencies)
- Outbound network access from the agent's shell
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey), or a Google Cloud API key if you point the skill at Vertex AI

## Install

Copy or symlink this directory into a skills directory your agent scans, keeping the directory name `gemini-search-skill`. For example, `~/.agents/skills/gemini-search-skill` for agents that support the shared Agent Skills locations, or use your agent's own skills directory or `--skill` option.

## Configure

The script reads settings from the process environment, then from an optional `.env` file next to `SKILL.md` (see `.env.example`). Values in the environment win.

| Variable | Purpose |
|---|---|
| `GEMINI_SEARCH_API_KEY` | API key for this skill. Takes precedence over `GEMINI_API_KEY`, so you can keep a separate key just for search. |
| `GEMINI_API_KEY` | Fallback API key when `GEMINI_SEARCH_API_KEY` is not set. |
| `GEMINI_BASE_URL` | API endpoint, including the version path. Default `https://generativelanguage.googleapis.com/v1beta` (Gemini API). |
| `GEMINI_SEARCH_MODEL` | Model ID. Default `gemini-3.8-flash`. |
| `GEMINI_SEARCH_CACHE_DIR` | Where results are stored for `get`. Default `~/.cache/gemini-search-skill`; entries expire after 24 hours. |

The agent's shell must see the key. If you export it from a login-shell file such as `~/.zprofile` or `~/.profile`, agents that run commands in a non-login shell will not see it; put it in `.env` or a file every shell reads instead.

### Using Vertex AI

To call Gemini on Vertex AI (Gemini Enterprise Agent Platform) instead of the Gemini API, set:

```bash
GEMINI_BASE_URL=https://aiplatform.googleapis.com/v1/publishers/google
```

and use a Google Cloud API key for a project with billing and the Agent Platform API enabled. See [Get a Google Cloud API key](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys).

| | Gemini API (default) | Vertex AI |
|---|---|---|
| Key | AI Studio API key | Google Cloud API key (express mode or bound to a service account) |
| Billing | Free tier without billing; the paid tier uses prepaid credits, and requests fail with HTTP 402 when the balance reaches $0 | Regular Google Cloud billing (postpay); Google Cloud credits apply |
| YouTube in `read` | Supported | Skipped with a warning (Vertex AI rejects YouTube URLs when called with an API key) |

YouTube URLs are only sent when `GEMINI_BASE_URL` points to `generativelanguage.googleapis.com`.

## Cost

- Model tokens are billed at the model's price on the platform you use.
- Grounding with Google Search is billed per search query Gemini runs, with a monthly free allowance for Gemini 3 and newer models on paid accounts. One `search` call often runs several queries. Free-tier Gemini API keys may not be able to use grounding at all.
- Prices and billing rules change; check [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing), or [Agent Platform pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).

## Usage

```bash
node scripts/gsearch.mjs search "latest stable Node.js version"
node scripts/gsearch.mjs search "Bun release notes" --recency month --evidence
node scripts/gsearch.mjs read https://example.com/docs --prompt "What are the installation steps?"
node scripts/gsearch.mjs read https://www.youtube.com/watch?v=VIDEO_ID --prompt "Summarize with timestamps"
node scripts/gsearch.mjs read https://example.com/docs --raw
node scripts/gsearch.mjs get <id> --offset 8000
node scripts/gsearch.mjs --help
```

See `SKILL.md` for every option and the output format.

## Terms of service

Answers from `search` come from Grounding with Google Search. Google's terms include requirements for using grounded results, including how Google Search Suggestions are displayed to end users. This skill does not render Search Suggestions. You are responsible for checking that your use complies with the terms of the platform you use: the [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms), or the [Google Cloud terms](https://cloud.google.com/terms) and service-specific terms for Vertex AI.

## Limitations and security

- Gemini writes the answers. It can add details that are not in its sources; use `--evidence` or `read --raw` to check important claims.
- `read --raw` fetches any http(s) URL the agent passes, including `localhost` and private network addresses, from the machine running the agent.
- Page text from `read --raw`, and to a lesser degree Gemini's answers, can contain instructions planted by the page author (prompt injection). The agent sees them as ordinary text, so keep the agent's other permissions appropriate for untrusted web content.
- HTML-to-text conversion in `read --raw` is simple: it keeps headings, lists, tables, and code blocks, but navigation text can remain on some pages. PDFs and videos are not supported with `--raw`.
- Results, including full API responses, are stored unencrypted in the cache directory for 24 hours.

## License

MIT. See [LICENSE](LICENSE).
