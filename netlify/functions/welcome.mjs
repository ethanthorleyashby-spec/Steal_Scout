// Stripe sends new members here after checkout:
//   https://YOURSITE/api/welcome?session_id={CHECKOUT_SESSION_ID}
// We confirm the checkout with Stripe, then log them in with a session cookie.
import { memberFromCheckout } from "../lib/stripe.mjs";
import { newSession, sessionCookie, redirect, siteUrl } from "../lib/session.mjs";

export default async (req) => {
  const base = siteUrl(req);
  const id = new URL(req.url).searchParams.get("session_id");
  try {
    const m = await memberFromCheckout(id);
    if (!m) return redirect(`${base}/login.html?e=checkout`);
    return redirect(`${base}/search.html?welcome=1`, sessionCookie(newSession(m.customerId, m.email)));
  } catch (err) {
    console.error("welcome failed:", err.message);
    return redirect(`${base}/login.html?e=server`);
  }
};

export const config = { path: "/api/welcome" };
