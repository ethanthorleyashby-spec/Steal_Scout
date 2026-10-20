// Who is allowed to search: a tester with the ACCESS_CODE, or a logged-in member
// whose Stripe subscription is trialing or active.
import { currentSession, clearCookie } from "./session.mjs";
import { isMember } from "./stripe.mjs";

export async function authorize(req) {
  const code = process.env.ACCESS_CODE;
  const given = req.headers.get("x-access-code");
  if (code && given && given === code) return { ok: true, kind: "tester" };

  const session = currentSession(req);
  if (!session) return { ok: false, status: 401, error: "Log in to search.", reason: "login" };

  if (!(await isMember(session.cid))) {
    return { ok: false, status: 403, error: "Your membership isn't active. Rejoin to keep searching.", reason: "inactive", cookie: clearCookie() };
  }
  return { ok: true, kind: "member", email: session.email };
}
