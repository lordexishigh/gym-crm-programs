/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Type errors are caught by the dedicated `npm run typecheck` step in CI.
  // Linting is intentionally not run during `next build`; CI runs checks separately.
  eslint: { ignoreDuringBuilds: true },
  // `pg` is a server-only dependency; never bundle it for the browser.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
