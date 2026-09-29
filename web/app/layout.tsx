import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Canens",
  description: "Break a goal into the next few actions.",
};

/**
 * A Content-Security-Policy, built from the values this build actually runs on.
 *
 * The access token lives in sessionStorage, so the one thing worth blocking is
 * a script exfiltrating it: `connect-src` names the API and the Cognito endpoint
 * and nothing else, so a token can leave for those two hosts and no others.
 * `frame-ancestors 'none'` takes the site out of any frame, which is clickjacking
 * on a form that spends money.
 *
 * `'unsafe-inline'` in script-src is not negotiable for a Next.js static
 * export - the hydration payload is an inline script - so this is not a policy
 * that would stop inline XSS. There are no HTML sinks in the app for it to stop.
 * What it does buy is the exfiltration and framing backstop, which is the part
 * that a future dependency cannot quietly take away.
 *
 * Null when the API is unset, which is local development: there is no origin to
 * name and the dev server needs 'unsafe-eval', so a policy here would only
 * produce confusing failures against a stack that is not the deployed one.
 */
function contentSecurityPolicy(): string | null {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (!api) return null;
  const region = process.env.NEXT_PUBLIC_AWS_REGION ?? "us-east-1";
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${new URL(api).origin} https://cognito-idp.${region}.amazonaws.com`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const csp = contentSecurityPolicy();

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {csp && <meta httpEquiv="Content-Security-Policy" content={csp} />}
        <script
          dangerouslySetInnerHTML={{
            __html: `if (window.top !== window.self) { window.top.location = window.self.location; }`,
          }}
        />
      </head>
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
        <div className="flex-1 flex flex-col">{children}</div>
      </body>
    </html>
  );
}
