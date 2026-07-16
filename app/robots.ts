import type { MetadataRoute } from "next";

import { siteBaseUrl } from "@/lib/site";

/**
 * Served as /robots.txt (Next.js metadata route).
 *
 * Only the public marketing/entry pages should be crawled. Everything behind
 * authentication — the staff dashboard, the member portal, invite acceptance,
 * and the API — is per-tenant private data and is disallowed outright.
 */
export default function robots(): MetadataRoute.Robots {
  const base = siteBaseUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard/", "/portal/", "/invite/", "/api/"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
