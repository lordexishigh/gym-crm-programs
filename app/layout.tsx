import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alpha CRM",
  description:
    "Multi-tenant CRM for Cyprus gyms — trainers build training programs and assign them to members.",
};

// Mobile-first viewport: the member portal is opened on a phone browser first.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f766e",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
