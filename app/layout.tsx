import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "Compass — which skill unlocks the most doors?",
    template: "%s · Compass",
  },
  description:
    "Tell Compass what you can do and it names the single skill that moves you closest to the most jobs, plus the cheapest route to the career you want. Built on the European Commission's ESCO occupation and skill graph.",
};

function Mark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-6 text-accent" fill="none">
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" />
      {/* The needle points up and to the right — the whole product in one glyph. */}
      <path d="M8 16 L15.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15.5 8.5 L11.4 9.1 L14.9 12.6 Z" fill="currentColor" />
    </svg>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <header className="border-b border-line">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-4">
            <Link
              href="/"
              className="flex items-center gap-2 rounded-md text-[15px] font-semibold tracking-tight text-ink"
            >
              <Mark />
              Compass
            </Link>
            <p className="hidden text-[13px] text-ink-muted sm:block">
              Career &amp; reskilling navigator
            </p>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="mt-20 border-t border-line">
          <div className="mx-auto w-full max-w-5xl px-5 py-8 text-[13px] leading-relaxed text-ink-muted">
            <p>
              Occupations and skills come from{" "}
              <a
                href="https://esco.ec.europa.eu"
                className="text-ink-soft underline underline-offset-2 hover:text-accent"
                target="_blank"
                rel="noreferrer"
              >
                ESCO v1.2
              </a>{" "}
              © European Union, reused under the{" "}
              <a
                href="https://esco.ec.europa.eu/en/use-esco/download"
                className="text-ink-soft underline underline-offset-2 hover:text-accent"
                target="_blank"
                rel="noreferrer"
              >
                ESCO terms of use
              </a>
              . The European Commission does not endorse this application.
            </p>
            <p className="mt-2">
              Similarity between occupations is derived here, not published by ESCO.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
