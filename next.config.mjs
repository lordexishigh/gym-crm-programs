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
};

export default nextConfig;
