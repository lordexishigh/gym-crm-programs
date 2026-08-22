import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WebVitals } from "./WebVitals";
import { THEME_INIT_SCRIPT } from "./components/ThemeToggle";
import { siteBaseUrl } from "@/lib/site";

export const metadata: Metadata = {
  // Resolves relative OG/canonical URLs (and keeps robots.ts/sitemap.ts on the
  // same origin — all three read APP_BASE_URL via lib/site.ts).
  metadataBase: new URL(siteBaseUrl()),
  title: "Alpha CRM",
  description:
    "Multi-tenant CRM for Cyprus gyms — trainers build training programs and assign them to members.",
};

// Mobile-first viewport: the member portal is opened on a phone browser first.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the AA-compliant solid brand (Emerald-700, app/globals.css --brand).
  themeColor: "#047857",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/*
          Applies the saved theme before first paint. Must be inline and must run
          ahead of the body, or a light-mode user gets a dark flash on every
          load. See app/components/ThemeToggle.tsx for why it ignores the OS
          preference.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen">
        {children}
        {/* Measures Core Web Vitals against the mobile performance budget. */}
        <WebVitals />
      </body>
    </html>
  );
}
