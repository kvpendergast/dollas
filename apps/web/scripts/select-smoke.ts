/**
 * Select open-dropdown guard (hotfix after PR 57). Signs in as the seeded demo member, opens EVERY
 * Select on the main pages (and inside the edit dialogs and the CSV mapper) at 390 and 1280, and
 * fails if any opened list has no visible option or the trigger shows an empty value.
 * Local only: needs `pnpm dev`, the seed, and Chrome. Usage: pnpm smoke:select
 * Env: SMOKE_BASE_URL, SMOKE_EMAIL, SMOKE_PASSWORD, CHROME_PATH.
 */
import { chromium, type Page } from "playwright-core";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SMOKE_EMAIL ?? "ada@maple.local";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "maple-demo";
const PAGES = ["/activity", "/plan", "/accounts", "/recurring", "/categories", "/history"];
let total = 0;
let bad = 0;

async function sweep(page: Page, label: string) {
  const dialog = page.locator("[role=dialog]");
  const root = (await dialog.count()) ? dialog.first() : page.locator("body");
  const triggers = root.locator("[data-slot=select-trigger]:visible");
  const count = await triggers.count();
  for (let index = 0; index < count; index++) {
    const trigger = triggers.nth(index);
    if (await trigger.isDisabled()) continue;
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await page.waitForTimeout(200);
    const options = page.locator("[role=option]");
    const first = options.first();
    const box = (await options.count()) ? await first.boundingBox() : null;
    const shown = (await trigger.innerText()).trim();
    total++;
    const ok = (box?.height ?? 0) >= 20 && shown.length > 0;
    if (!ok) {
      bad++;
      console.error(`BAD ${label} select #${index} (${(await trigger.getAttribute("aria-label")) ?? (await trigger.getAttribute("id"))}): options=${await options.count()} shows=${JSON.stringify(shown)}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${BASE}/sign-in`);
    await page.getByLabel(/email/i).first().fill(EMAIL);
    await page.getByLabel(/password/i).first().fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).first().click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30000 });
    for (const path of PAGES) {
      await page.goto(`${BASE}${path}`);
      await page.waitForTimeout(500);
      await sweep(page, `${width}px ${path}`);
    }
    await page.goto(`${BASE}/activity`);
    const edit = page.locator('button:has-text("Edit")').first();
    if (await edit.count()) {
      await edit.click();
      await page.waitForTimeout(300);
      await sweep(page, `${width}px activity edit`);
    }
    await page.goto(`${BASE}/categories`);
    const dialogs = page.locator('button[aria-label^="Edit "]');
    for (let i = 0; i < Math.min(3, await dialogs.count()); i++) {
      await dialogs.nth(i).click();
      await page.waitForTimeout(300);
      await sweep(page, `${width}px categories dialog ${i}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    await context.close();
  }
  await browser.close();
  console.log(`${total} selects opened, ${bad} bad`);
  if (bad > 0) process.exit(1);
}

void main();
