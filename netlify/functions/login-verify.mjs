// GET /api/login/verify?token=...  (the link in the login email)
import { verify, newSession, sessionCookie, redirect, siteUrl } from "../lib/session.mjs";
import { isMember } from "../lib/stripe.mjs";

export default async (req) => {
  const base = siteUrl(req);
  const p = verify(new URL(req.url).searchParams.get("token"), "magic");
  if (!p) return redirect(`${base}/login.html?e=expired`);
  try {
    if (!(await isMember(p.cid))) return redirect(`${base}/login.html?e=inactive`);
    return redirect(`${base}/search.html`, sessionCookie(newSession(p.cid, p.email)));
  } catch (err) {
    console.error("verify failed:", err.message);
    return redirect(`${base}/login.html?e=server`);
  }
};

export const config = { path: "/api/login/verify" };
