---
name: gemini-search-skill
license: MIT
description: "Searches the web and reads web pages, PDFs, and YouTube videos through Gemini (Google Search grounding and URL context), returning cited answers, source links, or raw page text. Use when you do not know something, need current or verifiable information, or think a web search would help."
compatibility: "Requires Node.js 20.12+, outbound network access, and GEMINI_SEARCH_API_KEY or GEMINI_API_KEY."
---

# Gemini Web Search

`gsearch` = `node <directory containing this SKILL.md>/scripts/gsearch.mjs` (use the absolute path). Run `gsearch --help` for all options.

Search instead of guessing when you are unsure or your knowledge may be outdated: versions, release notes, prices, news, API details, errors, or a specific URL.

## Commands

```bash
gsearch search "query" ["query2" ...]   # up to 5 queries, run in parallel; cited answer
gsearch read <url> --prompt "question"  # Gemini reads a page, PDF, or YouTube video
gsearch read <url> --raw                # exact page text, no Gemini (text/HTML only)
gsearch get <id> [--offset n | --find "text"]   # page through a stored result (kept 24h)
```

`search` options: `--depth quick|normal|deep`, `--recency day|week|month|year`, `--domain d` / `--exclude d` (repeatable), `--url u` (also read this URL), `--evidence` (sentence → source map), `--raw` (links only, no answer).
Output is capped at 8000 chars; use `--max-chars n` (0 = unlimited) or `get`. `--json` gives structured output.

## Choose `--depth` per question

- `quick`: one cheap-to-get-wrong fact (weather, exchange rate, latest version). ~7s.
- `normal` (default): general lookups. ~18s.
- `deep`: debugging, error investigation, version-dependent behavior, breaking changes, comparisons, conflicting sources. ~30s+. Pass several queries from different angles (error text, official docs, GitHub issues).

No-source results are retried one level deeper automatically (`--no-escalate` disables). Keep queries short; use `--recency` only when freshness matters.

## Reading output

- `[n]` in the answer maps to `[n]` in Sources; cite those URLs.
- `grounded: NO` means no search happened; the answer is from memory and may be outdated.
- `WARNING:` lines flag unreliable parts. For important claims, verify with `--evidence` or `read --raw` on the source.

## Errors

- No API key: ask the user to set `GEMINI_SEARCH_API_KEY` (see README.md).
- `401/402/403`: key, billing, or access problem; tell the user, do not retry.
- `429`: already retried; wait and retry once, or tell the user.
- `400/404` about the model: set `GEMINI_SEARCH_MODEL` or pass `--model`.
- YouTube works only with the default endpoint (skipped with a `WARNING:` otherwise).
