import { join } from "node:path";
import type { Page } from "@playwright/test";

/**
 * Rendered-screenshot capture for the build-quality review.
 *
 * The a11y suite verifies structure (labels, landmarks, ARIA) but can't show
 * that the design system actually coheres visually. These helpers save
 * full-page PNGs of each surface at a desktop and a mobile viewport into
 * ./e2e-screenshots (gitignored); CI uploads the directory as an artifact on
 * every run so visual coherence can be judged from real renders, not inferred
 * from markup.
 */

export const SCREENSHOT_DIR = join(process.cwd(), "e2e-screenshots");

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
// iPhone 14/15-class portrait — the member portal's primary form factor.
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** Full-page screenshot of the page's current state under a stable name. */
export async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
  });
}

/**
 * Capture the current page at both viewports (…-desktop.png / …-mobile.png),
 * restoring the viewport it started with afterwards.
 */
export async function captureResponsive(page: Page, name: string): Promise<void> {
  const original = page.viewportSize();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await capture(page, `${name}-desktop`);
  await page.setViewportSize(MOBILE_VIEWPORT);
  await capture(page, `${name}-mobile`);
  if (original) await page.setViewportSize(original);
}
