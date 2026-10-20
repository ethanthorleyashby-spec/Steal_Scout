// GET /api/search?q=air+fryer+at+least+5+quarts+under+$90
// Allowed: logged-in members (trialing or active in Stripe), or testers sending
// the header  x-access-code: <ACCESS_CODE>.
// Env vars (set in Netlify > Site configuration > Environment variables):
//   SERPAPI_KEY  - your SerpApi key (never put it in the website code)
//   ACCESS_CODE  - optional tester password
//   STRIPE_SECRET_KEY, SESSION_SECRET - for member logins (see SETUP.md)
import { parseQuery, normalize, rank, firstNormalResult } from "../lib/rank.mjs";
import { authorize } from "../lib/auth.mjs";
import { json as jsonWithCookie } from "../lib/session.mjs";

const SERPAPI = "https://serpapi.com/search.json";
const json = (status, body, cookie) => jsonWithCookie(status, body, cookie);

async function serp(params, key) {
  const url = `${SERPAPI}?${new URLSearchParams({ ...params, api_key: key })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `SerpApi returned ${res.status}`);
  return data;
}

export default async (req) => {
  const key = process.env.SERPAPI_KEY;
  if (!key) return json(500, { error: "Search isn't configured yet. Add SERPAPI_KEY in Netlify." });

  const givenCode = req.headers.get("x-access-code");
  if (givenCode && givenCode !== process.env.ACCESS_CODE) return json(401, { error: "Wrong access code.", reason: "code" });

  let who;
  try {
    who = await authorize(req);
  } catch (err) {
    console.error("auth failed:", err.message);
    return json(502, { error: "Couldn't check your membership right now. Try again in a minute." });
  }
  if (!who.ok) return json(who.status, { error: who.error, reason: who.reason }, who.cookie);

  const q = new URL(req.url).searchParams.get("q")?.trim() || "";
  if (q.length < 3) return json(400, { error: "Type what you're looking for, like \"air fryer under $90\"." });
  if (q.length > 200) return json(400, { error: "Keep searches under 200 characters." });

  const plan = parseQuery(q);
  if (!plan.searchText) return json(400, { error: "Add what you're shopping for, not just a price." });

  const gParams = { engine: "google_shopping", q: plan.searchText, gl: "us", hl: "en" };
  if (plan.maxPrice != null) gParams.max_price = String(plan.maxPrice);
  if (plan.minPrice != null) gParams.min_price = String(plan.minPrice);
  const eParams = { engine: "ebay", _nkw: plan.searchText, ebay_domain: "ebay.com" };
  if (plan.maxPrice != null) eParams._udhi = String(plan.maxPrice);
  if (plan.minPrice != null) eParams._udlo = String(plan.minPrice);
  if (plan.condition === "new") eParams.LH_ItemCondition = "1000";

  const [g, e] = await Promise.allSettled([serp(gParams, key), serp(eParams, key)]);
  const google = g.status === "fulfilled" ? g.value : null;
  const ebay = e.status === "fulfilled" ? e.value : null;
  const warnings = [];
  if (!google) warnings.push(`Store results unavailable: ${g.reason?.message || "unknown error"}`);
  if (!ebay) warnings.push(`eBay results unavailable: ${e.reason?.message || "unknown error"}`);
  if (!google && !ebay) return json(502, { error: "Couldn't reach the shopping sources. Try again in a minute.", warnings });

  const { items, removed: r1 } = normalize(google, ebay);
  const { results, removed: r2 } = rank(plan, items);
  const first = firstNormalResult(google);
  const best = results.find((x) => !x.fails && x.fit >= 60) || null;

  return json(200, {
    plan,
    results: results.slice(0, 30),
    totalFound: items.length + r1.sponsored,
    removed: { sponsored: r1.sponsored, ...r2 },
    firstResult: first,
    savings: first && best && first.price > best.price ? Math.round((first.price - best.price) * 100) / 100 : null,
    marketplaceUrl: `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(plan.searchText)}`,
    warnings,
  });
};

export const config = { path: "/api/search" };
