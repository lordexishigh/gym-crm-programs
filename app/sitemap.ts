import type { MetadataRoute } from "next";

import { siteBaseUrl } from "@/lib/site";

/**
 * Served as /sitemap.xml (Next.js metadata route).
 *
 * Lists only the public entry points; the dashboard, member portal, and invite
 * flows are authenticated per-tenant surfaces and are excluded (robots.ts
 * disallows them as well).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteBaseUrl();
  return [
    {
      url: `${base}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/login`,
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];
}
