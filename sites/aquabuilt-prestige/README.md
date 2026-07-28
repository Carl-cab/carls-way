# AquaBuilt Prestige — Landing Page

Static, single-file landing page for AquaBuilt's custom concrete pool business.
No build step, no framework, no dependencies. `index.html` is fully self-contained
(styles, scripts, and both logo images are inlined as base64).

This folder is **independent of the Manna app** at the repo root. It has its own
`vercel.json` and deploys as its own Vercel project.

| File | Purpose |
|---|---|
| `index.html` | The entire landing page |
| `vercel.json` | Static-host config: security headers, cache policy, clean URLs |
| `robots.txt` | Allows all crawlers, points to the sitemap |
| `sitemap.xml` | Single-URL sitemap for `prestige.aquabuilt.ca` |

---

## Deploy to Vercel

Create a **new** Vercel project — do not reuse the Manna project, which builds the
Next.js app at the repo root.

1. Vercel Dashboard → **Add New… → Project** → import `Carl-cab/carls-way`.
2. On the configuration screen, set:
   - **Root Directory:** `sites/aquabuilt-prestige`
   - **Framework Preset:** `Other`
   - **Build Command:** leave empty
   - **Output Directory:** leave empty
3. **Deploy.** You get a `*.vercel.app` URL in under a minute.

Because Root Directory is scoped to this folder, Vercel only redeploys this project
when files under `sites/aquabuilt-prestige/` change. Pushes to the Manna app do not
trigger it, and this project never runs `npm install` or `next build`.

### Which branch deploys to production

In **Project Settings → Git → Production Branch**, pick the branch you want live.
Every other branch produces a preview URL.

---

## Connect `prestige.aquabuilt.ca`

1. In the new project: **Settings → Domains → Add**.
2. Enter `prestige.aquabuilt.ca` and confirm.
3. Vercel shows the exact DNS record to create. For a subdomain it is a `CNAME`:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `prestige` | `cname.vercel-dns.com` |

4. Add that record at whatever DNS host holds `aquabuilt.ca` (registrar, Cloudflare,
   Route 53 — wherever the nameservers point).
5. Wait for propagation, then verify:

   ```bash
   dig +short prestige.aquabuilt.ca CNAME
   curl -sI https://prestige.aquabuilt.ca | head -n 1
   ```

Vercel issues and renews the TLS certificate automatically once the record resolves.

> **Copy the record values from the Vercel dashboard rather than from this file.**
> Vercel has changed its published target values before, and the dashboard is
> always authoritative for your project.

### If DNS sits behind Cloudflare

Set the `prestige` record to **DNS only** (grey cloud), not proxied. An orange-cloud
proxied record blocks Vercel's domain verification and its certificate issuance.

### Serving the apex `aquabuilt.ca` instead

Add `aquabuilt.ca` as the domain and use the `A` record Vercel displays (an apex
domain cannot be a CNAME). Add `www.aquabuilt.ca` too and let Vercel redirect one
to the other — it offers this when you add the second domain.

---

## Alternative hosts

The page is plain static HTML, so anything that serves a file works. Vercel is the
recommendation only because you already run it for Manna and the billing, DNS, and
dashboard stay in one place.

- **Cloudflare Pages** — free custom domains and unlimited bandwidth. Strongest option
  if `aquabuilt.ca` DNS already lives at Cloudflare, since the domain attaches with
  no manual record at all.
- **Netlify** — equivalent to Vercel for this use case; set publish directory to
  `sites/aquabuilt-prestige`.
- **GitHub Pages** — free, but this is a private repo, so Pages would require making
  it public or upgrading the plan.

---

## Before going live

Two things in `index.html` still point at placeholders:

1. **`og:image` / `twitter:image`** reference `https://prestige.aquabuilt.ca/og-image.jpg`,
   which does not exist yet. Until you add that file to this folder, links shared to
   Facebook, LinkedIn, iMessage, and X render without a preview image. Recommended
   size is 1200×630.
2. **Formspree endpoint** `xdarydvo` is hardcoded at `index.html:556`. Confirm that
   form is active and its notification email is correct, then submit one live test of
   each tab — Request a Proposal and Schedule a Consultation — after the domain is up.

Also worth doing once live: submit `https://prestige.aquabuilt.ca/sitemap.xml` in
Google Search Console, and validate the `HomeAndConstructionBusiness` JSON-LD block
with the Rich Results Test.
