/**
 * Publishes articles you've approved: any row with status = 'scheduled' whose
 * published_at time has arrived becomes 'published' (and appears on the site
 * within ~5 minutes). Drafts are never touched.
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional DRY_RUN=1.
 */
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main() {
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const now = new Date().toISOString();

  const { data: due, error: findError } = await supabase
    .from("articles")
    .select("id,slug,title,published_at")
    .eq("status", "scheduled")
    .lte("published_at", now);
  if (findError) throw new Error(`Could not read scheduled articles: ${findError.message}`);

  if (!due.length) {
    console.log("No scheduled articles are due.");
    return;
  }
  for (const a of due) console.log(`Due: "${a.title}" (/journal/${a.slug}), scheduled for ${a.published_at}`);

  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN=1 — not publishing.");
    return;
  }

  const { error: updateError } = await supabase
    .from("articles")
    .update({ status: "published", updated_at: now })
    .in("id", due.map((a) => a.id))
    .eq("status", "scheduled"); // only rows still scheduled
  if (updateError) throw new Error(`Could not publish: ${updateError.message}`);

  console.log(`Published ${due.length} article(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
