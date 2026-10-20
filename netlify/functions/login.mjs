// POST /api/login  { "email": "you@example.com" }
// If the email belongs to a trialing or active member, email them a one-click login link.
// The response is the same either way, so nobody can use this to check who's a member.
import { memberByEmail } from "../lib/stripe.mjs";
import { newMagicToken, json, siteUrl, MAGIC_MINUTES } from "../lib/session.mjs";

const SENT = { ok: true, message: "If that email has an active membership, a login link is on its way. Check your inbox (and spam folder)." };

async function sendEmail(to, link) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Steal Scout <onboarding@resend.dev>",
      to,
      subject: "Your Steal Scout login link",
      text: `Log in to Steal Scout: ${link}\n\nThis link works for ${MAGIC_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#13233f;max-width:480px">
        <p style="font-size:22px;font-weight:bold;margin:0 0 16px">Log in to Steal Scout</p>
        <p><a href="${link}" style="display:inline-block;background:#13233f;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Log in</a></p>
        <p style="color:#3b4a66;font-size:14px">This link works for ${MAGIC_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p>
      </div>`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}: ${await res.text().catch(() => "")}`);
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  if (!process.env.RESEND_API_KEY) return json(503, { error: "Email login isn't set up yet. Use the link from your checkout, or contact support." });

  let email = "";
  try { email = String((await req.json()).email || "").trim(); } catch {}
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(400, { error: "Enter a valid email address." });

  try {
    const m = await memberByEmail(email);
    if (m) {
      const link = `${siteUrl(req)}/api/login/verify?token=${encodeURIComponent(newMagicToken(m.customerId, m.email))}`;
      await sendEmail(m.email, link);
    }
    return json(200, SENT);
  } catch (err) {
    console.error("login failed:", err.message);
    return json(502, { error: "Couldn't send a login link right now. Try again in a minute." });
  }
};

export const config = { path: "/api/login" };
