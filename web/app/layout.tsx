import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from 'next/link';

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Canens — Energy-Aware Productivity",
  description: "Keep track of what matters with energy-aware productivity.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-midnight-slate text-lunar-silver min-h-screen flex flex-col`}>
        <nav className="border-b border-white/10 bg-surface/50 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <Link href="/" className="text-xl font-bold font-headline text-foreground tracking-tight hover:opacity-80 transition-opacity">
              Canens<span className="text-primary">.</span>
            </Link>
            <div className="flex space-x-6">
              <Link href="/" className="text-sm font-medium text-muted hover:text-white transition-colors">
                Home
              </Link>
              <Link href="/activity" className="text-sm font-medium text-muted hover:text-white transition-colors">
                Activity Log
              </Link>
            </div>
          </div>
        </nav>
        <div className="flex-1">
          {children}
        </div>
      </body>
    </html>
  );
}
