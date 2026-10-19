/**
 * Daily article generator for Nomad Travel Blog.
 *
 *   1. Loads existing article titles from Supabase (to avoid duplicates).
 *   2. Research step: Claude + web search picks a fresh topic and gathers cited notes.
 *   3. Writing step: Claude turns the notes into a structured article (JSON).
 *   4. Validates it (sources, slug, no visa/price content) and saves it as a DRAFT.
 *
 * Nothing is ever published by this script — a human reviews drafts in Supabase.
 *
 * Env vars (GitHub Actions secrets — never commit these):
 *   ANTHROPIC_API_KEY          Claude API key
 *   SUPABASE_URL               https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  server-only key that can insert rows (never put it in the website)
 * Optional:
 *   ANTHROPIC_MODEL            defaults to claude-opus-5-5
 *   DRY_RUN=1                  print the article instead of saving it
 */
import { appendFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const DRY_RUN = process.env.DRY_RUN === "1";
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

function textOf(message) {
  return message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

/** Throws if Claude declined, so the run fails visibly instead of saving something empty. */
function assertUsable(message, step) {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? "unknown";
    throw new Error(`${step}: Claude declined the request (refusal category: ${category}).`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(`${step}: response hit max_tokens and was cut off.`);
  }
}

/* ---------- Claude calls ---------- */

const anthropic = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

/** Shared request settings: server-side fallback on refusals, adaptive thinking (always on for this model). */
const baseRequest = {
  model: MODEL,
  max_tokens: 16000,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

/** Step 1 — research with web search. Returns notes plus the URLs Claude actually cited. */
async function research(category, existingTitles) {
  const messages = [
    {
      role: "user",
      content: `Today is ${new Date().toISOString().slice(0, 10)}.

Pick ONE fresh article topic for the "${category}" category: ${CATEGORY_BRIEFS[category]}.
It must not duplicate or closely overlap any of these existing articles:
${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "- (none yet)"}

Then research it with web search, preferring official tourism boards, transport operators, manufacturers,
reputable publications, and recent sources. Do not research or note anything about ${EXCLUDED_TOPICS}.

Reply with:
TOPIC: <one line>
NOTES: concise research notes — the key facts a writer needs, each one supported by your sources.
Flag anything uncertain with "(unverified)".`,
    },
  ];

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

/** Step 2 — write the article as structured JSON from the research notes. */
async function write(category, notes, sources, feedback) {
  const response = await anthropic.beta.messages.create({
    ...baseRequest,
    system: BRAND_VOICE,
    output_config: { effort: "high", format: { type: "json_schema", schema: ARTICLE_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Write one article for the "${category}" category using ONLY these research notes.

<research_notes>
${notes}
</research_notes>

<sources>
${sources.map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join("\n")}
</sources>

Leave out anything marked (unverified). For source_urls, copy only URLs from the list above that the article relies on.${
          feedback ? `\n\nYour previous draft was rejected: ${feedback} Fix this in the new draft.` : ""
        }`,
      },
    ],
  });
  assertUsable(response, "Writing");

  try {
    return JSON.parse(textOf(response));
  } catch {
    throw new Error("Writing: response was not valid JSON.");
  }
}

/* ---------- Validation ---------- */

function validate(article, allowedUrls, takenSlugs) {
  const problems = [];
  const sourceUrls = [...new Set(article.source_urls)].filter((u) => allowedUrls.has(u));
  if (sourceUrls.length < MIN_SOURCES) problems.push(`it cites only ${sourceUrls.length} researched source(s); at least ${MIN_SOURCES} are required.`);

  const words = article.content.split(/\s+/).filter(Boolean).length;
  if (words < 600) problems.push(`it is too short (${words} words).`);

  const banned = `${article.title}\n${article.excerpt}\n${article.content}`.match(EXCLUDED_PATTERN);
  if (banned) problems.push(`it mentions an excluded topic ("${banned[0]}") — the blog never covers visas or prices.`);

  let slug = slugify(article.slug || article.title);
  if (!slug) problems.push("it has no usable slug.");
  for (let n = 2; takenSlugs.has(slug); n++) slug = `${slugify(article.slug || article.title).slice(0, 75)}-${n}`;

  return { problems, cleaned: { ...article, slug, source_urls: sourceUrls } };
}

/** On GitHub Actions, shows the article on the run's Summary page (contains article text only, no secrets). */
function writeRunSummary(row, saved) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## ${saved ? "✅ Saved as draft" : "👀 Dry run — not saved"}: ${row.title}`,
    "",
    "| Field | Value |",
    "|---|---|",
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

async function main() {
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // All statuses (drafts too), so we never write the same piece twice.
  const { data: existing, error: loadError } = await supabase
    .from("articles")
    .select("slug,title")
    .order("created_at", { ascending: false })
    .limit(300);
  if (loadError) throw new Error(`Could not read existing articles: ${loadError.message}`);

  const takenSlugs = new Set(existing.map((a) => a.slug));
  const category = todayCategory();
  console.log(`Category for today: ${category} · model: ${MODEL} · existing articles: ${existing.length}`);

  const { notes, sources } = await research(category, existing.map((a) => a.title));
  console.log(`Research done: ${sources.length} cited source(s).`);
  if (sources.length < MIN_SOURCES) throw new Error(`Research found only ${sources.length} citable source(s); skipping today.`);

  const allowedUrls = new Set(sources.map((s) => s.url));
  let result = validate(await write(category, notes, sources), allowedUrls, takenSlugs);
  if (result.problems.length) {
    console.warn(`First draft rejected: ${result.problems.join(" ")} Retrying once.`);
    result = validate(await write(category, notes, sources, result.problems.join(" ")), allowedUrls, takenSlugs);
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
    status: "draft", // never published automatically
  };

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — not saving. Article:\n" + JSON.stringify(row, null, 2));
    writeRunSummary(row, false);
    return;
  }

  const { error: insertError } = await supabase.from("articles").insert(row);
  if (insertError) throw new Error(`Could not save draft: ${insertError.message}`);
  writeRunSummary(row, true);
  console.log(`Saved draft "${row.title}" (/journal/${row.slug}). Review it in Supabase, then set status to 'scheduled' or 'published'.`);
}

main().catch((err) => {
  if (err instanceof Anthropic.AuthenticationError) console.error("Anthropic API key is missing or invalid.");
  else if (err instanceof Anthropic.RateLimitError) console.error("Anthropic rate limit reached — try again later.");
  else if (err instanceof Anthropic.APIError) console.error(`Anthropic API error ${err.status}: ${err.message}`);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
