# Steal Scout — member login setup

Do these in order. Total time: about 20 minutes.

## 1. Upload the new files to GitHub
In your repo, use **Add file → Upload files** and drag in the whole `steal-scout-site` folder.
Files with the same names get replaced. Commit. Netlify redeploys automatically.

## 2. Create a restricted Stripe key (Steal Scout account, not Weber Appliance Rentals)
Stripe Dashboard → Developers → API keys → **Create restricted key**
- Name: `Steal Scout website`
- Permissions, set to **Read**: Checkout Sessions, Customers, Subscriptions
- Everything else: **None**

Copy the key (starts with `rk_live_`). A restricted key can only read; it can't charge or refund anyone.

## 3. Add environment variables in Netlify
Site configuration → Environment variables:

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the `rk_live_...` key from step 2 |
| `SESSION_SECRET` | a random string, 40+ characters (use a password generator; never reuse it) |
| `SITE_URL` | `https://stealscout.netlify.app` (change it when you get your domain) |
| `SERPAPI_KEY` | already set |
| `ACCESS_CODE` | already set; still works for testers via `search.html?tester` |

Then **Deploys → Trigger deploy → Deploy site**.

Never put any of these values in the website files or in GitHub.

## 4. Send new members back to the site after checkout
Stripe → Payment Links → your Founding Member link → Edit → **After payment**:
- Choose **Don't show confirmation page** (redirect to your website)
- URL: `https://stealscout.netlify.app/api/welcome?session_id={CHECKOUT_SESSION_ID}`

Type `{CHECKOUT_SESSION_ID}` exactly like that, braces included. Stripe fills it in.

## 5. Email login links (for members on a new device)
1. Sign up at resend.com and create an API key.
2. Add `RESEND_API_KEY` in Netlify.
3. Until you verify your own domain in Resend, emails can only go to the address you signed up with. That's fine for testing.
4. After you buy your domain: verify it in Resend, then add `EMAIL_FROM` = `Steal Scout <login@yourdomain.com>`.

Until Resend is set up, the login page says email login isn't available yet. Checkout logins (step 4) still work.

## 6. Test it
1. Open `stealscout.netlify.app/search.html` in a private window. It should ask you to log in.
2. Visit `/login.html`, enter the email you used to join, and click the link in the email.
3. You should land on the search page with your email in the top right.

## How it works
- After checkout or an email link, the site sets a signed, 30-day login cookie.
- Every search checks Stripe that the membership is still **trialing** or **active**. Canceled members are logged out automatically.
- Email login links expire after 20 minutes.
