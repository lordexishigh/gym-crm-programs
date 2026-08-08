import { test, expect } from "@playwright/test";
import { captureResponsive } from "./capture";

/**
 * Rendered screenshots of the UNAUTHENTICATED entry surfaces — the landing
 * page and both sign-in pages. These pages hit no database, so unlike the
 * invite journey this spec runs whenever the built app boots (no local-DB
 * gate). Each capture is preceded by a real assertion so a blank or errored
 * render can't masquerade as a passing screenshot.
 *
 * Authenticated surfaces (invite-accept, member portal) are captured inside
 * e2e/invite-flow.spec.ts where a real session exists.
 */

test.describe("rendered screenshots — public surfaces", () => {
  test("landing page renders and is captured", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Training programs your members can actually open.",
      }),
    ).toBeVisible();
    await captureResponsive(page, "01-landing");
  });

  test("staff sign-in page renders and is captured", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await captureResponsive(page, "02-staff-login");
  });

  test("member portal sign-in page renders and is captured", async ({ page }) => {
    await page.goto("/portal/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await captureResponsive(page, "03-portal-login");
  });
});
