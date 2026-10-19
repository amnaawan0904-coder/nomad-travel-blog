/**
 * Article generator for Nomad Travel Blog.
 *
 *   1. Loads existing article titles from Supabase (to avoid duplicates).
 *   2. Research step: the AI picks a fresh topic and gathers real sources.
 *      - Gemini (free tier): picks a topic + search terms; the script fetches matching
 *        Wikivoyage / Wikipedia pages (free, no key) as the only research material.
 *      - Claude: researches with its built-in web search.
 *   3. Writing step: the AI turns the research into a structured article (JSON).
 *   4. Validates it (sources, length, slug, no visa/price content) and saves it —
 *      as a DRAFT by default, or PUBLISHED (live on the site) when PUBLISH=1.
 *      An article that fails validation is never saved at all.
 *
 * AI provider: Gemini when GEMINI_API_KEY is set, otherwise Claude via ANTHROPIC_API_KEY.
 * Force one with AI_PROVIDER=gemini|claude.
 *
 * Env vars (GitHub Actions secrets — never commit these):
 *   GEMINI_API_KEY or ANTHROPIC_API_KEY
 *   SUPABASE_URL               https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  server-only key that can insert rows (never put it in the website)
 * Optional:
 *   GEMINI_MODEL               defaults to gemini-3.8-flash (free tier for text)
 *   ANTHROPIC_MODEL            defaults to claude-opus-5-5
 *   DRY_RUN=1                  show the article instead of saving it
 *   PUBLISH=1                  save it as published instead of draft
 */
import { appendFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError, GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.env.DRY_RUN === "1";
const PUBLISH = process.env.PUBLISH === "1";
const PROVIDER = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY?.trim() ? "gemini" : "claude")).toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_PAUSE_CONTINUATIONS = 5;
const MIN_SOURCES = 2;

/** Categories used on the site. One is chosen per day so topics rotate. */
const CATEGORIES = ["Guides", "Slow Travel", "Remote Work", "Nomad Life", "Gear"];

const CATEGORY_BRIEFS = {
  Guides: "a neighbourhood-level destination guide for someone staying a month or more",
  "Slow Travel": "a reflective, practical piece about staying longer in one place",
  "Remote Work": "practical advice on working well while travelling (routines, focus, connectivity, coworking)",
  "Nomad Life": "community, wellbeing, relationships or personal growth on the road",
  Gear: "travel or remote-work gear, judged on practical use (never prices)",
};

/** Topics the blog deliberately never covers. */
const EXCLUDED_TOPICS =
  "visas or entry requirements, residency or tax rules, prices, costs of living, budgets, rents, fees, " +
  "salaries, currency amounts or cost comparisons, and travel insurance";

/** Safety net: reject drafts that still mention excluded topics. */
const EXCLUDED_PATTERN =
  /\bvisas?\b|\bcosts? of living\b|\bbudget(?:s|ing)?\b|\bprices?\b|\bpriced\b|\brent\b|\bsalar(?:y|ies)\b|[€£¥₹]\s?\d|\$\s?\d|\b\d[\d,.]*\s?(?:USD|EUR|GBP|dollars|euros)\b|\binsurance\b/i;

const BRAND_VOICE = `You write for Nomad Travel Blog — "Living, Working, and Growing in the Modern World".
Audience: digital nomads and slow travellers who stay a month or more in a place.
Voice: warm, calm, editorial and specific. Concrete details over hype. No clichés ("hidden gem", "bucket list",
"paradise", "wanderlust"), no listicle filler, no emojis. British-leaning spelling is fine.
The blog NEVER covers: ${EXCLUDED_TOPICS}. Leave these out entirely, even if sources mention them.
Never invent facts, names, statistics or quotes. Only state facts supported by the research notes.`;

/* ---------- Helpers ---------- */

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** The project API address, e.g. https://abcd1234.supabase.co — not a dashboard link. Never printed. */
function supabaseUrl() {
  const value = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(value)) {
    throw new Error(
      "SUPABASE_URL is not a Supabase project API address. It should look like https://<project-id>.supabase.co " +
        "(Supabase → Project Settings → API), not a supabase.com/dashboard link.",
    );
  }
  return value;
}

function todayCategory(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  return CATEGORIES[dayOfYear % CATEGORIES.length];
}

function slugify(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function researchPrompt(category, existingTitles) {
  return `Today is ${new Date().toISOString().slice(0, 10)}.

Pick ONE fresh article topic for the "${category}" category: ${CATEGORY_BRIEFS[category]}.
It must not duplicate or closely overlap any of these existing articles:
${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "- (none yet)"}

Then research it with web search, preferring official tourism boards, transport operators, manufacturers,
reputable publications, and recent sources. Do not research or note anything about ${EXCLUDED_TOPICS}.

Reply with:
TOPIC: <one line>
NOTES: concise research notes — the key facts a writer needs, each one supported by your sources.
Flag anything uncertain with "(unverified)".`;
}

function writingPrompt(category, notes, sources, feedback) {
  return `Write one article for the "${category}" category using ONLY these research notes.

<research_notes>
${notes}
</research_notes>

<sources>
${sources.map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join("\n")}
</sources>

Write in your own words — never copy sentences from the sources. Leave out anything marked (unverified).
For source_urls, copy only URLs from the list above that the article relies on.${
    feedback ? `\n\nYour previous draft was rejected: ${feedback} Fix this in the new draft.` : ""
  }`;
}

const ARTICLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "slug", "excerpt", "category", "seo_title", "seo_description", "content", "source_urls"],
  properties: {
    title: { type: "string", description: "Headline, under 80 characters" },
    slug: { type: "string", description: "lowercase-words-with-hyphens, under 80 characters" },
    excerpt: { type: "string", description: "1–2 sentence card summary, under 200 characters" },
    category: { type: "string", enum: CATEGORIES, description: "Use the category named in the request" },
    seo_title: { type: "string", description: "Under 60 characters" },
    seo_description: { type: "string", description: "Under 155 characters" },
    content: {
      type: "string",
      description:
        "Article body in Markdown, 900–1400 words. Use ## and ### headings, short paragraphs, occasional lists " +
        "and at most one > pull quote. Do not repeat the title as a heading. No image tags.",
    },
    source_urls: {
      type: "array",
      items: { type: "string" },
      description: "URLs from the provided source list that support the article",
    },
  },
};

function parseArticleJson(text, step) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    throw new Error(`${step}: response was not valid JSON.`);
  }
}

/* ---------- Free research sources: Wikivoyage + Wikipedia ---------- */

const WIKI_HEADERS = { "User-Agent": "NomadTravelBlogBot/1.0 (automated research for a travel blog; GitHub Actions)" };
const MAX_WIKI_PAGES = 5;
const MAX_CHARS_PER_PAGE = 6000;

/** Wikivoyage/Wikipedia sections that are about visas or prices — removed before the AI sees them. */
const EXCLUDED_SECTION = /^(get in|visas?|entry requirements|buy|sleep|budget|mid-?range|splurge|costs?|prices?|fees|money|economy)$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polite Wikimedia API call: a short pause before each request, and retries when rate-limited. */
async function wikiApi(site, params) {
  const url = `https://${site}/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  for (let attempt = 1; ; attempt++) {
    await sleep(500);
    const res = await fetch(url, { headers: WIKI_HEADERS, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt, 30_000);
      console.warn(`${site} is busy (${res.status}); waiting ${Math.round(waitMs / 1000)}s and retrying…`);
      await res.body?.cancel();
      await sleep(waitMs);
      continue;
    }
    throw new Error(`${site} returned ${res.status}`);
  }
}

/** Plain text of a page with visa/price sections removed. */
function cleanExtract(wikitextSections) {
  const kept = [];
  let skipping = false;
  for (const line of wikitextSections.split("\n")) {
    const heading = line.match(/^=+\s*(.+?)\s*=+$/);
    if (heading) {
      skipping = EXCLUDED_SECTION.test(heading[1]);
      if (!skipping) kept.push(`## ${heading[1]}`);
    } else if (!skipping && line.trim()) {
      kept.push(line.trim());
    }
  }
  return kept.join("\n").slice(0, MAX_CHARS_PER_PAGE);
}

/** Searches each site for each query and returns up to MAX_WIKI_PAGES distinct pages with text. */
async function collectWikiSources(queries) {
  const sources = [];
  const seen = new Set();
  for (const { site, query } of queries) {
    if (sources.length >= MAX_WIKI_PAGES) break;
    try {
      const search = await wikiApi(site, { action: "query", list: "search", srsearch: query, srlimit: "2" });
      for (const hit of search.query?.search ?? []) {
        if (sources.length >= MAX_WIKI_PAGES) break;
        const page = (await wikiApi(site, {
          action: "query", prop: "extracts|info", inprop: "url", explaintext: "1", exsectionformat: "wiki", titles: hit.title,
        })).query?.pages?.[0];
        if (!page?.fullurl || seen.has(page.fullurl) || !page.extract) continue;
        const text = cleanExtract(page.extract);
        if (text.length < 500) continue; // too thin to be useful
        seen.add(page.fullurl);
        sources.push({ url: page.fullurl, title: `${page.title} (${site.startsWith("en.wikivoyage") ? "Wikivoyage" : "Wikipedia"})`, text });
      }
    } catch (err) {
      console.warn(`Skipping "${query}" on ${site}: ${err.message}`);
    }
  }
  return sources;
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "wikivoyage_searches", "wikipedia_searches"],
  properties: {
    topic: { type: "string", description: "The article topic in one line" },
    wikivoyage_searches: {
      type: "array", items: { type: "string" }, maxItems: 3,
      description: "0–3 short searches for Wikivoyage pages (destinations, districts, itineraries). Empty if not a place-based topic.",
    },
    wikipedia_searches: {
      type: "array", items: { type: "string" }, minItems: 1, maxItems: 3,
      description: "1–3 short searches for Wikipedia pages that give factual background",
    },
  },
};

/* ---------- Provider: Gemini ---------- */

function geminiProvider() {
  const ai = new GoogleGenAI({
    apiKey: requireEnv("GEMINI_API_KEY"),
    // Only for local testing against a fake server; unset in GitHub Actions.
    ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}),
  });

  /** Throws if Gemini blocked or cut off the answer, so the run fails visibly. */
  function assertUsable(res, step) {
    const blocked = res.promptFeedback?.blockReason;
    if (blocked) throw new Error(`${step}: Gemini blocked the request (${blocked}).`);
    const reason = res.candidates?.[0]?.finishReason;
    if (reason && reason !== "STOP") throw new Error(`${step}: Gemini stopped early (${reason}).`);
    if (!res.text) throw new Error(`${step}: Gemini returned an empty response.`);
  }

  return {
    name: `Gemini (${GEMINI_MODEL})`,

    async research(category, existingTitles) {
      // 1. Gemini picks a topic and what to look up (no web access needed).
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `Today is ${new Date().toISOString().slice(0, 10)}.
Pick ONE fresh article topic for the "${category}" category: ${CATEGORY_BRIEFS[category]}.
It must not duplicate or closely overlap any of these existing articles:
${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "- (none yet)"}
Choose a topic that Wikivoyage and Wikipedia cover well, and suggest short searches for those sites.
Never choose a topic about ${EXCLUDED_TOPICS}.`,
        config: { systemInstruction: BRAND_VOICE, responseMimeType: "application/json", responseJsonSchema: PLAN_SCHEMA },
      });
      assertUsable(res, "Planning");
      const plan = parseArticleJson(res.text, "Planning");
      console.log(`Topic: ${plan.topic}`);

      // 2. The script fetches the real pages; these are the only research material and sources.
      const sources = await collectWikiSources([
        ...(plan.wikivoyage_searches ?? []).map((query) => ({ site: "en.wikivoyage.org", query })),
        ...(plan.wikipedia_searches ?? []).map((query) => ({ site: "en.wikipedia.org", query })),
      ]);
      const notes = [
        `TOPIC: ${plan.topic}`,
        ...sources.map((s, i) => `[Source ${i + 1}] ${s.title} — ${s.url}\n${s.text}`),
      ].join("\n\n");
      return { notes, sources: sources.map(({ url, title }) => ({ url, title })) };
    },

    async write(category, notes, sources, feedback) {
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: writingPrompt(category, notes, sources, feedback),
        config: {
          systemInstruction: BRAND_VOICE,
          responseMimeType: "application/json",
          responseJsonSchema: ARTICLE_SCHEMA,
        },
      });
      assertUsable(res, "Writing");
      return parseArticleJson(res.text, "Writing");
    },

    describeError(err) {
      if (!(err instanceof GeminiApiError)) return null;
      if (err.status === 429) return "Gemini free-tier limit reached (too many requests today or this minute). Try again later.";
      if (err.status === 400 && /api key/i.test(err.message)) return "GEMINI_API_KEY is invalid. Create a new key in Google AI Studio and update the secret.";
      if (err.status === 403) return "GEMINI_API_KEY is not allowed to use this model or API. Check the key in Google AI Studio.";
      if (err.status === 404) return `Gemini model "${GEMINI_MODEL}" isn't available to this key. Set a GEMINI_MODEL variable to a current model (see ai.google.dev/gemini-api/docs/models). Details: ${err.message}`;
      return `Gemini API error ${err.status}: ${err.message}`;
    },
  };
}

/* ---------- Provider: Claude ---------- */

function claudeProvider() {
  const anthropic = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

  /** Shared request settings: server-side fallback on refusals, adaptive thinking (always on for this model). */
  const baseRequest = {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };

  const textOf = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("");

  function assertUsable(message, step) {
    if (message.stop_reason === "refusal") {
      throw new Error(`${step}: Claude declined the request (refusal category: ${message.stop_details?.category ?? "unknown"}).`);
    }
    if (message.stop_reason === "max_tokens") throw new Error(`${step}: response hit max_tokens and was cut off.`);
  }

  return {
    name: `Claude (${CLAUDE_MODEL})`,

    async research(category, existingTitles) {
      const messages = [{ role: "user", content: researchPrompt(category, existingTitles) }];
      let response;
      for (let attempt = 0; ; attempt++) {
        response = await anthropic.beta.messages.create({
          ...baseRequest,
          system: BRAND_VOICE,
          output_config: { effort: "high" },
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
          messages,
        });
        if (response.stop_reason !== "pause_turn") break;
        if (attempt >= MAX_PAUSE_CONTINUATIONS) throw new Error("Research: too many pause_turn continuations.");
        // Server-side search loop paused — send the turn back unchanged so it resumes.
        messages.push({ role: "assistant", content: response.content });
      }
      assertUsable(response, "Research");

      const cited = new Map(); // url -> title
      for (const block of response.content) {
        if (block.type !== "text" || !block.citations) continue;
        for (const c of block.citations) {
          if (c.type === "web_search_result_location" && c.url && !cited.has(c.url)) cited.set(c.url, c.title ?? c.url);
        }
      }
      return { notes: textOf(response).trim(), sources: [...cited.entries()].map(([url, title]) => ({ url, title })) };
    },

    async write(category, notes, sources, feedback) {
      const response = await anthropic.beta.messages.create({
        ...baseRequest,
        system: BRAND_VOICE,
        output_config: { effort: "high", format: { type: "json_schema", schema: ARTICLE_SCHEMA } },
        messages: [{ role: "user", content: writingPrompt(category, notes, sources, feedback) }],
      });
      assertUsable(response, "Writing");
      return parseArticleJson(textOf(response), "Writing");
    },

    describeError(err) {
      if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key is missing or invalid.";
      if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached — try again later.";
      if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
      return null;
    },
  };
}

/* ---------- Validation ---------- */

function validate(article, allowedUrls, takenSlugs) {
  const problems = [];
  const sourceUrls = [...new Set(article.source_urls ?? [])].filter((u) => allowedUrls.has(u));
  if (sourceUrls.length < MIN_SOURCES) problems.push(`it cites only ${sourceUrls.length} researched source(s); at least ${MIN_SOURCES} are required.`);

  const content = article.content ?? "";
  const words = content.split(/\s+/).filter(Boolean).length;
  if (words < 600) problems.push(`it is too short (${words} words).`);

  const banned = `${article.title}\n${article.excerpt}\n${content}`.match(EXCLUDED_PATTERN);
  if (banned) problems.push(`it mentions an excluded topic ("${banned[0]}") — the blog never covers visas or prices.`);

  let slug = slugify(article.slug || article.title || "");
  if (!slug) problems.push("it has no usable slug.");
  for (let n = 2; takenSlugs.has(slug); n++) slug = `${slugify(article.slug || article.title).slice(0, 75)}-${n}`;

  return { problems, cleaned: { ...article, slug, source_urls: sourceUrls } };
}

/** On GitHub Actions, shows the article on the run's Summary page (contains article text only, no secrets). */
function writeRunSummary(row, saved, providerName) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## ${!saved ? "👀 Dry run — not saved" : row.status === "published" ? "🚀 Published" : "✅ Saved as draft"}: ${row.title}`,
    "",
    "| Field | Value |",
    "|---|---|",
    `| Written by | ${providerName} |`,
    `| Category | ${row.category} |`,
    `| Slug | \`${row.slug}\` |`,
    `| Excerpt | ${row.excerpt.replace(/\|/g, "\\|")} |`,
    `| SEO title | ${row.seo_title.replace(/\|/g, "\\|")} |`,
    `| SEO description | ${row.seo_description.replace(/\|/g, "\\|")} |`,
    "",
    "**Sources**",
    ...row.source_urls.map((u) => `- ${u}`),
    "",
    "---",
    "",
    row.content,
    "",
  ];
  appendFileSync(file, lines.join("\n"));
}

/* ---------- Main ---------- */

let provider = null;

async function main() {
  if (PROVIDER !== "gemini" && PROVIDER !== "claude") throw new Error(`AI_PROVIDER must be "gemini" or "claude".`);
  provider = PROVIDER === "gemini" ? geminiProvider() : claudeProvider();

  const supabase = createClient(supabaseUrl(), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // All statuses (drafts too), so we never write the same piece twice.
  const { data: existing, error: loadError } = await supabase
    .from("articles")
    .select("slug,title")
    .order("created_at", { ascending: false })
    .limit(300);
  if (loadError) throw new Error(`Could not read existing articles: ${loadError.message.slice(0, 300)}`);

  const takenSlugs = new Set(existing.map((a) => a.slug));
  const category = todayCategory();
  console.log(`Category for today: ${category} · AI: ${provider.name} · existing articles: ${existing.length}`);

  const { notes, sources } = await provider.research(category, existing.map((a) => a.title));
  console.log(`Research done: ${sources.length} source(s).`);
  if (sources.length < MIN_SOURCES) throw new Error(`Research found only ${sources.length} usable source(s); skipping today.`);

  const allowedUrls = new Set(sources.map((s) => s.url));
  let result = validate(await provider.write(category, notes, sources), allowedUrls, takenSlugs);
  if (result.problems.length) {
    console.warn(`First draft rejected: ${result.problems.join(" ")} Retrying once.`);
    result = validate(await provider.write(category, notes, sources, result.problems.join(" ")), allowedUrls, takenSlugs);
  }
  if (result.problems.length) throw new Error(`Draft rejected: ${result.problems.join(" ")}`);

  const article = result.cleaned;
  const row = {
    title: article.title.trim(),
    slug: article.slug,
    excerpt: article.excerpt.trim(),
    content: article.content.trim(),
    category, // today's rotation category, regardless of what the model returned
    seo_title: article.seo_title.trim(),
    seo_description: article.seo_description.trim(),
    source_urls: article.source_urls,
    // Drafts stay hidden until you publish them; PUBLISH=1 puts the article live straight away.
    ...(PUBLISH ? { status: "published", published_at: new Date().toISOString() } : { status: "draft" }),
  };

  if (DRY_RUN) {
    console.log(`DRY_RUN=1 — not saving (a real run would save it as ${row.status}). Article:\n` + JSON.stringify(row, null, 2));
    writeRunSummary(row, false, provider.name);
    return;
  }

  const { error: insertError } = await supabase.from("articles").insert(row);
  if (insertError) throw new Error(`Could not save article: ${insertError.message.slice(0, 300)}`);
  writeRunSummary(row, true, provider.name);
  console.log(
    row.status === "published"
      ? `Published "${row.title}" — it appears on the site at /journal/${row.slug} within about 5 minutes.`
      : `Saved draft "${row.title}" (/journal/${row.slug}). Review it in Supabase, then set status to 'scheduled' or 'published'.`,
  );
}

main().catch((err) => {
  console.error(provider?.describeError(err) ?? (err instanceof Error ? err.message : err));
  process.exit(1);
});
