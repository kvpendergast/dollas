/**
 * Viewport smoke check (PEN-208). Signs in as the seeded demo member, opens
 * every page at each width, and checks:
 *   - no horizontal overflow (the page never scrolls sideways)       → fails
 *   - no visible text under 12px                                      → fails
 *   - tap targets under 44px tall at phone widths (inline links skip) → reported
 *
 * Local only: needs the dev server (`pnpm dev`), the seed (`pnpm db:seed`),
 * and Chrome. Usage:
 *   pnpm smoke:viewport                 # 360px
 *   pnpm smoke:viewport --all           # 360, 390, 768, 1024, 1440
 *   pnpm smoke:viewport --widths=390,768
 * Env: SMOKE_BASE_URL (http://localhost:3000), SMOKE_EMAIL, SMOKE_PASSWORD
 * (the seed's demo login), CHROME_PATH (/usr/bin/google-chrome).
 */
import { chromium, type Page } from "playwright-core";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SMOKE_EMAIL ?? "ada@maple.local";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "maple-demo";
const ALL = [360, 390, 768, 1024, 1440];
const arg = process.argv.find((value) => value.startsWith("--widths="));
const WIDTHS = process.argv.includes("--all") ? ALL : arg ? arg.slice(9).split(",").map(Number) : [360];
const PHONE_MAX = 767;

const PUBLIC_PAGES = ["/sign-in", "/sign-up", "/sign-up?path=join", "/forgot-password"];
const PAGES = [
  "/",
  "/activity",
  "/activity?range=last_90_days&q=market",
  "/accounts",
  "/categories",
  "/plan",
  "/recurring",
  "/history",
  "/history?range=last_90_days",
  "/estimate",
  "/household",
  "/settings",
];

type Finding = { width: number; path: string; kind: "overflow" | "small-text" | "tap-target"; detail: string };

async function audit(page: Page, width: number, path: string): Promise<Finding[]> {
  const result = await page.evaluate((phone) => {
    const describe = (el: Element) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${el.tagName.toLowerCase()}${id}${cls === "." ? "" : cls} "${text}"`;
    };
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !el.closest("[aria-hidden=true] .sr-only, .sr-only");
    };
    const insideScroller = (el: Element) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "auto" || overflow === "scroll" || overflow === "hidden" || overflow === "clip") return true;
      }
      return false;
    };
    const vw = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth > vw + 1;
    const wide = overflow
      ? [...document.body.querySelectorAll("*")]
          .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1 && !insideScroller(el))
          .slice(-5)
          .map(describe)
      : [];
    const small: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !(node.textContent ?? "").trim() || !visible(parent)) continue;
      if (parent.closest(".sr-only, [aria-hidden=true] .invisible, .invisible, .text-transparent, script, style, noscript")) continue;
      const size = parseFloat(getComputedStyle(parent).fontSize);
      if (size < 12) small.push(`${size}px ${describe(parent)}`);
    }
    const taps: string[] = [];
    if (phone) {
      for (const el of document.querySelectorAll("a, button, summary, select, input:not([type=hidden]), [role=button]")) {
        if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height >= 44) continue;
        // Inline links inside a sentence are exempt (WCAG 2.5.8).
        if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
        // Checkboxes and radios are tapped through their label.
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && el.closest("label")) continue;
        taps.push(`${Math.round(rect.height)}px ${describe(el)}`);
      }
    }
    return { overflow, wide, small: [...new Set(small)].slice(0, 8), taps: [...new Set(taps)].slice(0, 12) };
  }, width <= PHONE_MAX);
  const findings: Finding[] = [];
  if (result.overflow) findings.push({ width, path, kind: "overflow", detail: result.wide.join(" | ") || "document wider than viewport" });
  for (const detail of result.small) findings.push({ width, path, kind: "small-text", detail });
  for (const detail of result.taps) findings.push({ width, path, kind: "tap-target", detail });
  return findings;
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const findings: Finding[] = [];
  try {
    for (const width of WIDTHS) {
      const phone = width <= PHONE_MAX;
      const context = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, isMobile: phone, hasTouch: phone, reducedMotion: "reduce" });
      // tsx (esbuild keepNames) wraps functions in __name(); define it in the page for page.evaluate.
      await context.addInitScript("window.__name = (fn) => fn;");
      const page = await context.newPage();
      for (const path of PUBLIC_PAGES) {
        await page.goto(BASE + path, { waitUntil: "networkidle" });
        findings.push(...(await audit(page, width, path)));
      }
      await page.goto(BASE + "/sign-in");
      await page.getByLabel(/email/i).first().fill(EMAIL);
      await page.getByLabel(/password/i).first().fill(PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).first().click();
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
      const pages = [...PAGES];
      await page.goto(BASE + "/recurring", { waitUntil: "networkidle" });
      const detail = await page.locator('a[href^="/recurring/"]').first().getAttribute("href").catch(() => null);
      if (detail) pages.push(detail);
      for (const path of pages) {
        await page.goto(BASE + path, { waitUntil: "networkidle" });
        findings.push(...(await audit(page, width, path)));
      }
      await context.close();
      const here = findings.filter((item) => item.width === width);
      console.log(`${width}px: ${pages.length + PUBLIC_PAGES.length} pages, overflow ${here.filter((f) => f.kind === "overflow").length}, small text ${here.filter((f) => f.kind === "small-text").length}, small tap targets ${here.filter((f) => f.kind === "tap-target").length}`);
    }
  } finally {
    await browser.close();
  }
  for (const item of findings) console.log(`  [${item.kind}] ${item.width}px ${item.path}: ${item.detail}`);
  const failures = findings.filter((item) => item.kind !== "tap-target");
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} overflow or small-text findings.`);
    process.exit(1);
  }
  console.log("OK: no horizontal overflow and no text under 12px.");
}

void main();
