// GET  /api/me      -> { member: true, email } when a valid session cookie is present
// POST /api/logout  -> clears the session cookie
import { currentSession, clearCookie, json } from "../lib/session.mjs";

export default async (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/logout") {
    if (req.method !== "POST") return json(405, { error: "Use POST." });
    return json(200, { ok: true }, clearCookie());
  }
  const s = currentSession(req);
  return json(200, s ? { member: true, email: s.email } : { member: false });
};

export const config = { path: ["/api/me", "/api/logout"] };
