/**
 * Sandbox smoke test — drives a RUNNING Manna instance in a real browser.
 *
 *   node scripts/e2e/sandbox-smoke.mjs <screenshot-output-dir>
 *
 * It assumes a server on http://localhost:3000 and a user
 * alice@example.test / SandboxPass!2026 already registered. It is a smoke
 * test, not a suite: it answers "can a person use this?", which `pnpm test`
 * cannot, because vitest never loads a page.
 *
 * WHY IT EXISTS. The suite was 68 files / 977 tests green while four of the
 * primary user workflows answered 500 — registration, /api/me, the feed, and
 * sending money — because the CI fixture was missing columns that only the
 * routes read. Every one was found by starting the application and using it.
 *
 * TWO RULES IT LEARNED THE HARD WAY, both from its own false reports:
 *
 *   - Do not match a bare `500` in page text. The transfers page legitimately
 *     renders "CAD 500.00", and an earlier revision called that page broken
 *     for exactly that reason. A detector that fires on real content costs a
 *     real investigation every run.
 *   - Select form fields by their visible label, not a guessed placeholder.
 *     An earlier revision used `input[placeholder*="ame" i]`, matched nothing
 *     (the placeholder is "Jane Smith"), left Full Name empty, and reported
 *     the app broken when the app had correctly refused an incomplete form.
 *
 * It is .mjs under the ops-script exception in CLAUDE.md: its inputs are argv
 * and a URL, and it has no type surface worth a build dependency.
 */
import { createRequire } from 'node:module';
// Playwright is preinstalled globally in this environment, not a project
// dependency — so it is required from the global tools path rather than
// imported. Deliberate: adding it to package.json would pull a browser
// toolchain into a payments repository that has an open supply-chain
// decision (0006), for a script that is run by hand.
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright');
const OUT = process.argv[2];
const results = [];
function log(step, status, detail = '') {
  results.push({ step, status, detail });
  console.log(`${status} | ${step} | ${detail}`);
}

const browser = await chromium.launch();

// ---------- DESKTOP ----------
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('pageerror: '+e.message));

await p.goto('http://localhost:3000/register', { waitUntil: 'networkidle' });
await p.screenshot({ path: `${OUT}/01-register-desktop.png` });
log('register page renders', (await p.title()) ? 'PASS' : 'FAIL', await p.title());

// Register a fresh user through the UI
const email = `uitest${Date.now()}@example.test`;
const fields = await p.locator('input').count();
log('register form has inputs', fields >= 3 ? 'PASS' : 'FAIL', `${fields} inputs`);

// Selected by the visible label rather than a guessed name/placeholder. An
// earlier version used input[placeholder*="ame" i], which matched nothing
// (the placeholder is "Jane Smith"), left Full Name empty, and reported the
// app broken when the app had correctly refused an incomplete form.
// SEMANTIC SELECTORS, which is the point rather than a style preference.
//
// These previously had to be positional — `form input` indexed by number —
// because no control on the auth forms carried a name, an id or a label
// associated by htmlFor, so getByLabel() timed out and matched nothing. The
// labels are now associated (id + htmlFor), so the test asks for a field the
// way a person or a screen reader would.
//
// That makes this check meaningful in a second way: if a future change breaks
// the association, this fails. A positional selector would have gone on
// passing while the form became unusable with assistive technology.
await p.getByLabel(/full name/i).fill('UI Test User');
await p.locator('form input[type="email"]').first().fill(email);
await p.locator('form input[type="password"]').first().fill('SandboxPass!2026');
await p.screenshot({ path: `${OUT}/02-register-filled.png` });

const submit = p.locator('button[type="submit"], button:has-text("Create"), button:has-text("Sign up"), button:has-text("Register")').first();
if (await submit.count()) {
  await submit.click();
  await p.waitForTimeout(3500);
  const url = p.url();
  log('register submit navigates', url.includes('/feed')||url.includes('/login')||!url.includes('/register') ? 'PASS':'FAIL', url);
  await p.screenshot({ path: `${OUT}/03-after-register.png`, fullPage: true });
} else { log('register submit button found','FAIL','no submit button'); }

// Login page.
//
// Cookies are cleared first because the registration step above signed this
// context in, and /login redirects an authenticated visitor to /feed — so the
// email field would not exist and the selector would time out. That is the
// app behaving correctly; the script was at fault when it first hit this.
await ctx.clearCookies();
await p.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
await p.screenshot({ path: `${OUT}/04-login-desktop.png` });
await p.getByLabel(/^email/i).fill('alice@example.test');
await p.getByLabel(/^password/i).fill('SandboxPass!2026');
const lbtn = p.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")').first();
if (await lbtn.count()) { await lbtn.click(); await p.waitForTimeout(3500); }
log('login navigates away from /login', !p.url().includes('/login') ? 'PASS':'FAIL', p.url());
await p.screenshot({ path: `${OUT}/05-after-login.png`, fullPage: true });

// Authenticated pages
for (const [name, path] of [['feed','/feed'],['send','/send'],['request','/request'],['history','/history'],['profile','/profile'],['friends','/friends'],['transfers','/transfers']]) {
  await p.goto('http://localhost:3000'+path, { waitUntil: 'networkidle' }).catch(()=>{});
  await p.waitForTimeout(600);
  const body = await p.locator('body').innerText().catch(()=> '');
  // Deliberately NOT matching a bare `500`: the transfers page legitimately
  // renders amounts like "CAD 500.00", and an earlier version of this check
  // reported that page broken for exactly that reason. A detector that fires
  // on real content is worse than no detector, because it costs a real
  // investigation every run.
  const broken = /Application error|Internal server error|Unhandled Runtime Error|client-side exception/i.test(body);
  const empty = body.trim().length < 20;
  log(`page ${name}`, (!broken && !empty) ? 'PASS':'FAIL', broken ? 'error text on page' : empty ? 'page essentially empty' : `${body.trim().length} chars`);
  await p.screenshot({ path: `${OUT}/page-${name}.png`, fullPage: true });
}
// The console-error check is split in two, because one half is an
// application property and the other is a property of THIS NETWORK.
//
// The pages load Plaid Link and Stripe.js from cdn.plaid.com and
// js.stripe.com. Both are blocked by the engineering environment's egress
// proxy (ERR_TUNNEL_CONNECTION_FAILED), which says nothing about the
// application. Counting them as a failure makes the suite permanently red
// for an environment limit; counting them as a pass would misrepresent a
// workflow — bank linking — as verified when it was never exercised.
// So they are reported as NOT APPLICABLE, named.
const blockedExternal = errs.filter((e) => /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(e));
const appErrors = errs.filter((e) => !blockedExternal.includes(e));
log(
  'console errors from the application itself',
  appErrors.length === 0 ? 'PASS' : 'FAIL',
  appErrors.slice(0, 3).join(' | ').slice(0, 300) || 'none',
);
log(
  'third-party SDKs reachable (Plaid Link, Stripe.js)',
  blockedExternal.length === 0 ? 'PASS' : 'N/A',
  blockedExternal.length
    ? `${blockedExternal.length} blocked by this environment's egress proxy — bank linking NOT verified here`
    : 'reachable',
);

// ---------- MOBILE ----------
const m = await browser.newContext({ ...devices['iPhone 13'] });
const mp = await m.newPage();
const merrs = [];
mp.on('pageerror', e => merrs.push(e.message));
await mp.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
await mp.screenshot({ path: `${OUT}/m01-login.png` });
const sw = await mp.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
log('mobile login: no horizontal overflow', sw.scrollW <= sw.clientW + 1 ? 'PASS':'FAIL', JSON.stringify(sw));
await mp.getByLabel(/^email/i).fill('alice@example.test').catch(() => {});
await mp.getByLabel(/^password/i).fill('SandboxPass!2026').catch(() => {});
const mb = mp.locator('button[type="submit"]').first();
if (await mb.count()) { await mb.click(); await mp.waitForTimeout(3500); }
await mp.screenshot({ path: `${OUT}/m02-feed.png`, fullPage: true });
for (const [name, path] of [['feed','/feed'],['send','/send'],['history','/history'],['profile','/profile']]) {
  await mp.goto('http://localhost:3000'+path, { waitUntil: 'networkidle' }).catch(()=>{});
  await mp.waitForTimeout(500);
  const o = await mp.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  log(`mobile ${name}: no horizontal overflow`, o.s <= o.c + 1 ? 'PASS':'FAIL', `scrollW=${o.s} clientW=${o.c}`);
  await mp.screenshot({ path: `${OUT}/m-${name}.png`, fullPage: true });
}
log('mobile page errors', merrs.length===0 ? 'PASS':'FAIL', merrs.slice(0,2).join(' | ').slice(0,200) || 'none');

await browser.close();
const fails = results.filter((r) => r.status === 'FAIL').length;
const na = results.filter((r) => r.status === 'N/A').length;
const passes = results.length - fails - na;
console.log(
  `\n=== ${passes} PASS / ${fails} FAIL / ${na} N/A (of ${results.length}) ===`,
);
console.log(
  na ? 'N/A = not verifiable in this environment; NOT counted as verified.' : '',
);
