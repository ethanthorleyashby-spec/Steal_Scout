// Signed tokens and cookies. No database needed: a token is a small JSON payload
// plus an HMAC signature made with SESSION_SECRET, so it can't be forged or edited.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "ss_session";
export const SESSION_DAYS = 30;
export const MAGIC_MINUTES = 20;

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  return s;
}

export function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = b64(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

/** Returns the payload if the signature is valid, the type matches, and it hasn't expired. */
export function verify(token, type) {
  if (typeof token !== "string" || token.length > 2000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (p.t !== type || typeof p.exp !== "number" || p.exp < Date.now()) return null;
  return p;
}

export function newSession(customerId, email) {
  return sign({ t: "session", cid: customerId, email, exp: Date.now() + SESSION_DAYS * 864e5 });
}

export function newMagicToken(customerId, email) {
  return sign({ t: "magic", cid: customerId, email, exp: Date.now() + MAGIC_MINUTES * 60e3 });
}

export function readCookie(req, name) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** The logged-in member's session payload, or null. Signature/expiry only; call Stripe to confirm membership. */
export function currentSession(req) {
  return verify(readCookie(req, SESSION_COOKIE), "session");
}

export function siteUrl(req) {
  const fromEnv = process.env.SITE_URL || process.env.URL;
  return (fromEnv || new URL(req.url).origin).replace(/\/+$/, "");
}

export function redirect(location, cookie) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function json(status, body, cookie) {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
