import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Canens",
  description: "Break a goal into the next few actions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} bg-background text-foreground min-h-screen flex flex-col font-body antialiased`}
      >
        <nav className="border-b border-white/10 bg-surface/50 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <Link
              href="/"
              className="text-xl font-bold text-foreground tracking-tight hover:opacity-80 transition-opacity"
            >
              Canens<span className="text-primary">.</span>
            </Link>
            <div className="flex space-x-6">
              <Link href="/" className="text-sm font-medium text-muted hover:text-foreground transition-colors">
                Home
              </Link>
              <Link
                href="/activity"
                className="text-sm font-medium text-muted hover:text-foreground transition-colors"
              >
                Activity Log
              </Link>
            </div>
          </div>
        </nav>
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
