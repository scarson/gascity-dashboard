// Snap the Peek modal in both themes by clicking the first Peek button.
// Captures whether the modal renders correctly + whether the POST
// request succeeds (was hitting 403 before the changeOrigin fix).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:5174';
const OUT  = '/tmp/cp-snaps';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
      storageState: {
        cookies: [],
        origins: [{ origin: BASE, localStorage: [{ name: 'gascity:theme', value: theme }] }],
      },
    });
    const page = await ctx.newPage();
    const apiCalls = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/')) apiCalls.push({ url: r.url(), status: r.status() });
    });
    await page.goto(`${BASE}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    // Try to click a Peek button if any session row exists.
    const peekBtn = page.getByRole('button', { name: /^peek/i }).first();
    if (await peekBtn.count() > 0) {
      await peekBtn.click();
      await page.waitForTimeout(1500);
    } else {
      console.log(`[${theme}] no Peek button — no sessions to peek`);
    }
    const path = `${OUT}/${theme}-agents-peek.png`;
    await page.screenshot({ path });
    console.log(`snap ${path}`);
    console.log(`[${theme}] API calls:`, apiCalls.filter(c => c.status >= 400 || c.url.includes('peek')));
    await ctx.close();
  }
} finally {
  await browser.close();
}
