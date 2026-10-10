import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The motion system (PEN-208) lives in globals.css. These checks keep it
 * honest: reduced motion turns everything off, animations touch only
 * transform and opacity (no layout jank), and timings come from the tokens.
 */
const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

function block(source: string, start: number): string {
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unbalanced css");
}

describe("motion respects reduced motion", () => {
  it("cancels every animation and transition under prefers-reduced-motion", () => {
    const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(-1);
    const reduce = block(css, at);
    expect(reduce).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(reduce).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(reduce).toMatch(/animation-delay:\s*0ms\s*!important/);
    expect(reduce).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(reduce).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it("animates only transform and opacity", () => {
    const frames = [...css.matchAll(/@keyframes\s+([\w-]+)/g)];
    expect(frames.length).toBeGreaterThanOrEqual(6);
    for (const frame of frames) {
      const body = block(css, frame.index ?? 0);
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
      for (const prop of props) expect(["opacity", "transform"], `${frame[1]} animates ${prop}`).toContain(prop);
    }
  });

  it("times every motion class from the tokens", () => {
    for (const token of ["--motion-fast", "--motion-base", "--motion-slow", "--motion-chart", "--ease-out", "--ease-in"]) {
      expect(css).toContain(`${token}:`);
    }
    const animations = [...css.matchAll(/animation:\s*([^;]+);/g)].map((match) => match[1]);
    expect(animations.length).toBeGreaterThan(5);
    for (const value of animations) expect(value, value).toMatch(/var\(--motion-[a-z]+\)\s+var\(--ease-(out|in)\)/);
    expect(css).toMatch(/transition-duration:\s*var\(--motion-base\)/);
  });
});
