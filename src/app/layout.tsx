import type { Metadata } from "next";
import "./globals.css";
import ThemeToggle from "./ThemeToggle";
import TestUserBanner from "./TestUserBanner";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: "drizzle — your career co-pilot",
  description: "Understood once, working for you everywhere: résumé, mentor, opportunities.",
  openGraph: {
    title: "drizzle — your career co-pilot",
    description: "The first rain after the drought — action over inaction.",
    images: ["/brand/drizzle-og.png"],
  },
};

// Runs before paint: applies the saved theme so there's no flash on load. Dark
// is the default — the warm-dark look is drizzle's premium face; light is opt-in.
const themeInit = `(function(){try{var t=localStorage.getItem("drizzle-theme")||"dark";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* the design kit's type: Newsreader (serif display), Hanken Grotesk
            (body), Quicksand (wordmark) — the editorial premium feel */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&family=Quicksand:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <TestUserBanner />
        {children}
        <ThemeToggle />
      </body>
    </html>
  );
}
