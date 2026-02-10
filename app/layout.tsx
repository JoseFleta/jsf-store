import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

function resolveAppUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_BASE_URL || "").trim();
  if (!configured) return "http://localhost:3000";
  try {
    return new URL(configured).toString().replace(/\/$/, "");
  } catch {
    return "http://localhost:3000";
  }
}

const appUrl = resolveAppUrl();

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "JSF Store",
  description: "Inventory and marketplace management for JSF Store.",
  openGraph: {
    title: "JSF Store",
    description: "Inventory and marketplace management for JSF Store.",
    url: appUrl,
    siteName: "JSF Store",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}