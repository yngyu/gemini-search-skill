#!/usr/bin/env node
// Web search and URL reading through Gemini (Grounding with Google Search + URL context).
// Zero dependencies; requires Node.js 20.12+ and GEMINI_SEARCH_API_KEY (or GEMINI_API_KEY as a fallback).
// Variables can also be set in the skill's optional .env file; the process environment wins.

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const YOUTUBE_API_HOST = "generativelanguage.googleapis.com";
const CACHE_DIR = process.env.GEMINI_SEARCH_CACHE_DIR ?? join(homedir(), ".cache", "gemini-search-skill");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120_000;
const REDIRECT_TIMEOUT_MS = 10_000;
const RAW_TIMEOUT_MS = 30_000;
const RAW_MAX_BYTES = 5 * 1024 * 1024;
const RAW_TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml))/;
const MAX_URLS = 20;
const MAX_QUERIES = 5;
const QUERY_CONCURRENCY = 3;
const DEFAULT_MAX_CHARS = 8000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RECENCY_LABELS = { day: "the past 24 hours", week: "the past week", month: "the past month", year: "the past year" };
const YOUTUBE_REGEX = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{11}/;
const GROUNDING_REDIRECT = "vertexaisearch.cloud.google.com/grounding-api-redirect/";

const USAGE = `Usage:
  gsearch.mjs search "<query>" ["<query>" ...] [--url <url>]... [--recency day|week|month|year]
                     [--domain <domain>]... [--exclude <domain>]...
                     [--evidence] [--raw] [--model <id>] [--max-chars <n>] [--json]
  gsearch.mjs read <url> [<url> ...] [--prompt "<question>"] [--raw] [--model <id>] [--max-chars <n>] [--json]
  gsearch.mjs get <id> [--offset <n>] [--limit <n>] [--find "<text>"]

--max-chars / --limit 0 means no limit (default ${DEFAULT_MAX_CHARS}).
Environment: GEMINI_SEARCH_API_KEY, or GEMINI_API_KEY as a fallback (not needed for read --raw)
             GEMINI_BASE_URL (default ${DEFAULT_API_BASE})
             GEMINI_SEARCH_MODEL (default ${DEFAULT_MODEL})`;

class UsageError extends Error {}

function today() {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function getApiKey() {
	const key = process.env.GEMINI_SEARCH_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim();
	if (!key) throw new UsageError("Neither GEMINI_SEARCH_API_KEY nor GEMINI_API_KEY is set.");
	return key;
}

function getApiBase() {
	const base = (process.env.GEMINI_BASE_URL?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
	try {
		return { base, host: new URL(base).hostname };
	} catch {
		throw new UsageError(`Invalid GEMINI_BASE_URL: ${base}`);
	}
}

function resolveModel(flag) {
	return flag?.trim() || process.env.GEMINI_SEARCH_MODEL?.trim() || DEFAULT_MODEL;
}

function parsePositiveInt(value, name, fallback) {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
	return n;
}

function validateUrls(urls) {
	if (urls.length > MAX_URLS) throw new UsageError(`At most ${MAX_URLS} URLs are allowed.`);
	for (const url of urls) {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			throw new UsageError(`Invalid URL: ${url}`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new UsageError(`Only http(s) URLs are supported: ${url}`);
	}
}

// --- Gemini API ---

async function callGemini(model, body) {
	const apiKey = getApiKey();
	const { base, host } = getApiBase();
	const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (res.ok) return res.json();

		const text = (await res.text()).replaceAll(apiKey, "[REDACTED]");
		if (attempt < 2 && RETRY_STATUSES.has(res.status)) {
			const retryAfter = Number(res.headers.get("retry-after"));
			const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 2000 * (attempt + 1);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			continue;
		}
		throw new Error(`Gemini API error ${res.status} (${host}, model ${model}): ${text.slice(0, 500)}`);
	}
}

// Gemini reports grounding segment offsets in UTF-8 bytes, relative to one part.
function insertCitations(text, supports) {
	const bytes = Buffer.from(text, "utf8");
	const markersByEnd = new Map();
	for (const support of supports) {
		let end = support.segment?.endIndex;
		const indices = support.groundingChunkIndices;
		if (typeof end !== "number" || !indices?.length || end < 0 || end > bytes.length) continue;
		while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
		const markers = markersByEnd.get(end) ?? new Set();
		for (const index of indices) markers.add(index + 1);
		markersByEnd.set(end, markers);
	}

	const pieces = [];
	let previous = 0;
	for (const end of [...markersByEnd.keys()].sort((a, b) => a - b)) {
		pieces.push(bytes.subarray(previous, end));
		const markers = [...markersByEnd.get(end)].sort((a, b) => a - b).map((n) => `[${n}]`).join("");
		pieces.push(Buffer.from(markers));
		previous = end;
	}
	pieces.push(bytes.subarray(previous));
	return Buffer.concat(pieces).toString("utf8");
}

function normalizeUrl(url) {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		for (const name of [...parsed.searchParams.keys()]) {
			if (name.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(name);
		}
		return parsed.toString();
	} catch {
		return url;
	}
}

async function resolveRedirects(urls) {
	const targets = [...new Set(urls.filter((url) => url.includes(GROUNDING_REDIRECT)))];
	const resolved = new Map();
	await Promise.all(targets.map(async (url) => {
		try {
			const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS) });
			const location = res.headers.get("location");
			if (location) resolved.set(url, location);
		} catch (err) {
			process.stderr.write(`warning: could not resolve grounding redirect: ${err.message}\n`);
		}
	}));
	return resolved;
}

async function parseResponse(data) {
	const candidate = data.candidates?.[0];
	if (!candidate) {
		const reason = data.promptFeedback?.blockReason ?? "no candidates returned";
		throw new Error(`Gemini returned no answer: ${reason}`);
	}

	const metadata = candidate.groundingMetadata ?? {};
	const supports = metadata.groundingSupports ?? [];
	const parts = candidate.content?.parts ?? [];
	let answer = "";
	parts.forEach((part, index) => {
		if (typeof part.text !== "string" || part.thought) return;
		answer += insertCitations(part.text, supports.filter((s) => (s.segment?.partIndex ?? 0) === index));
	});

	const chunks = metadata.groundingChunks ?? [];
	const rawUrls = chunks.map((chunk) => chunk.web?.uri ?? chunk.retrievedContext?.uri ?? "");
	const redirects = await resolveRedirects(rawUrls);
	const citedIndices = new Set(supports.flatMap((s) => s.groundingChunkIndices ?? []));
	const sources = chunks.map((chunk, index) => {
		const raw = rawUrls[index];
		const url = normalizeUrl(redirects.get(raw) ?? raw);
		return { n: index + 1, title: chunk.web?.title ?? chunk.retrievedContext?.title ?? "", url, cited: citedIndices.has(index) };
	});

	const evidence = supports
		.filter((s) => s.segment?.text && s.groundingChunkIndices?.length)
		.map((s) => ({ text: s.segment.text, sources: s.groundingChunkIndices.map((i) => i + 1).sort((a, b) => a - b) }));

	const urlMetadata = candidate.urlContextMetadata?.urlMetadata ?? candidate.url_context_metadata?.url_metadata ?? [];
	const urlStatus = urlMetadata.map((m) => ({
		url: m.retrievedUrl ?? m.retrieved_url,
		status: String(m.urlRetrievalStatus ?? m.url_retrieval_status ?? "UNKNOWN").replace("URL_RETRIEVAL_STATUS_", ""),
	}));

	return {
		answer: answer.trim(),
		finishReason: candidate.finishReason,
		searchQueries: metadata.webSearchQueries ?? [],
		sources,
		evidence,
		urlStatus,
	};
}

// --- Raw page fetch (no Gemini) ---

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", yen: "¥", times: "×" };

function decodeEntities(text) {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
		if (entity[0] !== "#") return HTML_ENTITIES[entity.toLowerCase()] ?? match;
		const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
	});
}

function htmlToText(html) {
	const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
	let body = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(head|script|style|noscript|svg|template|iframe|nav|aside|footer)\b[\s\S]*?<\/\1>/gi, "");
	const main = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? body.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
	if (main && main.replace(/<[^>]+>/g, "").trim().length > 200) body = main;

	const preBlocks = [];
	body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
		preBlocks.push(decodeEntities(code.replace(/<[^>]+>/g, "")).replace(/\n+$/, ""));
		return `\n\u0000${preBlocks.length - 1}\u0000\n`;
	});
	body = body
		.replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${"#".repeat(Number(level))} `)
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(td|th)>\s*/gi, " | ")
		.replace(/<\/tr>\s*/gi, "\n")
		.replace(/<tr\b[^>]*>\s*/gi, "")
		.replace(/<\/?(p|div|section|article|header|footer|nav|aside|main|ul|ol|table|thead|tbody|h[1-6]|blockquote|dl|dt|dd|figure|figcaption|form)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	const text = decodeEntities(body)
		.split("\n")
		.map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\u0000(\d+)\u0000/g, (_, index) => `\`\`\`\n${preBlocks[Number(index)]}\n\`\`\``);
	return { title, text: text.trim() };
}

function detectCharset(contentType, bytes) {
	const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
	const fromMeta = bytes.subarray(0, 4096).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
	return fromHeader ?? fromMeta ?? "utf-8";
}

async function fetchRaw(url) {
	const res = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 (compatible; gemini-search-skill)", Accept: "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5" },
		redirect: "follow",
		signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const contentType = res.headers.get("content-type") ?? "";
	const mime = contentType.split(";")[0].trim().toLowerCase();
	if (mime && !RAW_TEXT_TYPES.test(mime)) throw new Error(`unsupported content type ${mime}; use read without --raw`);

	const bytes = Buffer.from(await res.arrayBuffer());
	if (bytes.length > RAW_MAX_BYTES) throw new Error(`page is larger than ${RAW_MAX_BYTES} bytes`);
	let decoder;
	try {
		decoder = new TextDecoder(detectCharset(contentType, bytes));
	} catch {
		decoder = new TextDecoder("utf-8");
	}
	const body = decoder.decode(bytes);
	const isHtml = mime.includes("html") || (!mime && /<html[\s>]/i.test(body));
	return { finalUrl: res.url, ...(isHtml ? htmlToText(body) : { title: "", text: body.trim() }) };
}

// --- Prompts ---

function buildSearchPrompt(query, { urls, recency, domains, excludes }) {
	const lines = [
		`Today is ${today()}.`,
		"Use Google Search to answer the question below. Be factual and specific: include concrete facts, numbers, dates, and versions.",
		"If sources disagree or the information cannot be found, say so explicitly instead of guessing. Answer in the same language as the question.",
	];
	if (recency) lines.push(`Only use information published within ${RECENCY_LABELS[recency]}.`);
	if (domains.length) lines.push(`Only use sources from these domains (use site: in your searches): ${domains.join(", ")}.`);
	if (excludes.length) lines.push(`Do not use sources from these domains: ${excludes.join(", ")}.`);
	if (urls.length) lines.push(`Also read these URLs and use them in the answer:\n${urls.join("\n")}`);
	lines.push("", `Question: ${query}`);
	return lines.join("\n");
}

function hostMatches(url, domain) {
	try {
		const host = new URL(url).hostname.toLowerCase();
		const d = domain.toLowerCase().replace(/^\*\./, "");
		return host === d || host.endsWith(`.${d}`);
	} catch {
		return false;
	}
}

// --- Output ---

function renderDocument(title, model, result, { showEvidence, grounded, linksOnly = false }) {
	const meta = [`model: ${model}`];
	if (grounded !== undefined) meta.push(`grounded: ${grounded ? "yes" : "NO"}`);
	if (result.searchQueries.length) meta.push(`searches: ${result.searchQueries.join(" | ")}`);
	const lines = [`# ${title}`, meta.join(" · "), ""];
	for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);
	if (result.warnings.length) lines.push("");
	if (!linksOnly) lines.push(result.answer || "(empty answer)", "");

	if (result.sources.length) {
		lines.push("## Sources");
		for (const s of result.sources) lines.push(`[${s.n}] ${s.title ? `${s.title} — ` : ""}${s.url}${s.cited ? "" : " (not cited)"}`);
		lines.push("");
	}
	if (result.urlStatus.length) {
		lines.push("## URL status");
		for (const u of result.urlStatus) lines.push(`- ${u.status}: ${u.url}`);
		lines.push("");
	}
	if (showEvidence && result.evidence.length) {
		lines.push("## Evidence (answer segment → sources)");
		for (const e of result.evidence) lines.push(`- "${e.text.replace(/\s+/g, " ").trim()}" ${e.sources.map((n) => `[${n}]`).join("")}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function saveRecord(record) {
	mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
	const now = Date.now();
	for (const name of readdirSync(CACHE_DIR)) {
		const path = join(CACHE_DIR, name);
		if (name.endsWith(".json") && now - statSync(path).mtimeMs > CACHE_TTL_MS) rmSync(path, { force: true });
	}
	const id = randomBytes(4).toString("hex");
	writeFileSync(join(CACHE_DIR, `${id}.json`), JSON.stringify({ id, createdAt: new Date(now).toISOString(), ...record }), { mode: 0o600 });
	return id;
}

function loadRecord(id) {
	if (!/^[0-9a-f]{8}$/.test(id)) throw new UsageError(`Invalid id: ${id}`);
	try {
		return JSON.parse(readFileSync(join(CACHE_DIR, `${id}.json`), "utf8"));
	} catch (err) {
		if (err.code === "ENOENT") throw new UsageError(`No stored result for id ${id} (results expire after 24 hours).`);
		throw err;
	}
}

function truncateForDisplay(document, id, maxChars) {
	if (maxChars === 0 || document.length <= maxChars) return `${document}\n\n(id: ${id})`;
	return `${document.slice(0, maxChars)}\n\n[Truncated at ${maxChars} of ${document.length} chars. Continue with: gsearch.mjs get ${id} --offset ${maxChars}]`;
}

// --- Commands ---

async function searchOne(query, opts) {
	const prompt = buildSearchPrompt(query, opts);
	const tools = [{ google_search: {} }, ...(opts.urls.length ? [{ url_context: {} }] : [])];
	const response = await callGemini(opts.model, { contents: [{ role: "user", parts: [{ text: prompt }] }], tools });
	const result = await parseResponse(response);

	const grounded = result.searchQueries.length > 0 || result.sources.length > 0;
	result.warnings = [];
	if (!grounded) result.warnings.push("Gemini answered without searching the web. Treat this answer as unverified.");
	if (result.finishReason && result.finishReason !== "STOP") result.warnings.push(`Answer may be incomplete (finishReason: ${result.finishReason}).`);
	if (opts.domains.length) {
		const outside = result.sources.filter((s) => s.url && !opts.domains.some((d) => hostMatches(s.url, d))).map((s) => `[${s.n}]`);
		if (outside.length) result.warnings.push(`Sources outside the requested domains: ${outside.join(" ")}`);
	}
	const excluded = result.sources.filter((s) => s.url && opts.excludes.some((d) => hostMatches(s.url, d))).map((s) => `[${s.n}]`);
	if (excluded.length) result.warnings.push(`Sources from excluded domains: ${excluded.join(" ")}`);
	const failed = result.urlStatus.filter((u) => u.status !== "SUCCESS");
	if (failed.length) result.warnings.push(`${failed.length} URL(s) could not be retrieved; see URL status.`);

	const title = `Web search: ${query}`;
	const display = renderDocument(title, opts.model, result, { showEvidence: opts.evidence && !opts.raw, grounded, linksOnly: opts.raw });
	const document = opts.raw ? display : renderDocument(title, opts.model, result, { showEvidence: true, grounded });
	const id = saveRecord({ command: "search", query, model: opts.model, result, document, response });
	return { id, query, grounded, ...result, display };
}

async function commandSearch(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			url: { type: "string", multiple: true, default: [] },
			recency: { type: "string" },
			domain: { type: "string", multiple: true, default: [] },
			exclude: { type: "string", multiple: true, default: [] },
			evidence: { type: "boolean", default: false },
			raw: { type: "boolean", default: false },
			model: { type: "string" },
			"max-chars": { type: "string" },
			json: { type: "boolean", default: false },
		},
	});
	const queries = positionals.map((q) => q.trim()).filter(Boolean);
	if (!queries.length) throw new UsageError("search needs at least one query.");
	if (queries.length > MAX_QUERIES) throw new UsageError(`At most ${MAX_QUERIES} queries per call.`);
	if (values.recency && !RECENCY_LABELS[values.recency]) throw new UsageError("--recency must be day, week, month, or year.");
	validateUrls(values.url);
	getApiKey();
	const opts = {
		urls: values.url,
		recency: values.recency,
		domains: values.domain.map((d) => d.trim()).filter(Boolean),
		excludes: values.exclude.map((d) => d.trim()).filter(Boolean),
		evidence: values.evidence,
		raw: values.raw,
		model: resolveModel(values.model),
	};
	const maxChars = parsePositiveInt(values["max-chars"], "max-chars", DEFAULT_MAX_CHARS);

	const outcomes = [];
	for (let i = 0; i < queries.length; i += QUERY_CONCURRENCY) {
		const batch = queries.slice(i, i + QUERY_CONCURRENCY);
		outcomes.push(...await Promise.all(batch.map((query) => searchOne(query, opts).catch((error) => ({ query, error: error.message })))));
	}

	if (values.json) {
		process.stdout.write(`${JSON.stringify(outcomes.map(({ display, ...rest }) => rest), null, 2)}\n`);
	} else {
		const perQuery = maxChars === 0 ? 0 : Math.max(1000, Math.floor(maxChars / outcomes.length));
		const blocks = outcomes.map((o) => (o.error ? `# Web search: ${o.query}\nERROR: ${o.error}` : truncateForDisplay(o.display, o.id, perQuery)));
		process.stdout.write(`${blocks.join("\n\n---\n\n")}\n`);
	}
	return outcomes.every((o) => o.error) ? 1 : 0;
}

async function commandRead(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			prompt: { type: "string" },
			raw: { type: "boolean", default: false },
			model: { type: "string" },
			"max-chars": { type: "string" },
			json: { type: "boolean", default: false },
		},
	});
	if (!positionals.length) throw new UsageError("read needs at least one URL.");
	validateUrls(positionals);
	const maxChars = parsePositiveInt(values["max-chars"], "max-chars", DEFAULT_MAX_CHARS);
	if (values.raw) return readRaw(positionals, maxChars, values.json);
	const model = resolveModel(values.model);
	const question = values.prompt?.trim()
		|| "Report the main content of each URL in detail. Preserve facts, numbers, dates, code, and tables. Do not add information that is not on the page.";

	const pages = positionals.filter((u) => !YOUTUBE_REGEX.test(u));
	let videos = positionals.filter((u) => YOUTUBE_REGEX.test(u));
	const warnings = [];
	if (videos.length && getApiBase().host !== YOUTUBE_API_HOST) {
		warnings.push(`Ignored ${videos.length} YouTube URL(s): YouTube is only supported with the default ${YOUTUBE_API_HOST} endpoint.`);
		videos = [];
	}
	if (!pages.length && !videos.length) throw new UsageError(`No URLs to read: YouTube URLs are ignored unless GEMINI_BASE_URL points to ${YOUTUBE_API_HOST}.`);

	const text = [`Today is ${today()}.`, question, ...(pages.length ? ["", "URLs:", ...pages] : [])].join("\n");
	const parts = [...videos.map((fileUri) => ({ fileData: { fileUri } })), { text }];
	const body = { contents: [{ role: "user", parts }], ...(pages.length ? { tools: [{ url_context: {} }] } : {}) };

	const response = await callGemini(model, body);
	const result = await parseResponse(response);
	result.warnings = warnings;
	const failed = result.urlStatus.filter((u) => u.status !== "SUCCESS");
	if (failed.length) result.warnings.push(`${failed.length} URL(s) could not be retrieved; content for them may be missing or guessed.`);
	if (pages.length && !result.urlStatus.length) result.warnings.push("Gemini reported no URL retrieval; the answer may not be based on the page content.");

	const document = renderDocument(`Read: ${positionals.join(", ")}`, model, result, { showEvidence: false });
	const id = saveRecord({ command: "read", urls: positionals, model, result, document, response });
	if (values.json) {
		process.stdout.write(`${JSON.stringify({ id, urls: positionals, ...result }, null, 2)}\n`);
	} else {
		process.stdout.write(`${truncateForDisplay(document, id, maxChars)}\n`);
	}
	return 0;
}

async function readRaw(urls, maxChars, json) {
	const pages = await Promise.all(urls.map(async (url) => {
		try {
			return { url, ...await fetchRaw(url) };
		} catch (err) {
			return { url, error: err.message };
		}
	}));
	const document = pages.map((p) => {
		if (p.error) return `# Raw: ${p.url}\nERROR: ${p.error}`;
		const meta = [p.finalUrl !== p.url ? `final URL: ${p.finalUrl}` : "", p.title ? `title: ${p.title}` : "", `${p.text.length} chars`].filter(Boolean);
		return `# Raw: ${p.url}\n${meta.join(" · ")}\n\n${p.text || "(no text content)"}`;
	}).join("\n\n---\n\n");
	const id = saveRecord({ command: "read-raw", urls, pages, document });
	if (json) {
		process.stdout.write(`${JSON.stringify({ id, pages }, null, 2)}\n`);
	} else {
		process.stdout.write(`${truncateForDisplay(document, id, maxChars)}\n`);
	}
	return pages.every((p) => p.error) ? 1 : 0;
}

function commandGet(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { offset: { type: "string" }, limit: { type: "string" }, find: { type: "string" } },
	});
	if (positionals.length !== 1) throw new UsageError("get needs exactly one id.");
	const { document } = loadRecord(positionals[0]);

	if (values.find !== undefined) {
		const needle = values.find.toLowerCase();
		if (!needle) throw new UsageError("--find must not be empty.");
		const matches = document.split("\n").filter((line) => line.toLowerCase().includes(needle));
		process.stdout.write(matches.length ? `${matches.slice(0, 30).join("\n")}\n` : `No lines contain "${values.find}".\n`);
		return 0;
	}

	const offset = parsePositiveInt(values.offset, "offset", 0);
	const limit = parsePositiveInt(values.limit, "limit", DEFAULT_MAX_CHARS);
	const slice = limit === 0 ? document.slice(offset) : document.slice(offset, offset + limit);
	const end = offset + slice.length;
	const footer = end < document.length ? `\n\n[Showing ${offset}-${end} of ${document.length} chars. Next: gsearch.mjs get ${positionals[0]} --offset ${end}]` : "";
	process.stdout.write(`${slice}${footer}\n`);
	return 0;
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	try {
		if (command === "search") return await commandSearch(rest);
		if (command === "read") return await commandRead(rest);
		if (command === "get") return commandGet(rest);
		if (command === "-h" || command === "--help" || command === "help") {
			process.stdout.write(`${USAGE}\n`);
			return 0;
		}
		throw new UsageError(command ? `Unknown command: ${command}` : "Missing command.");
	} catch (err) {
		if (err instanceof UsageError || err.code?.startsWith?.("ERR_PARSE_ARGS")) {
			process.stderr.write(`Error: ${err.message}\n\n${USAGE}\n`);
			return 2;
		}
		process.stderr.write(`Error: ${err.message}\n`);
		return 1;
	}
}

process.exitCode = await main();
