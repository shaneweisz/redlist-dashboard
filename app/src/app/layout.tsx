import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";
import { ThemeProvider } from "../components/ThemeProvider";
import { BrandProvider } from "../components/BrandProvider";
import { MeProvider } from "../components/MeProvider";
import { PostHogProvider } from "../components/PostHogProvider";
import { AnalyticsConsentPrompt } from "../components/AnalyticsConsentPrompt";
import { brandForHost } from "../config/brand";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export async function generateMetadata(): Promise<Metadata> {
  const brand = brandForHost((await headers()).get("host"));
  return {
    title: brand.tabTitle ?? brand.title,
    description: brand.description,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const brand = brandForHost((await headers()).get("host"));
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <BrandProvider brand={brand}>
          {/* MeProvider wraps PostHogProvider because the latter reads the
              signed-in user's analytics consent from it to decide whether to
              record (#524). */}
          <MeProvider>
            <PostHogProvider>
              <ThemeProvider>
                {children}
                <AnalyticsConsentPrompt />
              </ThemeProvider>
            </PostHogProvider>
          </MeProvider>
        </BrandProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
