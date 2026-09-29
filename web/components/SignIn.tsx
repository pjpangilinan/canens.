"use client";

/**
 * What a signed-out visitor sees.
 *
 * There is no sign-up form here on purpose: the hosted UI owns credentials, so
 * the password never passes through this application and there is nothing here
 * to get wrong. The links carry the action, because they are two different
 * hosted-UI pages.
 */
export default function SignIn({ onSignIn, reason }: { onSignIn: () => void; reason?: string }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="max-w-md w-full space-y-8 text-center">
        <header className="space-y-3">
          <h1 className="text-4xl md:text-5xl font-extrabold text-foreground tracking-tight">
            Canens<span className="text-primary">.</span>
          </h1>
          <p className="text-lg text-muted">Break a goal into the next few actions.</p>
        </header>

        {reason && (
          <p className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2">
            {reason}
          </p>
        )}

        <div className="bg-surface border border-primary/20 rounded-xl p-8 space-y-4 shadow-glass">
          <p className="text-sm text-muted">
            Your goals live in this browser. Sign in to keep a copy somewhere else and to
            use the model.
          </p>
          <button
            onClick={onSignIn}
            className="w-full bg-primary text-white px-4 py-3 rounded-lg font-medium hover:bg-primary-light transition-colors"
          >
            Sign in or create an account
          </button>
        </div>

        <p className="text-xs text-muted/70">
          A new account gets a handful of model calls to start with, and more each day for
          the first few.
        </p>
      </div>
    </main>
  );
}
