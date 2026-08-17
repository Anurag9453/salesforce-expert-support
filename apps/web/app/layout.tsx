import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

/**
 * One variable family, self-hosted at build time by next/font — no runtime
 * request to a font CDN, so there is no third-party dependency on the critical
 * render path and no layout shift once cached.
 *
 * It used to be two. Fraunces carried the headings with its calligraphic axes
 * turned on, which was distinctive but read as editorial rather than
 * operational. Headings now differ from body text by weight, size and tracking
 * instead of by family — see `.font-display` in globals.css. Dropping the second
 * family also removes a font from the critical path.
 *
 * `opsz` is named explicitly: without it next/font ships the weight axis alone
 * and the `font-optical-sizing` in globals.css silently does nothing.
 */
const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  axes: ["opsz"],
});

export const metadata: Metadata = {
  title: {
    default: "Salesforce Expert Support",
    template: "%s · Salesforce Expert Support",
  },
  description: "Describe your Salesforce problem and get matched with an experienced expert.",
  robots: { index: false, follow: false }, // Opened up in Phase 11 with the public pages.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
