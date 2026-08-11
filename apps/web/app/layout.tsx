import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

/**
 * Two variable families, self-hosted at build time by next/font — no runtime
 * request to a font CDN, so there is no third-party dependency on the critical
 * render path and no layout shift once cached.
 *
 * Fraunces carries the display voice. Its SOFT and WONK axes are what give the
 * headings a written, calligraphic quality; `axes` has to name them explicitly
 * or next/font ships the weight axis alone and the `font-variation-settings` in
 * globals.css silently does nothing.
 */
const display = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-fraunces",
  axes: ["SOFT", "WONK", "opsz"],
});

const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
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
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
