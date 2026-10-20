/**
 * Travel-article generator for Nomad Travel Blog (Gemini + Wikivoyage/Wikipedia/Commons + Supabase).
 *
 * Each article:
 *   1. Gemini suggests destinations worldwide (favouring continents the site covers least).
 *   2. The script gathers real material for free, no keys needed:
 *        - the destination's Wikivoyage and Wikipedia pages (price/visa sections removed)
 *        - hotels from Wikivoyage listings, each official website loaded live (prices discarded)
 *        - photos from Wikimedia Commons with an open licence, author and licence recorded for credits
 *   3. Gemini writes the article (one of six practical types) from that material only.
 *   4. The script adds the hotel section itself, so hotel names, locations and links are never invented.
 *   5. Checks: structure, sources, links, length, title, and NO pricing/visa/insurance content.
 *      Failing articles are retried once, then skipped — never saved.
 *   6. Saves to Supabase as published (PUBLISH=1) or draft, with destination/country/continent/images metadata.
 *
 * Exactly-N-per-day: with DAILY_TARGET=2 (scheduled runs), the script first counts today's (UTC) daily articles
 * and only creates the missing ones — so a backup run or a re-run never publishes extra articles.
 *
 * Env vars (GitHub Actions secrets — never commit these):
 *   GEMINI_API_KEY, SUPABASE_URL (https://<project>.supabase.co), SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   DAILY_TARGET        articles per UTC day for scheduled runs (e.g. 2)
 *   ARTICLES_PER_RUN    articles for manual runs (default 1)
 *   PUBLISH=1           publish immediately (otherwise drafts)
 *   DRY_RUN=1           show the articles instead of saving them
 *   GEMINI_MODEL        defaults to gemini-3.8-flash (free tier for text)
 */
import { appendFileSync } from "node:fs";
import { ApiError as GeminiApiError, GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.env.DRY_RUN === "1";
const PUBLISH = process.env.PUBLISH === "1";
const DAILY_TARGET = Number.parseInt(process.env.DAILY_TARGET || "0", 10) || 0;
const ARTICLES_PER_RUN = Math.min(Math.max(Number.parseInt(process.env.ARTICLES_PER_RUN || "1", 10) || 1, 1), 4);
const GENERATED_BY = DAILY_TARGET ? "daily-workflow" : "manual";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const CONTINENTS = ["Africa", "Asia", "Europe", "North America", "South America", "Oceania"];
const MIN_INTERNAL_LINKS = 2;
const MAX_FAILED_WRITES = 3; // extra destinations to try in one run if articles fail their checks

/**
 * The six article types. Two are created per day, rotating so every type appears every three days.
 * `needs` = Wikivoyage sections that must have real content for this type.
 */
const ARTICLE_TYPES = [
  {
    category: "Destination Guides",
    titleHint: 'e.g. "Kotor Travel Guide: Old Town Walls, Bay Views and Where to Stay"',
    angle: "a complete destination guide: why the place is famous, what to see and do, food, culture, getting around and a 3-day itinerary",
    headings: ["Why {d} is famous", "Top attractions", "Things to do", "Food and drink", "Local culture", "Getting there and around", "Suggested itinerary"],
    itinerary: true,
    hotels: { min: 2, max: 4 },
    needs: [["See", "Do"], ["Eat", "Drink"]],
  },
  {
    category: "Attractions",
    titleHint: 'e.g. "Famous Attractions in Hoi An: The Japanese Bridge, Old Town Assembly Halls and An Bang Beach"',
    angle: "the most famous sights and natural wonders, why each is famous and how best to visit (opening patterns only if stated in the sources)",
    headings: ["Why {d} draws visitors", "Must-see attractions", "Natural wonders and outdoor sights", "Unique experiences", "Tips for visiting", "How to see it all in two days"],
    itinerary: true,
    needs: [["See"], ["Do"]],
  },
  {
    category: "Food & Drink",
    titleHint: 'e.g. "What to Eat in Hoi An: Cao Lầu, White Rose Dumplings and Where to Try Them"',
    angle: "local food culture, traditional dishes (one ### heading per dish), drinks, and named places to eat from the sources",
    headings: ["The food culture of {d}", "Traditional dishes to try", "Where to eat", "Drinks to try", "Food etiquette and tips"],
    needs: [["Eat"]],
  },
  {
    category: "Hotels",
    titleHint: 'e.g. "Where to Stay in Kotor: Best Areas and Verified Hotels"',
    angle: "where to stay: the best areas or neighbourhoods to base yourself and what each is like, and how to choose (no prices)",
    headings: ["Best areas to stay in {d}", "How to choose your base", "Getting around from your hotel"],
    hotels: { min: 3, max: 6 },
    needs: [["Get around", "See"]],
  },
  {
    category: "Culture",
    titleHint: 'e.g. "Kotor Culture Guide: Maritime History, Festivals and Local Customs"',
    angle: "history in brief, local customs and etiquette, festivals and events, arts, crafts and music, and how to travel respectfully",
    headings: ["A short history of {d}", "Local customs and etiquette", "Festivals and events", "Arts, crafts and music", "Travelling respectfully"],
    needs: [["Understand"]],
  },
  {
    category: "Travel Tips",
    titleHint: 'e.g. "Hoi An Travel Tips: Getting There, Getting Around and What to Know Before You Go"',
    angle: "practical visitor information: best time to visit, getting there, getting around, staying connected, staying safe and local etiquette",
    headings: ["Best time to visit {d}", "Getting there", "Getting around", "Staying connected", "Staying safe and healthy", "Local etiquette"],
    needs: [["Get around", "Get in"], ["Understand", "Stay safe", "Connect", "Respect"]],
  },
];

/** Pages on the website that articles can link to (besides other published articles). */
const SITE_LINKS = [
  { href: "/destinations", title: "Destinations around the world" },
  { href: "/category/attractions", title: "Famous attractions" },
  { href: "/category/food-and-drink", title: "Food and drink guides" },
  { href: "/category/hotels", title: "Where to stay" },
  { href: "/category/culture", title: "Culture and traditions" },
  { href: "/category/travel-tips", title: "Travel tips" },
];

/** Topics the site never covers. */
const EXCLUDED_TOPICS =
  "prices, costs, budgets, rates, fees, fares, admission charges, currency amounts, price comparisons or anything about " +
  "how cheap or expensive something is; visas or entry requirements; residency or tax rules; travel insurance";

/** Final safety net on the whole article: any match rejects it. */
const EXCLUDED_PATTERN =
  /\bvisas?\b|\bcosts?\b|\bbudget(?:s|ing)?\b|\bprice[sd]?\b|\bpricing\b|\bpricey\b|\bcheap(?:er|est|ly)?\b|\b(?:in)?expensive\b|\baffordab(?:le|ility)\b|\brates?\b|\bfares?\b|\bfees?\b|\bdiscount(?:s|ed)?\b|\bbargains?\b|\bsalar(?:y|ies)\b|\binsurance\b|[€£¥₹₫฿₩$]\s?\d|\b\d[\d,.]*\s?(?:USD|EUR|GBP|JPY|THB|VND|INR|dollars?|euros?|pounds?|yen|baht|dong|rupees?|pesos?|lira|kuna|dirhams?)\b/i;

/** Stricter filter for source text and hotel data (also catches "free", "admission", …). */
const PRICE_TEXT = new RegExp(`${EXCLUDED_PATTERN.source}|\\bfree\\b|\\badmission\\b|\\bpaid\\b|\\bpay\\b|\\btickets? (?:cost|from)\\b|\\bvalue for money\\b|\\bsplurge\\b`, "i");

/** Booking/aggregator and social-media sites are skipped — only hotels' own websites are linked. */
const AGGREGATOR_HOST =
  /(^|\.)(booking|agoda|expedia|hotels|hostelworld|airbnb|tripadvisor|trivago|kayak|priceline|trip|facebook|fb|instagram|twitter|x|tiktok|wa|whatsapp|linktr|google|goo)\.(com|net|me|ee|gl|co\.[a-z]+|[a-z]{2})$/i;

/** Amenities recognised in a listing's description. The description itself is never copied. */
const AMENITIES = [
  [/\b(?:swimming )?pools?\b/i, "swimming pool"],
  [/\bwi-?fi\b|\binternet\b/i, "Wi-Fi"],
  [/\bgardens?\b/i, "garden"],
  [/\bprivate beach\b|\bbeach(?:front|side)?\b/i, "beach access"],
  [/\brestaurants?\b/i, "restaurant"],
  [/\bbar\b|\brooftop bar\b/i, "bar"],
  [/\bspa\b|\bmassages?\b/i, "spa"],
  [/\bsauna\b/i, "sauna"],
  [/\bgym\b|\bfitness\b/i, "fitness room"],
  [/\b(?:shared |communal |guest )?kitchen\b|\bcooking area\b/i, "guest kitchen"],
  [/\bterrace\b|\brooftop\b/i, "terrace"],
  [/\bsea views?\b|\bocean views?\b|\bviews? of the (?:sea|bay|lake|mountains?|river)\b/i, "views"],
  [/\bair[- ]?con(?:ditioning|ditioned)?\b|\ba\/c\b/i, "air conditioning"],
  [/\bbicycles?\b|\bbikes?\b/i, "bicycles"],
  [/\bairport (?:transfers?|pick-?ups?|shuttle)\b/i, "airport transfers"],
  [/\bparking\b/i, "parking"],
  [/\btours?\b/i, "tours"],
  [/\b24[- ]?(?:hours?|hr|\/7) reception\b|\bopen 24 hours\b/i, "24-hour reception"],
  [/\bfamily rooms?\b/i, "family rooms"],
  [/\bdorms?\b|\bdormitor(?:y|ies)\b/i, "dorm rooms"],
  [/\bbungalows?\b/i, "bungalows"],
  [/\bhistoric\b|\brestor(?:ed|ation)\b/i, "historic building"],
];

const BRAND_VOICE = `You write for Nomad Travel Blog, a world travel guide and magazine.
Readers are planning real trips and want specific, practical, accurate answers.
Voice: vivid, warm and precise. Concrete details over hype. No clichés ("hidden gem", "bucket list", "paradise",
"wanderlust"), no filler, no philosophical musing, no emojis.
The site NEVER mentions: ${EXCLUDED_TOPICS}. Leave these out entirely, even if the sources mention them.
Never invent attractions, restaurants, dishes, hotels, opening hours, statistics or quotes. Only state what the provided sources support;
if something cannot be verified from them, leave it out.`;

/* ---------- Small helpers ---------- */

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

const fold = (s = "") => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

function slugify(text) {
  return fold(text).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeMd = (text) => text.replace(/([[\]])/g, "\\$1");
const decodeEntities = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const stripHtml = (s = "") => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function parseJson(text, step) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    throw new Error(`${step}: response was not valid JSON.`);
  }
}

/** Days since 1970-01-01 (UTC) — used to rotate article types. */
const utcDay = (date = new Date()) => Math.floor(date.getTime() / 86_400_000);

/* ---------- Wikimedia (free, no key) ---------- */

const WIKI_HEADERS = { "User-Agent": "NomadTravelBlogBot/1.0 (automated research for a travel blog; GitHub Actions)" };

/** Polite Wikimedia API call: a short pause before each request, and retries when rate-limited. */
async function wikiApi(site, params) {
  const url = `https://${site}/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  for (let attempt = 1; ; attempt++) {
    await sleep(500);
    try {
      const res = await fetch(url, { headers: WIKI_HEADERS, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt, 30_000);
        console.warn(`  ${site} is busy (${res.status}); waiting ${Math.round(waitMs / 1000)}s and retrying…`);
        await res.body?.cancel();
        await sleep(waitMs);
        continue;
      }
      throw new Error(`${site} returned ${res.status}`);
    } catch (err) {
      if (attempt < 4 && (err.name === "TimeoutError" || err.cause?.code === "ECONNRESET")) {
        console.warn(`  ${site} timed out; retrying…`);
        continue;
      }
      throw err;
    }
  }
}

/** Sections dropped before the AI sees the text (visa / price content; hotels are added separately). */
const EXCLUDED_SECTION =
  /^(visas?|entry requirements|customs|immigration|border (?:formalities|crossings?)|buy|sleep|budget|mid-?range|splurge|costs?|prices?|fees|money|economy|tickets?)$/i;

/** Plain text of a page: excluded sections (with their subsections) and any line mentioning prices removed. */
function cleanExtract(text, maxChars) {
  const kept = [];
  let skipLevel = 0;
  for (const line of text.split("\n")) {
    const heading = line.match(/^(=+)\s*(.+?)\s*=+$/);
    if (heading) {
      const level = heading[1].length;
      if (skipLevel && level > skipLevel) continue;
      skipLevel = EXCLUDED_SECTION.test(heading[2]) ? level : 0;
      if (!skipLevel) kept.push(`${"#".repeat(Math.min(level, 4))} ${heading[2]}`);
    } else if (!skipLevel && line.trim() && !PRICE_TEXT.test(line)) {
      kept.push(line.trim());
    }
  }
  return kept.join("\n").slice(0, maxChars);
}

/** Text of the given level-2 sections ("## See" etc.) from a cleaned extract. */
function sectionText(text, names) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out = [];
  let inSection = false;
  for (const line of text.split("\n")) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) inSection = wanted.has(h2[1].trim().toLowerCase());
    else if (inSection && !/^#/.test(line)) out.push(line);
  }
  return out.join("\n");
}

async function pageText(site, title, maxChars) {
  const page = (await wikiApi(site, {
    action: "query", prop: "extracts|info|pageimages", piprop: "name", inprop: "url", explaintext: "1",
    exsectionformat: "wiki", redirects: "1", titles: title,
  })).query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;
  return { title: page.title, url: page.fullurl, text: cleanExtract(page.extract, maxChars), leadImage: page.pageimage ?? null };
}

/* ---------- Hotels from Wikivoyage listings ---------- */

/** Top-level {{templates}} in wikitext. */
function topLevelTemplates(text) {
  const found = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== "{" || text[i + 1] !== "{") continue;
    let depth = 0;
    let j = i;
    while (j < text.length - 1) {
      if (text[j] === "{" && text[j + 1] === "{") { depth++; j += 2; }
      else if (text[j] === "}" && text[j + 1] === "}") { depth--; j += 2; if (depth === 0) break; }
      else j++;
    }
    found.push(text.slice(i + 2, j - 2));
    i = j - 1;
  }
  return found;
}

/** Splits template parameters on | that aren't inside nested {{ }} or [[ ]]. */
function templateParams(inner) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const two = inner.slice(i, i + 2);
    if (two === "{{" || two === "[[") { depth++; current += two; i++; continue; }
    if ((two === "}}" || two === "]]") && depth > 0) { depth--; current += two; i++; continue; }
    if (inner[i] === "|" && depth === 0) { parts.push(current); current = ""; continue; }
    current += inner[i];
  }
  parts.push(current);
  const params = { _name: parts.shift()?.trim().toLowerCase() ?? "" };
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return params;
}

function wikiToText(s = "") {
  return s
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1")
    .replace(/\[https?:\/\/\S+\]/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Loads the page and confirms it's the hotel's own working website. Returns the final URL or null. */
async function verifyWebsite(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (!/^https?:$/.test(protocol) || AGGREGATOR_HOST.test(hostname)) return null;
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NomadTravelBlogBot/1.0; link check)", Accept: "text/html" },
    });
    await res.body?.cancel();
    if (!res.ok) return null;
    const finalUrl = new URL(res.url || url);
    const a = finalUrl.hostname.replace(/^www\./, "");
    const b = hostname.replace(/^www\./, "");
    return a.endsWith(b) || b.endsWith(a) ? finalUrl.href : url;
  } catch {
    return null;
  }
}

/** Hotels from the page's Sleep listings with a working official website. Prices are never kept. */
async function verifiedHotels(wikivoyageTitle, max) {
  const wikitext = (await wikiApi("en.wikivoyage.org", { action: "parse", page: wikivoyageTitle, prop: "wikitext", redirects: "1" }))
    .parse?.wikitext;
  if (!wikitext) return [];

  const candidates = topLevelTemplates(wikitext)
    .map(templateParams)
    .filter((p) => p._name === "sleep" || (p._name === "listing" && p.type?.toLowerCase() === "sleep"))
    .map((p) => ({
      name: wikiToText(p.name),
      url: p.url?.trim(),
      address: wikiToText(p.address),
      directions: wikiToText(p.directions),
      checkin: wikiToText(p.checkin),
      checkout: wikiToText(p.checkout),
      // Only amenity labels recognised in the description are kept. The `price` field is ignored entirely.
      amenities: AMENITIES.filter(([pattern]) => pattern.test(wikiToText(p.content))).map(([, label]) => label),
      lastEdit: p.lastedit ?? "",
    }))
    .filter((h) => h.name && h.url && (h.address || h.directions) && !PRICE_TEXT.test(`${h.name} ${h.address} ${h.directions}`))
    .sort((a, b) => b.lastEdit.localeCompare(a.lastEdit)); // most recently checked listings first

  const hotels = [];
  for (const hotel of candidates) {
    if (hotels.length >= max) break;
    const website = await verifyWebsite(hotel.url);
    if (website) hotels.push({ ...hotel, url: website });
    else console.log(`  · skipped hotel "${hotel.name}" (website didn't load or isn't the hotel's own site)`);
  }
  return hotels;
}

function hotelSection(hotels, wikivoyageUrl) {
  const short = (s) => (s && s.length <= 25 && !PRICE_TEXT.test(s) ? s : "");
  const lines = [
    "## Where to stay",
    "",
    `These places to stay are based on [Wikivoyage's listings](${wikivoyageUrl}), and each hotel's official website was checked when this article was published. Please confirm details and availability directly with the hotel.`,
  ];
  for (const h of hotels) {
    const location = [h.address, h.directions && h.directions !== h.address ? h.directions : ""].filter(Boolean).join(" — ");
    const times = [short(h.checkin) && `check-in ${short(h.checkin)}`, short(h.checkout) && `check-out ${short(h.checkout)}`].filter(Boolean).join(", ");
    lines.push("", `### [${escapeMd(h.name)}](${h.url})`, "", `**Location:** ${location}`);
    if (h.amenities.length) lines.push("", `**Amenities mentioned in its listing:** ${h.amenities.join(", ")}.`);
    if (times) lines.push("", `**Times:** ${times.charAt(0).toUpperCase()}${times.slice(1)}.`);
    lines.push("", `**Official website:** [${new URL(h.url).hostname.replace(/^www\./, "")}](${h.url})`);
  }
  return lines.join("\n");
}

/* ---------- Photos from Wikimedia Commons ---------- */

const OPEN_LICENSE = /^(?:CC BY(?:-SA)? \d(?:\.\d)?(?: [a-z]{2,})?|CC0(?: \d\.\d)?|Public domain|PD.*)$/i;
const UNSUITABLE_FILE =
  /map|flag|logo|coat[_ ]of[_ ]arms|emblem|seal|locator|icon|banner|timetable|schedule|diagram|plan\b|chart|sign\b|signage|plaque|gedenktafel|inscription|stamp|coin|banknote|portrait|menu|ticket|receipt|price|poster|screenshot|document|letter|drawing|painting|engraving|postcard|\d{3,4}s?\b.*(?:photo|photograph)|airport|aeroport|aeropuerto|flughafen|station|terminal|parking|car park|construction|hospital|selfie/i;

function looksEnglish(text) {
  return /^[\x20-\x7E‘’“”–—À-ɏ]+$/.test(text) &&
    /\b(the|of|and|in|at|from|with|view|old|town|city|church|beach|bay|river|street|temple|market|bridge|island|lake|mountain|harbour|harbor|castle|palace|square|night|sunset|mosque|cathedral|valley)\b/i.test(text);
}

/** Descriptive alt text from the file's English description, or a cleaned-up file name. */
function altText(meta, fileTitle, destination, country) {
  let alt = stripHtml(meta.ImageDescription?.value ?? "");
  if (!alt || alt.length < 12 || alt.length > 160 || !looksEnglish(alt)) {
    alt = fileTitle
      .replace(/^File:/, "")
      .replace(/\.[a-z]+$/i, "")
      .replace(/_+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2") // EssaouiraBastion → Essaouira Bastion
      .replace(/([A-Za-z])(\d{3,})/g, "$1 $2")
      .replace(/\((?:[IVX]+|\d+)\)/g, "") // (I), (16922189291)
      .replace(/\b(?:19|20)\d{2}(?:-\d{2}){0,2}\b/g, "") // years and dates
      .replace(/\b[A-Z]{1,3}-?\d{1,4}\b/g, "") // camera codes like CN-06
      .replace(/\bimg\s?\d+\b|\bDSC\w*|\bIMG\w*|\b\d{2,}\b/gi, "")
      .replace(/["“”]/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/(?:\s*[-–,.])+\s*$/g, "")
      .replace(/^(?:\s*[-–,.])+\s*/g, "")
      .trim();
  }
  alt = alt
    .replace(/["“”]/g, "")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\.$/, "")
    .trim();
  const words = alt.split(/\s+/).filter(Boolean).length;
  const place = fold(destination).split(/[ ,(]/)[0];
  if (!alt || fold(alt) === fold(destination) || words < 2) alt = `View of ${destination}, ${country}`;
  else if (!fold(alt).includes(place)) alt = `${alt} in ${destination}`;
  else if (words < 3) alt = `${alt}, ${country}`;
  return PRICE_TEXT.test(alt) ? `View of ${destination}, ${country}` : alt;
}

/** Just the photographer's name from Commons' "Artist" field. */
function cleanAuthor(raw) {
  let a = stripHtml(raw)
    .replace(/\(\s*more photos\s*\)/gi, "")
    .replace(/\(WT-shared\)\s*/gi, "")
    .replace(/\s*at wts wikivoyage/gi, "")
    .replace(/\bUser:\s*/gi, "")
    .replace(/\(talk\)/gi, "");
  const takenBy = a.match(/taken by\s+([^.;]+)/i);
  if (takenBy) a = takenBy[1];
  a = a.split(/\s*[.;]\s+/)[0].replace(/\s{2,}/g, " ").replace(/[\s.,;:]+$/, "").trim();
  return a.slice(0, 60);
}

/** Cover + gallery photos with open licences. Returns [] if nothing suitable is found. */
async function destinationImages(destination, country, wikipediaTitle, wikivoyageTitle, leadImage) {
  const names = [];
  const add = (t) => { if (t && !names.includes(t)) names.push(t); };
  if (leadImage) add(`File:${leadImage.replace(/_/g, " ")}`);
  for (const [site, title] of [["en.wikivoyage.org", wikivoyageTitle], ["en.wikipedia.org", wikipediaTitle]]) {
    const page = (await wikiApi(site, { action: "query", prop: "images", imlimit: "60", redirects: "1", titles: title })).query?.pages?.[0];
    for (const img of page?.images ?? []) add(img.title);
  }
  const files = names.filter((t) => /\.jpe?g$/i.test(t) && !UNSUITABLE_FILE.test(t)).slice(0, 45);
  if (!files.length) return [];

  const info = await wikiApi("en.wikipedia.org", {
    action: "query", prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1920",
    iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|ImageDescription|Restrictions",
    titles: files.join("|"),
  });
  const byTitle = new Map((info.query?.pages ?? []).map((p) => [p.title, p]));

  const images = [];
  for (const title of files) {
    const ii = byTitle.get(title)?.imageinfo?.[0];
    const meta = ii?.extmetadata ?? {};
    const license = stripHtml(meta.LicenseShortName?.value ?? "");
    const author = cleanAuthor(meta.Artist?.value ?? "");
    if (!ii?.thumburl || ii.mime !== "image/jpeg" || ii.width < 1600 || ii.width / ii.height < 1.2) continue;
    if (!OPEN_LICENSE.test(license) || stripHtml(meta.Restrictions?.value ?? "") || !author) continue;
    const url = ii.thumburl.replace(/\?.*$/, "");
    images.push({
      url,
      alt: altText(meta, title, destination, country),
      author,
      license,
      license_url: meta.LicenseUrl?.value ?? null,
      file_url: ii.descriptionurl,
      credit: `${author} / ${license}`,
    });
  }

  // Make sure the cover actually loads before relying on it.
  while (images.length) {
    try {
      const res = await fetch(images[0].url, { method: "HEAD", headers: WIKI_HEADERS, signal: AbortSignal.timeout(15_000) });
      if (res.ok && /^image\//.test(res.headers.get("content-type") ?? "")) break;
    } catch { /* try the next one */ }
    images.shift();
  }
  // Gallery images are served at 1280px (a standard Wikimedia size); the cover stays at 1920px.
  return images.slice(0, 7).map((img, i) => (i === 0 ? img : { ...img, url: img.url.replace(/\/1920px-/, "/1280px-") }));
}

/* ---------- Research for one destination + article type ---------- */

async function research(candidate, type) {
  const voyage = await pageText("en.wikivoyage.org", candidate.wikivoyage_title, 18_000);
  if (!voyage || voyage.text.length < 3000) return { skip: "Wikivoyage page missing or too short" };
  for (const group of type.needs) {
    if (sectionText(voyage.text, group).length < 600) return { skip: `Wikivoyage page has too little "${group.join("/")}" content` };
  }

  let wikipedia = null;
  const search = await wikiApi("en.wikipedia.org", {
    action: "query", list: "search", srsearch: `${candidate.wikivoyage_title} ${candidate.country}`, srlimit: "1",
  });
  const hit = search.query?.search?.[0]?.title;
  if (hit) {
    const page = await pageText("en.wikipedia.org", hit, 7000);
    if (page && page.text.length >= 800 && !/may refer to/i.test(page.text)) wikipedia = page;
  }
  if (!wikipedia) return { skip: "no matching Wikipedia article" };

  let hotels = [];
  if (type.hotels) {
    hotels = await verifiedHotels(voyage.title, type.hotels.max);
    if (hotels.length < type.hotels.min) return { skip: `only ${hotels.length} hotel(s) with a verified website` };
  }

  // Display name without Wikivoyage's disambiguation, e.g. "Queenstown (New Zealand)" → "Queenstown".
  const destination = voyage.title.replace(/\s*\([^)]*\)\s*$/, "").trim() || voyage.title;

  const images = await destinationImages(destination, candidate.country, wikipedia.title, voyage.title, wikipedia.leadImage);
  if (!images.length) return { skip: "no openly licensed landscape photo found" };

  return {
    destination,
    country: candidate.country,
    continent: candidate.continent,
    sources: [
      { url: voyage.url, title: `${voyage.title} (Wikivoyage)`, text: voyage.text },
      { url: wikipedia.url, title: `${wikipedia.title} (Wikipedia)`, text: wikipedia.text },
    ],
    hotels,
    images,
    wikivoyageUrl: voyage.url,
  };
}

/* ---------- Prompts & schemas ---------- */

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["destinations"],
  properties: {
    destinations: {
      type: "array",
      minItems: 8,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["wikivoyage_title", "country", "continent"],
        properties: {
          wikivoyage_title: { type: "string", description: "Exact title of the English Wikivoyage article" },
          country: { type: "string" },
          continent: { type: "string", enum: CONTINENTS },
        },
      },
    },
  },
};

function planPrompt(coveredDestinations, continentCounts) {
  const order = [...CONTINENTS].sort((a, b) => (continentCounts[a] ?? 0) - (continentCounts[b] ?? 0));
  return `Suggest 10 famous or remarkable travel destinations worldwide for practical travel articles.
Each must be the exact title of an English Wikivoyage article about a city, town, island or compact region with rich
See, Do, Eat and Sleep sections. Avoid countries, and avoid huge cities split into district articles (Tokyo, London, Paris, New York, etc.).
Prefer places travellers genuinely search for: famous sights, natural wonders, beaches, mountains, historic towns, food capitals.
Spread them across continents and countries, prioritising these continents in this order (least covered first): ${order.join(", ")}.
Destinations the site already covers (you may repeat one only if it is especially rich):
${coveredDestinations.length ? coveredDestinations.join(", ") : "(none yet)"}`;
}

const ARTICLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "slug", "excerpt", "seo_title", "seo_description", "content", "source_urls"],
  properties: {
    title: { type: "string", description: "Specific, descriptive headline that names the destination, 50–90 characters" },
    slug: { type: "string", description: "lowercase-words-with-hyphens including the destination, under 80 characters" },
    excerpt: { type: "string", description: "1–2 sentences answering what the article helps the reader do, under 200 characters" },
    seo_title: { type: "string", description: "Search title with the destination name, under 60 characters" },
    seo_description: { type: "string", description: "Meta description, 120–155 characters" },
    content: { type: "string", description: "The article body in Markdown, following the required structure" },
    source_urls: { type: "array", items: { type: "string" }, description: "Source URLs from the list that the article relies on" },
  },
};

function headingsFor(type, destination) {
  return type.headings.map((h) => h.replace("{d}", destination));
}

function writePrompt(type, r, internalLinks, feedback) {
  const headings = headingsFor(type, r.destination);
  return `Write a "${type.category}" article about ${r.destination}, ${r.country}: ${type.angle}.
Use ONLY the sources below.

<sources>
${r.sources.map((s, i) => `[Source ${i + 1}] ${s.title} — ${s.url}\n${s.text}`).join("\n\n")}
</sources>

<internal_links>
${internalLinks.map((l) => `- [${l.title}](${l.href})`).join("\n")}
</internal_links>

Requirements:
- Title: specific and descriptive, naming ${r.destination} and what the reader will learn (${type.titleHint}). Not vague or philosophical.
- Markdown, 1000–1500 words, in your own words — never copy sentences from the sources.
- Start with a short introduction that says why ${r.destination} is worth reading about (no heading).
- Then exactly these ## headings, in this order:
${headings.map((h) => `  ## ${h}`).join("\n")}
- Use ### subheadings for individual attractions, dishes, areas or days where it helps the reader.${
    type.itinerary ? "\n- The last section is a day-by-day plan with ### Day 1, ### Day 2 (and ### Day 3 if it fits) subheadings." : ""
  }
- ${type.hotels ? "Do NOT write a \"Where to stay\" section or name any hotels — verified hotel listings are added automatically after your text." : "Do not name hotels."}
- Answer the questions a traveller actually has. Leave out anything the sources don't support.
- Link to ${MIN_INTERNAL_LINKS}–4 of the internal links above where they fit naturally, using exactly those URLs. No other links.
- Never mention ${EXCLUDED_TOPICS}.
For source_urls, list the source URLs above that the article relies on.${
    feedback ? `\n\nYour previous draft was rejected: ${feedback} Fix this in the new draft.` : ""
  }`;
}

/* ---------- Gemini ---------- */

let ai = null;

function describeGeminiError(err) {
  if (!(err instanceof GeminiApiError)) return null;
  if (err.status === 429) return "Gemini free-tier limit reached (too many requests today or this minute). The backup run will try again later.";
  if (err.status === 400 && /api key/i.test(err.message)) return "GEMINI_API_KEY is invalid. Create a new key in Google AI Studio and update the secret.";
  if (err.status === 403) return "GEMINI_API_KEY is not allowed to use this model or API. Check the key in Google AI Studio.";
  if (err.status === 404) return `Gemini model "${GEMINI_MODEL}" isn't available to this key. Set a GEMINI_MODEL repository variable to a current model (see ai.google.dev/gemini-api/docs/models). Details: ${err.message}`;
  return `Gemini API error ${err.status}: ${err.message}`;
}

/** Gemini call with JSON output and retries for temporary errors (busy/overloaded/per-minute limits). */
async function geminiJson(prompt, schema, step) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: { systemInstruction: BRAND_VOICE, responseMimeType: "application/json", responseJsonSchema: schema },
      });
      const blocked = res.promptFeedback?.blockReason;
      if (blocked) throw new Error(`${step}: Gemini blocked the request (${blocked}).`);
      const reason = res.candidates?.[0]?.finishReason;
      if (reason && reason !== "STOP") throw new Error(`${step}: Gemini stopped early (${reason}).`);
      return parseJson(res.text, step);
    } catch (err) {
      const temporary = err instanceof GeminiApiError && (err.status >= 500 || (err.status === 429 && !/per ?day|daily/i.test(err.message)));
      if (temporary && attempt < 4) {
        const waitMs = 20_000 * attempt;
        console.warn(`  Gemini temporarily unavailable (${err.status}); retrying in ${waitMs / 1000}s (attempt ${attempt + 1} of 4)…`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

/* ---------- Validation ---------- */

function validate(type, article, r, internalLinks, takenSlugs) {
  const problems = [];
  const sourceUrls = r.sources.map((s) => s.url);
  const allowedLinks = new Set([...sourceUrls, ...internalLinks.map((l) => l.href)]);
  const internalHrefs = new Set(internalLinks.map((l) => l.href));

  // Never trust a model-written hotel section; ours is added below.
  const body = (article.content ?? "").replace(/^\s*##\s*Where to stay[\s\S]*$/im, "").trim();
  const content = type.hotels ? `${body}\n\n${hotelSection(r.hotels, r.wikivoyageUrl)}` : body;

  const links = [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const badLinks = links.filter((href) => !allowedLinks.has(href));
  if (badLinks.length) problems.push(`it contains links that aren't in the provided lists (${badLinks.slice(0, 3).join(", ")}).`);
  const internalCount = new Set(links.filter((href) => internalHrefs.has(href))).size;
  if (internalCount < MIN_INTERNAL_LINKS) problems.push(`it links to only ${internalCount} internal page(s); use at least ${MIN_INTERNAL_LINKS} from the internal links list.`);

  for (const heading of headingsFor(type, r.destination)) {
    const pattern = new RegExp(`^##\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "im");
    if (!pattern.test(body)) problems.push(`it is missing the "## ${heading}" section.`);
  }
  if (type.itinerary && !/^###\s*Day 1/im.test(body)) problems.push('the itinerary has no "### Day 1" subheading.');
  if (!type.hotels && r.hotels.some((h) => body.includes(h.name))) problems.push("it names hotels, which this article type must not do.");

  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < 700) problems.push(`it is too short (${words} words).`);
  if (!fold(article.title ?? "").includes(fold(r.destination).split(/[ ,(]/)[0])) problems.push(`the title must name ${r.destination}.`);

  const banned = `${article.title}\n${article.excerpt}\n${article.seo_title}\n${article.seo_description}\n${content}`.match(EXCLUDED_PATTERN);
  if (banned) problems.push(`it mentions pricing or another excluded topic ("${banned[0]}") — the site never includes prices, costs or visas.`);

  const cited = [...new Set(article.source_urls ?? [])].filter((u) => sourceUrls.includes(u));
  const finalSources = cited.length >= 2 ? cited : sourceUrls; // both sources were used as research

  let slug = slugify(article.slug || article.title || "");
  if (!slug) problems.push("it has no usable slug.");
  for (let n = 2; takenSlugs.has(slug); n++) slug = `${slugify(article.slug || article.title).slice(0, 75)}-${n}`;

  return { problems, cleaned: { ...article, slug, content, source_urls: finalSources } };
}

/** On GitHub Actions, shows each article on the run's Summary page (article text only, no secrets). */
function writeRunSummary(row, saved, r) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");
  appendFileSync(file, [
    `## ${!saved ? "👀 Dry run — not saved" : row.status === "published" ? "🚀 Published" : "✅ Saved as draft"}: ${row.title}`,
    "",
    "| Field | Value |",
    "|---|---|",
    `| Type | ${cell(row.category)} |`,
    `| Destination | ${cell(`${row.destination}, ${row.country} (${row.continent})`)} |`,
    `| URL on the site | \`/journal/${row.slug}\` |`,
    `| SEO title | ${cell(row.seo_title)} |`,
    `| Meta description | ${cell(row.seo_description)} |`,
    `| Photos | ${row.images.length} (cover: ${cell(row.cover_image_alt)}) |`,
    `| Verified hotels | ${cell(r.hotels.map((h) => h.name).join(", ") || "—")} |`,
    "",
    `![${row.cover_image_alt}](${row.cover_image_url})`,
    "",
    "---",
    "",
    row.content,
    "",
  ].join("\n"));
}

/* ---------- Main ---------- */

async function main() {
  ai = new GoogleGenAI({
    apiKey: requireEnv("GEMINI_API_KEY"),
    // Only for local testing against a fake server; unset in GitHub Actions.
    ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}),
  });
  const supabase = createClient(supabaseUrl(), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Everything (drafts too), so nothing is ever duplicated.
  const { data: existing, error: loadError } = await supabase
    .from("articles")
    .select("slug,title,status,category,destination,continent,generated_by,created_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (loadError) throw new Error(`Could not read existing articles: ${loadError.message.slice(0, 300)}`);

  // How many to create now.
  const todayStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const doneToday = existing.filter((a) => a.generated_by === "daily-workflow" && new Date(a.created_at) >= todayStart).length;
  const toCreate = DAILY_TARGET ? Math.max(0, DAILY_TARGET - doneToday) : ARTICLES_PER_RUN;
  if (DAILY_TARGET) console.log(`Daily target: ${DAILY_TARGET} · already created today (UTC): ${doneToday}`);
  if (toCreate === 0) {
    console.log("Today's articles already exist — nothing to do.");
    return;
  }

  // Article types for this run, rotating by day so all six types appear every three days.
  // Manual runs may pick one type with ARTICLE_TYPE (e.g. "Food & Drink").
  const forcedType = !DAILY_TARGET && process.env.ARTICLE_TYPE ? ARTICLE_TYPES.find((t) => t.category === process.env.ARTICLE_TYPE) : null;
  if (!DAILY_TARGET && process.env.ARTICLE_TYPE && !forcedType) {
    throw new Error(`Unknown ARTICLE_TYPE "${process.env.ARTICLE_TYPE}". Use one of: ${ARTICLE_TYPES.map((t) => t.category).join(", ")}.`);
  }
  const firstSlot = utcDay() * 2 + (DAILY_TARGET ? doneToday : 0);
  const typesForRun = Array.from({ length: toCreate }, (_, k) => forcedType ?? ARTICLE_TYPES[(firstSlot + k) % ARTICLE_TYPES.length]);

  const taken = new Set(existing.filter((a) => a.destination).map((a) => `${fold(a.destination)}|${a.category}`));
  const takenSlugs = new Set(existing.map((a) => a.slug));
  const published = existing.filter((a) => a.status === "published" && a.destination);
  const continentCounts = Object.fromEntries(CONTINENTS.map((c) => [c, published.filter((a) => a.continent === c).length]));
  const coveredDestinations = [...new Set(existing.filter((a) => a.destination).map((a) => a.destination))].slice(0, 120);

  console.log(`AI: Gemini (${GEMINI_MODEL}) · mode: ${DRY_RUN ? "dry run" : PUBLISH ? "publish" : "draft"} · creating: ${typesForRun.map((t) => t.category).join(" + ")}`);

  const plan = await geminiJson(planPrompt(coveredDestinations, continentCounts), PLAN_SCHEMA, "Planning");
  const candidates = (plan.destinations ?? []).filter((d) => d.wikivoyage_title?.trim() && CONTINENTS.includes(d.continent));
  console.log(`Destination ideas: ${candidates.map((d) => `${d.wikivoyage_title} (${d.continent})`).join(", ")}`);

  const usedThisRun = new Set();
  let created = 0;
  let failedWrites = 0;

  for (const type of typesForRun) {
    let done = false;
    for (const candidate of candidates) {
      if (failedWrites > MAX_FAILED_WRITES) break;
      const key = fold(candidate.wikivoyage_title);
      if (usedThisRun.has(key) || taken.has(`${key}|${type.category}`)) continue;

      console.log(`\n[${type.category}] Researching ${candidate.wikivoyage_title}, ${candidate.country}…`);
      const r = await research(candidate, type);
      if (r.skip) {
        console.log(`  · skipped: ${r.skip}`);
        usedThisRun.add(key);
        continue;
      }
      if (taken.has(`${fold(r.destination)}|${type.category}`)) { usedThisRun.add(key); continue; } // redirect to a covered page
      console.log(`  ✓ sources: ${r.sources.length} · photos: ${r.images.length} · verified hotels: ${r.hotels.map((h) => h.name).join(", ") || "—"}`);

      // Internal links: site sections + the most relevant published articles (same destination, then same continent).
      const related = existing
        .filter((a) => a.status === "published" && a.slug)
        .sort((a, b) => Number(fold(b.destination ?? "") === fold(r.destination)) - Number(fold(a.destination ?? "") === fold(r.destination)) ||
          Number(b.continent === r.continent) - Number(a.continent === r.continent))
        .slice(0, 10)
        .map((a) => ({ href: `/journal/${a.slug}`, title: a.title }));
      const internalLinks = [...SITE_LINKS, ...related];

      let result = validate(type, await geminiJson(writePrompt(type, r, internalLinks), ARTICLE_SCHEMA, "Writing"), r, internalLinks, takenSlugs);
      if (result.problems.length) {
        console.warn(`  First draft rejected: ${result.problems.join(" ")} Retrying once.`);
        result = validate(type, await geminiJson(writePrompt(type, r, internalLinks, result.problems.join(" ")), ARTICLE_SCHEMA, "Writing"),
          r, internalLinks, takenSlugs);
      }
      usedThisRun.add(key);
      if (result.problems.length) {
        console.warn(`  Skipping ${r.destination}: ${result.problems.join(" ")}`);
        failedWrites++;
        continue;
      }

      const a = result.cleaned;
      const row = {
        title: a.title.trim(),
        slug: a.slug,
        excerpt: a.excerpt.trim(),
        content: a.content.trim(),
        category: type.category,
        seo_title: a.seo_title.trim(),
        seo_description: a.seo_description.trim(),
        source_urls: a.source_urls,
        destination: r.destination,
        country: r.country,
        continent: r.continent,
        cover_image_url: r.images[0].url,
        cover_image_alt: r.images[0].alt,
        images: r.images,
        generated_by: GENERATED_BY,
        ...(PUBLISH ? { status: "published", published_at: new Date().toISOString() } : { status: "draft" }),
      };

      if (DRY_RUN) {
        console.log(`  DRY_RUN=1 — not saving (a real run would save it as ${row.status}). Article:\n` +
          JSON.stringify({ ...row, content: `${row.content.slice(0, 600)}… (${row.content.length} chars)` }, null, 2));
        writeRunSummary(row, false, r);
      } else {
        const { error: insertError } = await supabase.from("articles").insert(row);
        if (insertError?.code === "23505") {
          console.warn(`  Skipping ${r.destination}: an article of this type for this destination (or this URL) already exists.`);
          taken.add(`${fold(r.destination)}|${type.category}`);
          continue;
        }
        if (insertError) throw new Error(`Could not save "${row.title}": ${insertError.message.slice(0, 300)}`);
        writeRunSummary(row, true, r);
        console.log(row.status === "published"
          ? `  🚀 Published "${row.title}" — on the site at /journal/${row.slug}`
          : `  ✅ Saved draft "${row.title}" (/journal/${row.slug}).`);
        if (row.status === "published") existing.unshift({ ...row, created_at: new Date().toISOString() });
      }
      taken.add(`${fold(r.destination)}|${type.category}`);
      takenSlugs.add(row.slug);
      created++;
      done = true;
      break;
    }
    if (!done) console.warn(`\nCould not create a "${type.category}" article this run.`);
  }

  if (created < toCreate) {
    throw new Error(`Created ${created} of ${toCreate} article(s). ${DAILY_TARGET ? "The backup run later today will try to fill the gap." : ""}`);
  }
  console.log(`\nDone: ${created} article(s) ${DRY_RUN ? "generated (dry run)" : PUBLISH ? "published" : "saved as drafts"}.`);
}

main().catch((err) => {
  console.error(describeGeminiError(err) ?? (err instanceof Error ? err.message : err));
  process.exit(1);
});
