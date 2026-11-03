---
name: gemini-search-skill
description: "Searches the web and reads web pages and PDFs through Gemini on Vertex AI (Google Search grounding and URL context), returning cited answers, source links, or raw page text. Use when you do not know something, need current or verifiable information, or think a web search would help."
compatibility: "Requires Node.js 20.12+, outbound network access, and a Google Cloud API key for Vertex AI in GEMINI_SEARCH_API_KEY."
---

# Gemini Web Search

`scripts/gsearch.mjs` sits in the same directory as this SKILL.md. In the examples below, `gsearch` means:

```bash
node <directory containing this SKILL.md>/scripts/gsearch.mjs
```

Use the absolute path; the script works from any working directory.

## When to use

When you don't know something, aren't sure your knowledge is current, or think a web search would help, search instead of guessing. Typical cases: recent versions, release notes, prices, news, API details, or the content of a specific URL.

## Commands

### search: answer a question from the web

Gemini runs the Google searches, reads the results, and writes an answer with `[n]` citations.

```bash
gsearch search "latest stable Node.js version"
gsearch search "query one" "query two"             # up to 5 queries in parallel
gsearch search "Bun release notes" --recency month
gsearch search "useEffect cleanup timing" --domain react.dev
gsearch search "compare pricing" --url https://a.example/pricing --url https://b.example/pricing
gsearch search "..." --evidence                    # list which answer sentence is backed by which source
gsearch search "..." --raw                         # links only: Gemini's searches and sources, no answer
```

| Option | Meaning |
|---|---|
| `--recency day\|week\|month\|year` | Only use recent information |
| `--domain example.com` | Only use this domain (repeatable) |
| `--exclude example.com` | Do not use this domain (repeatable) |
| `--url <url>` | Also read this URL (repeatable, up to 20) |
| `--evidence` | List each cited sentence with its source numbers |
| `--raw` | Return only the search queries and source links, so you can read and judge the sources yourself |

### read: read specific URLs

```bash
gsearch read https://example.com/docs/install --prompt "What are the installation steps?"
gsearch read https://example.com/report.pdf --prompt "List the key figures"
gsearch read https://example.com/docs/install --raw   # exact page text, no Gemini
```

- Without `--raw`, Gemini reads the page (web pages and PDFs; YouTube is not supported) and writes a report or answers `--prompt`. This is a rewrite, not the original text.
- With `--raw`, the script downloads the page itself and returns its text. Use it when you need the exact wording, code, or numbers. Text and HTML only; no PDFs or videos. No API key needed.

### get: page through a stored result

Every result ends with an `id` and is kept for 24 hours.

```bash
gsearch get 1a2b3c4d                     # full stored result (includes the evidence section for search)
gsearch get 1a2b3c4d --offset 8000       # continue a truncated result
gsearch get 1a2b3c4d --find "pricing"    # lines containing a word
```

### Output length

`search` and `read` print at most 8000 characters by default; `get` returns 8000 characters per call. Choose the size that fits your context:

- `--max-chars <n>` on `search` / `read`, `--limit <n>` on `get`
- `0` means no limit
- Truncated output ends with the exact `get` command to continue.

`--json` on `search` / `read` prints the full structured result instead.

## Reading the output

```
# Web search: <query>
model: gemini-3.8-flash · grounded: yes · searches: <what Gemini searched>

<answer with citation markers like [1][3]>

## Sources
[1] title — https://...
[2] title — https://... (not cited)
```

- `[n]` in the answer refers to `[n]` in Sources. Cite these URLs when you use the information.
- `grounded: NO` means Gemini did not search; the answer is from its own memory and may be outdated.
- `WARNING:` lines flag unreliable parts: unretrievable URLs, sources outside `--domain`, or a truncated answer.
- Gemini can add details that are not in its sources. For important claims, check with `--evidence` or `read --raw` on the cited URL.

## Setup and errors

- The script calls Gemini on Vertex AI with the Google Cloud API key in `GEMINI_SEARCH_API_KEY` (environment or this skill's `.env`). If it is not set, ask the user to set it; see README.md.
- `Gemini API error 401` or `403`: the key is not a Vertex AI key, the Agent Platform API is not enabled, or billing is not set up on the user's Google Cloud project. Tell the user; do not retry.
- `Gemini API error 429`: rate limit or quota. The script already retried; wait and try once more, or tell the user.
- `Gemini API error 400/404` about the model: set `GEMINI_SEARCH_MODEL` or pass `--model` with a valid model ID.
