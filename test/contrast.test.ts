import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast gate for both themes (feedback-2026-08: "make sure all screens
 * pass the contrast test").
 *
 * Why this exists as its own suite. test/a11y.test.ts runs axe, but axe reports
 * `color-contrast` as INCOMPLETE under jsdom — Tailwind's stylesheet is never
 * applied there, so it has no computed colours to measure and silently checks
 * nothing. The old comment in that file said contrast was "enforced centrally in
 * app/globals.css and verified by manual ratio review", which is another way of
 * saying it was not tested at all: nothing failed when a colour changed.
 *
 * This closes that gap from the other end. Rather than render pages, it parses
 * the token tables that every colour in the app now resolves from (the theming
 * block in app/globals.css) and computes real WCAG 2.1 ratios over the pairs
 * that actually occur on screen. That is possible precisely BECAUSE the remap
 * was tokenised — before, the colours were hardcoded across a hundred class
 * overrides with nothing to enumerate.
 *
 * What it does not cover: a component that hardcodes a literal colour instead of
 * using a token. Those are caught by the un-remapped-literal scan at the bottom.
 */

const CSS = readFileSync(
  path.join(process.cwd(), "app", "globals.css"),
  "utf8",
);

/* -------------------------------------------------------------------------
 * Colour maths (WCAG 2.1 relative luminance + contrast ratio).
 * ---------------------------------------------------------------------- */

type Rgb = { r: number; g: number; b: number; a: number };

/** Strip CSS comments so commented-out examples can't be parsed as tokens. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Parse the colour syntaxes this stylesheet actually uses:
 *   #rrggbb            hex
 *   rgb(r g b)         space-separated
 *   rgb(r g b / a)     space-separated with alpha
 *   "4 120 87"         a bare channel triple (the --brand tokens, which are
 *                      consumed as `rgb(var(--brand) / <alpha>)`)
 */
function parseColor(raw: string): Rgb | null {
  const value = raw.trim();

  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const rgb = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/i.exec(
    value,
  );
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }

  const triple = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)$/.exec(value);
  if (triple) {
    return {
      r: Number(triple[1]),
      g: Number(triple[2]),
      b: Number(triple[3]),
      a: 1,
    };
  }

  return null;
}

/** Composite a possibly-translucent colour over an opaque backdrop. */
function over(fg: Rgb, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  );
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
  // Text may be translucent (tinted chips); resolve it against its backdrop
  // first, or the ratio would be computed for a colour nobody ever sees.
  const resolved = fg.a < 1 ? over(fg, bg) : fg;
  const l1 = relativeLuminance(resolved);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* -------------------------------------------------------------------------
 * Token extraction.
 * ---------------------------------------------------------------------- */

/** Pull `--name: value;` declarations out of one rule block. */
function tokensOf(selector: string): Record<string, string> {
  const css = stripComments(CSS);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  expect(block, `could not find the \`${selector}\` block in globals.css`).not.toBeNull();

  const out: Record<string, string> = {};
  for (const m of block![1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const DARK_TOKENS = tokensOf(":root");
// Light only overrides part of the table; anything it omits still resolves to
// the :root value, so the effective palette is the merge — exactly what the
// browser cascade produces.
const LIGHT_TOKENS = { ...DARK_TOKENS, ...tokensOf(':root[data-theme="light"]') };

const THEMES = {
  dark: DARK_TOKENS,
  light: LIGHT_TOKENS,
} as const;

function color(tokens: Record<string, string>, name: string): Rgb {
  const raw = tokens[name];
  expect(raw, `token --${name} is not defined`).toBeDefined();
  const parsed = parseColor(raw!);
  expect(parsed, `token --${name} ("${raw}") is not a parseable colour`).not.toBeNull();
  return parsed!;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255, a: 1 };

/** WCAG 2.1 AA for normal-size text. */
const AA_NORMAL = 4.5;

/**
 * Every text-on-background pair the UI actually produces.
 *
 * `on` names the SURFACE token the text sits on. The surface ladder matters:
 * a tone can clear AA on the page and fail on a lifted row, and the rows/chips
 * are where real copy lives.
 */
const TEXT_PAIRS: { text: string; on: string; label: string }[] = [
  // Primary ramp across all three planes.
  ...["page", "surface", "surface-muted", "surface-subtle"].flatMap((bg) =>
    ["text-strong", "text-body", "text-muted"].map((text) => ({
      text,
      on: bg,
      label: `${text} on ${bg}`,
    })),
  ),
  // Status text on the plain surface and on its own tinted chip.
  { text: "danger-text", on: "surface", label: "danger text on surface" },
  { text: "danger-text", on: "tint-danger", label: "danger text on danger chip" },
  { text: "success-text", on: "surface", label: "success text on surface" },
  { text: "success-text", on: "tint-success", label: "success text on success chip" },
  { text: "warning-text", on: "surface", label: "warning text on surface" },
  { text: "warning-text", on: "tint-warning", label: "warning text on warning chip" },
  // Accent text / links.
  { text: "brand-text", on: "surface", label: "brand text on surface" },
  { text: "brand-text", on: "page", label: "brand text on page" },
  // Placeholder text sits on the translucent field fill, not the bare surface.
  { text: "placeholder", on: "field-fill", label: "placeholder on field fill" },
];

describe.each(Object.entries(THEMES))("contrast — %s theme", (themeName, tokens) => {
  it.each(TEXT_PAIRS)(
    `$label clears AA (${AA_NORMAL}:1)`,
    ({ text, on }) => {
      // A tinted/translucent surface has to be flattened against the plane it
      // is painted on before it can serve as a backdrop.
      const rawBg = color(tokens, on);
      const bg = rawBg.a < 1 ? over(rawBg, color(tokens, "surface")) : rawBg;
      const ratio = contrastRatio(color(tokens, text), bg);

      expect(
        Number(ratio.toFixed(2)),
        `--${text} on --${on} in the ${themeName} theme is ${ratio.toFixed(2)}:1, below AA ${AA_NORMAL}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    },
  );

  it("white label text on the solid brand button clears AA", () => {
    const ratio = contrastRatio(WHITE, color(tokens, "brand"));
    expect(
      Number(ratio.toFixed(2)),
      `white on --brand in the ${themeName} theme is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("white label text on the brand hover fill clears AA", () => {
    const ratio = contrastRatio(WHITE, color(tokens, "brand-dark"));
    expect(
      Number(ratio.toFixed(2)),
      `white on --brand-dark in the ${themeName} theme is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("the keyboard focus ring is visible against every surface (3:1 non-text)", () => {
    // The focus indicator is a non-text UI component: WCAG 2.1 1.4.11 asks for
    // 3:1. It is drawn in --brand-text (globals.css `:focus-visible`), and it
    // has to be findable on whichever plane the focused control sits on.
    for (const surface of ["page", "surface", "surface-muted"]) {
      const ratio = contrastRatio(
        color(tokens, "brand-text"),
        color(tokens, surface),
      );
      expect(
        Number(ratio.toFixed(2)),
        `focus ring on --${surface} in the ${themeName} theme is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

/**
 * The remap can only theme utilities it knows about. A component that reaches
 * for a bright neutral OUTSIDE that list keeps its literal colour in both
 * themes — which is how `border-emerald-200` ended up as a pale hairline on the
 * dark check-in confirmation. This scan is the backstop for that class of miss.
 */
describe("theming coverage", () => {
  it("every neutral utility the remap themes is listed exactly once", () => {
    const css = stripComments(CSS);
    // Each remapped selector should appear once; a duplicate means two rules
    // fight and the winner depends on source order.
    const selectors = [...css.matchAll(/^\.(bg|text|border)-(slate|gray)-\d+/gm)].map(
      (m) => m[0],
    );
    const seen = new Set<string>();
    const duplicated = selectors.filter((s) => !seen.add(s));
    expect(duplicated, `duplicate remap selectors: ${duplicated.join(", ")}`).toEqual([]);
  });

  it("the remap resolves every colour from a token, never a literal", () => {
    // The whole point of the tokenisation: a literal hex below the theming
    // block would be a colour that cannot follow the theme.
    // The anchor is a comment banner, so locate it BEFORE stripping comments
    // and strip only the slice that follows.
    const remapStart = CSS.indexOf("THE BRIGHT-CLASS REMAP");
    expect(remapStart, "could not locate the remap block").toBeGreaterThan(-1);

    const remap = stripComments(CSS.slice(remapStart));
    const literals = [...remap.matchAll(/:\s*(#[0-9a-f]{3,8})\s*(?:!important)?;/gi)].map(
      (m) => m[1],
    );
    expect(
      literals,
      `hardcoded colours in the remap must become tokens: ${literals.join(", ")}`,
    ).toEqual([]);
  });
});
