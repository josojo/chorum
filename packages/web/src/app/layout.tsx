import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoWordmark } from "@/components/logo";
import { HowItWorks } from "@/components/how-it-works";
import { EarnExplainer } from "@/components/earn-explainer";
import { Footer } from "@/components/footer";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const SITE_DESCRIPTION =
  "Many voices, one signal. Ask anything; verified people's own AI agents add just their voice — anonymized and broken down by where and who. Filtered worldwide, by continent, or by country.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Chorum — many voices, one signal",
    template: "%s — Chorum",
  },
  description: SITE_DESCRIPTION,
  applicationName: "Chorum",
  openGraph: {
    type: "website",
    siteName: "Chorum",
    title: "Chorum — many voices, one signal",
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Chorum — many voices, one signal",
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans">
        <div className="mx-auto max-w-4xl px-3 py-5 sm:px-4 sm:py-10">
          <header className="mb-8 flex flex-wrap items-center justify-between gap-y-2 border-b border-slate-200/70 pb-4 sm:mb-10 sm:pb-5">
            <Link href="/" className="flex items-center" aria-label="Chorum home">
              <LogoWordmark />
            </Link>
            <nav className="flex items-center gap-1 text-sm sm:gap-3">
              <HowItWorks />
              <EarnExplainer />
              <Link
                href="/#questions"
                className="hidden rounded-full px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 sm:inline-flex"
              >
                Questions
              </Link>
              <Link
                href="/ask"
                className="inline-flex items-center gap-1 rounded-full bg-brand-gradient px-3 py-1.5 font-medium text-white shadow-glow transition hover:opacity-95 sm:gap-1.5 sm:px-4 sm:py-2"
              >
                <span aria-hidden>+</span> Ask
              </Link>
            </nav>
          </header>
          <main>{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
