/**
 * Web search + page reading module — uses Brave Search API.
 *
 * Brave Search:  https://brave.com/search/api/
 *   Free tier: 2,000 queries/month, 1 req/second rate limit.
 *
 * Also provides fetchPage() for reading article content from URLs.
 */

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1200; // > 1 s to stay under 1 req/s
const MAX_QUERY_LEN = 300;
const MAX_PAGE_CHARS = 3000; // how much text to extract from a page

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip URLs, special chars, and truncate to keep Brave happy. */
function sanitizeQuery(raw) {
  return raw
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[^\w\s\-'",?!]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LEN);
}

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

async function braveSearch(query, { apiKey, maxResults = 5 } = {}) {
  if (!apiKey) return [];

  const cleaned = sanitizeQuery(query);
  if (!cleaned) return [];

  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(cleaned)}&count=${maxResults}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`  ⏳ Rate-limited — retrying in ${(wait / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      await sleep(wait);
    }

    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });

    if (resp.status === 429 && attempt < MAX_RETRIES) {
      continue;
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`⚠️  Brave Search ${resp.status}: ${body.slice(0, 120)}`);
      return [];
    }

    const data = await resp.json();
    const results = (data.web?.results || []).slice(0, maxResults);

    return results.map((r) => ({
      title: r.title || "",
      snippet: r.description || "",
      url: r.url || "",
    }));
  }

  return [];
}

// ---------------------------------------------------------------------------
// Page fetching — read the text content of a URL
// ---------------------------------------------------------------------------

/**
 * Fetch a web page and extract readable text. Returns a truncated string.
 * Strips HTML tags, scripts, styles, and collapses whitespace.
 */
async function fetchPage(pageUrl) {
  try {
    const resp = await fetch(pageUrl, {
      headers: {
        "User-Agent": "CISBot/1.0 (research agent)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return `(Failed to fetch: ${resp.status})`;

    const html = await resp.text();

    // Strip scripts, styles, and HTML tags to get readable text.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!text) return "(No readable content)";
    return text.slice(0, MAX_PAGE_CHARS) + (text.length > MAX_PAGE_CHARS ? "…" : "");
  } catch (e) {
    return `(Error reading page: ${e.message})`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the search + browse toolkit. Returns null if no API key.
 */
function createSearchTools({ apiKey, maxResults = 5 } = {}) {
  if (!apiKey) return null;

  let lastSearchMs = 0;

  async function search(query) {
    try {
      const now = Date.now();
      const elapsed = now - lastSearchMs;
      if (elapsed < BASE_DELAY_MS) {
        await sleep(BASE_DELAY_MS - elapsed);
      }
      lastSearchMs = Date.now();
      return await braveSearch(query, { apiKey, maxResults });
    } catch (e) {
      console.warn(`⚠️  Search error: ${e.message}`);
      return [];
    }
  }

  return { search, fetchPage };
}

/** Kept for backward-compat — wraps createSearchTools().search */
function createSearchFn({ apiKey, maxResults = 5 } = {}) {
  const tools = createSearchTools({ apiKey, maxResults });
  return tools ? tools.search : null;
}

/**
 * Format search results into a string for inclusion in LLM prompts.
 */
function formatSearchResults(results) {
  if (!results || results.length === 0) return "(no results)";
  return results
    .map((r, i) => `${i + 1}. [${r.title}] ${r.snippet}\n   URL: ${r.url}`)
    .join("\n");
}

module.exports = { createSearchTools, createSearchFn, formatSearchResults, fetchPage };
