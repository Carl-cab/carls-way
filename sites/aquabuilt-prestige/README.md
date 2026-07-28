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

## Connect `prestige.aquabuilt.ca` (Wix-managed domain)

`aquabuilt.ca` is registered at Wix, so DNS is edited in the Wix dashboard.

**Wix name servers cannot be changed.** That is a hard product limitation, not a
setting — the only way off Wix DNS is transferring the domain to another registrar.
It does not block this deployment: Wix lets you add your own `CNAME` records while
keeping its name servers, which is all a subdomain needs.

### Step 1 — Add the domain in Vercel

In the new project: **Settings → Domains → Add** → `prestige.aquabuilt.ca`.
Vercel then displays the exact `CNAME` target for *your* project. Leave this tab open.

### Step 2 — Add the CNAME in Wix

1. Wix dashboard → **Domains**.
2. Click the **Domain Actions** icon next to `aquabuilt.ca` → **Manage DNS Records**.
3. Find the **CNAME (Aliases)** section → **+ Add Record**. Wix shows a warning
   pop-up about DNS changes; click **Got it**.
4. Fill in the two fields:

   | Field | Value |
   |---|---|
   | Host Name | `prestige` |
   | Value | the target Vercel showed you in Step 1 |

5. **Save**, then **Save Changes** in the confirmation pop-up.

> **Use the value from the Vercel dashboard, not a value copied from a blog post.**
> Vercel moved to per-project dynamic targets (`<something>.vercel-dns-0NN.com`).
> The legacy `cname.vercel-dns.com` still resolves, but the dashboard value is the
> authoritative one for your project. `vercel domains inspect aquabuilt.ca` prints
> it from the CLI.

Enter `prestige` alone in Host Name — not the full `prestige.aquabuilt.ca`. Wix
appends the domain for you, and typing the full name yields
`prestige.aquabuilt.ca.aquabuilt.ca`.

### Step 3 — Verify

Wix states DNS changes can take up to 48 hours, though a new subdomain record
usually resolves within 10–30 minutes.

```bash
dig +short prestige.aquabuilt.ca CNAME
curl -sI https://prestige.aquabuilt.ca | head -n 1
```

Vercel issues and renews the TLS certificate automatically once the record resolves.
The domain card in Vercel flips to a green **Valid Configuration** when it is done.

### What this does and does not touch

Adding a `prestige` CNAME only creates a new subdomain. Your existing Wix site on
`aquabuilt.ca` and `www.aquabuilt.ca` keeps serving from Wix, untouched, and email
(`MX` records) is unaffected.

### If you later want the apex `aquabuilt.ca` on Vercel

This is the messy case, and worth avoiding unless you are retiring the Wix site.
An apex domain needs an `A` record, and Wix's default `A` records are what point
`aquabuilt.ca` at your Wix site — repointing them takes the Wix site offline at that
address. If that is the goal, use the `A` record value Vercel displays for your
project, add `www.aquabuilt.ca` as a second domain, and let Vercel redirect between
them. Wix's *Resetting Your Default A and CNAME Records* article covers the way back.

---

## Alternative hosts

The page is plain static HTML, so anything that serves a file works. Vercel is the
recommendation only because you already run it for Manna and the billing and
dashboards stay in one place.

- **Netlify** — equivalent to Vercel for this use case; set publish directory to
  `sites/aquabuilt-prestige`. Same Wix `CNAME` step, different target value.
- **Cloudflare Pages** — free and fast, and the `CNAME` approach works the same way.
  Note that full Cloudflare DNS (the orange-cloud proxy, page rules, analytics) is
  *not* available here, because that requires pointing name servers at Cloudflare —
  which a Wix-registered domain cannot do without a registrar transfer.
- **GitHub Pages** — free, but this is a private repo, so Pages would require making
  it public or upgrading the plan.
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
