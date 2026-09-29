"use client";

/**
 * What a signed-out visitor sees: sign in, or create an account.
 *
 * This is a form rather than a link to a hosted page because this pool's
 * hosted-UI endpoints all answer 400, and the domain the hosted UI would live
 * on is not exposed by any API - see lib/auth.ts for the details. Credentials
 * are posted straight to Cognito's action API and never stored here; the
 * password reaches no other host, and this app keeps no copy of it.
 *
 * The trade this makes with a hosted UI: there is no "forgot your password"
 * link, because password reset is a hosted-UI page. A person who forgets their
 * password has to be helped another way. That is a real cost of the current
 * setup, and the right fix is a domain on the pool, which is what would make
 * the hosted UI reachable.
 */
import { useState } from "react";
import {
  createAccount,
  confirmAccount,
  emailProblem,
  AuthError,
  passwordProblem,
  signIn as signInFor,
} from "../lib/auth";

type Mode = "signin" | "signup" | "confirm";

const FIELD =
  "w-full bg-background border border-primary/20 rounded-lg px-3 py-2.5 text-foreground " +
  "placeholder:text-muted/50 focus:outline-none focus:border-primary/60";

export default function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const passwordHint = mode === "signup" ? passwordProblem(password) : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);

    const badEmail = emailProblem(email);
    if (badEmail) return setError(badEmail);
    if (mode !== "confirm") {
      const badPassword = mode === "signup" ? passwordProblem(password) : null;
      if (badPassword) return setError(badPassword);
    } else if (!code.trim()) {
      return setError("Enter the code from the email.");
    }

    setBusy(true);
    try {
      if (mode === "signin") {
        await signInFor(email, password);
        onSignedIn();
        return;
      }
      if (mode === "signup") {
        await createAccount(email, password);
        setNotice(`We sent a code to ${email}. Enter it below to finish.`);
        setMode("confirm");
        return;
      }
      await confirmAccount(email, code.trim());
      await signInFor(email, password);
      onSignedIn();
    } catch (caught) {
      // A confirmed account that the pool still reports as unconfirmed is the
      // one failure worth acting on rather than just reporting.
      if (caught instanceof AuthError && caught.code === "UserNotConfirmedException") {
        setNotice(`We sent a code to ${email}. Enter it below to finish.`);
        setMode("confirm");
        setError(caught.message);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setCode("");
  }

  const title = mode === "signin" ? "Sign in" : mode === "signup" ? "Create an account" : "Confirm your email";
  const cta =
    mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Confirm and sign in";

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="max-w-md w-full space-y-8">
        <header className="space-y-3 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold text-foreground tracking-tight">
            Canens<span className="text-primary">.</span>
          </h1>
          <p className="text-lg text-muted">Break a goal into the next few actions.</p>
        </header>

        <form onSubmit={submit} className="bg-surface border border-primary/20 rounded-xl p-8 space-y-4 shadow-glass">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>

          {notice && (
            <p className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">
              {error}
            </p>
          )}

          {mode !== "confirm" && (
            <>
              <label className="block space-y-1.5">
                <span className="text-xs text-muted">Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className={FIELD}
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs text-muted">Password</span>
                <input
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className={FIELD}
                />
              </label>

              {passwordHint && <p className="text-xs text-muted">{passwordHint}</p>}
            </>
          )}

          {mode === "confirm" && (
            <label className="block space-y-1.5">
              <span className="text-xs text-muted">Confirmation code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className={FIELD}
              />
            </label>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-primary text-white px-4 py-3 rounded-lg font-medium hover:bg-primary-light transition-colors disabled:opacity-50 disabled:hover:bg-primary"
          >
            {busy ? "Working..." : cta}
          </button>

          <div className="flex items-center justify-center gap-1 text-sm pt-1">
            {mode === "signin" ? (
              <>
                <span className="text-muted">No account?</span>
                <button type="button" onClick={() => switchTo("signup")} className="text-primary hover:text-primary-light">
                  Create one
                </button>
              </>
            ) : (
              <>
                <span className="text-muted">Already have an account?</span>
                <button type="button" onClick={() => switchTo("signin")} className="text-primary hover:text-primary-light">
                  Sign in
                </button>
              </>
            )}
          </div>
        </form>

        <p className="text-xs text-muted/70 text-center">
          A new account gets 25 model calls a day. Goals stay in this browser unless you sync
          them to your account.
        </p>
      </div>
    </main>
  );
}
