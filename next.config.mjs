/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Type errors are caught by the dedicated `npm run typecheck` step in CI.
  // Linting is intentionally not run during `next build`; CI runs checks separately.
  eslint: { ignoreDuringBuilds: true },
  // `pg` is a server-only dependency; never bundle it for the browser.
  serverExternalPackages: ["pg"],

  // Mobile performance budget (beta-polish-a11y-002). The member portal is
  // opened on phones over mobile data, so we trim what ships to the browser:
  // - gzip/br compression on responses (smaller transfer on slow links),
  // - no client source maps in production (they bloat the deployed bundle),
  // - drop the X-Powered-By header (fewer bytes, less fingerprinting).
  // The portal stays a thin server-rendered surface (no client data-fetching,
  // no heavy client libs). The budget (Core Web Vitals targets) is documented in
  // docs/ARCHITECTURE.md → "Performance" and enforced at runtime by the
  // `<WebVitals />` reporter, which forwards budget breaches to monitoring.
  compress: true,
  productionBrowserSourceMaps: false,
  poweredByHeader: false,

  // `npm start` on a checkout with no production build serves with `next dev`
  // instead, so the port answers in seconds rather than after an ~85s build
  // (scripts/start.mjs explains why that matters). In that mode the dev server is
  // standing in for the real one, and the floating dev-tools indicator would
  // overlay every page of the product with a debug badge — so it is off for that
  // mode only. Plain `npm run dev` does not set this and keeps the indicator.
  ...(process.env.START_DEV_FALLBACK === "1" ? { devIndicators: false } : {}),
};

export default nextConfig;
