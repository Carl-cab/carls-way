import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const URL = 'https://www.facebook.com/reel/1683575379551601';
const OUT_DIR = path.resolve('assets/reference');

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 720, height: 1280 },
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  locale: 'en-US',
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

const meta = { url: URL, capturedAt: new Date().toISOString(), notes: [] };

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4000);

  // Try to dismiss login dialogs
  for (const sel of [
    '[aria-label="Close"]',
    'div[role="button"][aria-label="Close"]',
    'div[aria-label="Decline optional cookies"]',
  ]) {
    const el = await page.$(sel);
    if (el) {
      try { await el.click({ timeout: 1500 }); } catch {}
    }
  }
  await page.waitForTimeout(1500);

  meta.title = await page.title();
  meta.ogDescription = await page
    .$eval('meta[property="og:description"]', (el) => el.getAttribute('content'))
    .catch(() => null);
  meta.ogTitle = await page
    .$eval('meta[property="og:title"]', (el) => el.getAttribute('content'))
    .catch(() => null);
  meta.ogImage = await page
    .$eval('meta[property="og:image"]', (el) => el.getAttribute('content'))
    .catch(() => null);
  meta.ogVideo = await page
    .$eval('meta[property="og:video:url"], meta[property="og:video"]', (el) => el.getAttribute('content'))
    .catch(() => null);

  await page.screenshot({ path: path.join(OUT_DIR, 'reel-page.png'), fullPage: false });

  // Try to find a video element and grab its poster + currentSrc
  const videos = await page.$$eval('video', (vs) =>
    vs.map((v) => ({
      currentSrc: v.currentSrc || v.src || null,
      poster: v.poster || null,
      width: v.videoWidth,
      height: v.videoHeight,
    }))
  );
  meta.videos = videos;

  // Save og:image (Facebook usually exposes a thumbnail this way) if present
  if (meta.ogImage) {
    try {
      const res = await page.context().request.get(meta.ogImage);
      if (res.ok()) {
        const buf = await res.body();
        await fs.writeFile(path.join(OUT_DIR, 'og-thumbnail.jpg'), buf);
        meta.notes.push('saved og-thumbnail.jpg');
      }
    } catch (e) {
      meta.notes.push(`og image fetch failed: ${e.message}`);
    }
  }

  // Save poster image if reachable
  for (const [i, v] of videos.entries()) {
    if (v.poster) {
      try {
        const res = await page.context().request.get(v.poster);
        if (res.ok()) {
          const buf = await res.body();
          await fs.writeFile(path.join(OUT_DIR, `video-poster-${i}.jpg`), buf);
          meta.notes.push(`saved video-poster-${i}.jpg`);
        }
      } catch (e) {
        meta.notes.push(`poster ${i} fetch failed: ${e.message}`);
      }
    }
  }
} catch (e) {
  meta.error = e.message;
} finally {
  await fs.writeFile(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  await browser.close();
}

console.log(JSON.stringify(meta, null, 2));
