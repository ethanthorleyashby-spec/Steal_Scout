// Minimal read-only Stripe calls over plain fetch (no npm packages to install).
// Use a RESTRICTED key with read access to Checkout Sessions, Customers and Subscriptions.

const API = "https://api.stripe.com/v1";
export const MEMBER_STATUSES = new Set(["trialing", "active"]);

async function get(path, params = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}${qs ? `?${qs}` : ""}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** After checkout: confirm the session finished and created a trialing/active subscription. */
export async function memberFromCheckout(sessionId) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId || "")) return null;
  const s = await get(`/checkout/sessions/${sessionId}`, { "expand[]": "subscription" });
  if (s.status !== "complete" || s.mode !== "subscription") return null;
  const status = typeof s.subscription === "object" ? s.subscription?.status : null;
  if (!MEMBER_STATUSES.has(status)) return null;
  const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id;
  const email = s.customer_details?.email || null;
  return customerId ? { customerId, email } : null;
}

/** Does this customer have a trialing or active subscription right now? */
export async function isMember(customerId) {
  if (!/^cus_[A-Za-z0-9]+$/.test(customerId || "")) return false;
  const subs = await get("/subscriptions", { customer: customerId, status: "all", limit: "10" });
  return (subs.data || []).some((s) => MEMBER_STATUSES.has(s.status));
}

/** Find a current member by email. Stripe's email filter is case-sensitive, so try both spellings. */
export async function memberByEmail(email) {
  const tries = [...new Set([email.trim(), email.trim().toLowerCase()])];
  for (const e of tries) {
    const customers = await get("/customers", { email: e, limit: "10" });
    for (const c of customers.data || []) {
      if (await isMember(c.id)) return { customerId: c.id, email: c.email || e };
    }
  }
  return null;
}
