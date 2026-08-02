import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
