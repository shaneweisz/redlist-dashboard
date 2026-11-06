import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";
import { ThemeProvider } from "../components/ThemeProvider";
import { BrandProvider } from "../components/BrandProvider";
import { MeProvider } from "../components/MeProvider";
import { PostHogProvider } from "../components/PostHogProvider";
import { BRAND } from "../config/brand";
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

export const metadata: Metadata = {
  title: BRAND.tabTitle ?? BRAND.title,
  description: BRAND.description,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <BrandProvider brand={BRAND}>
          <MeProvider>
            <PostHogProvider>
              <ThemeProvider>{children}</ThemeProvider>
            </PostHogProvider>
          </MeProvider>
        </BrandProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
