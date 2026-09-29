"use client";

import Home from "../components/Home";
import SignIn from "../components/SignIn";
import { useAuth } from "../lib/auth";
import { isApiConfigured } from "../lib/config";

/**
 * The gate.
 *
 * Nothing that talks to the API is rendered until there is a signed-in user,
 * because every one of those calls would come back 401. Deciding it in one
 * place rather than inside each component means a new feature cannot forget to
 * check. The access token itself is set by the auth hook, not passed down.
 *
 * Three cases, and the order matters:
 *
 *   - Cognito configured: sign in, always.
 *   - Neither configured: local development against a local API with no
 *     authorizer on it, so no gate.
 *   - API configured but Cognito not: a deployed build with no way to sign in.
 *     That fails closed with a message rather than serving the app against an
 *     API that will reject every call.
 */
export default function Page() {
  const { status, email, signIn, signOut } = useAuth();

  if (status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-muted text-sm">Checking your session...</p>
      </main>
    );
  }

  if (status === "unconfigured" && isApiConfigured) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-2xl font-bold text-foreground">Sign-in is not configured</h1>
          <p className="text-sm text-muted">
            NEXT_PUBLIC_COGNITO_USER_POOL_ID and NEXT_PUBLIC_COGNITO_CLIENT_ID are unset, so
            there is no way to sign in. Copy web/.env.example to web/.env.local and fill
            them in.
          </p>
        </div>
      </main>
    );
  }

  if (status === "signed-out") {
    return <SignIn onSignIn={signIn} />;
  }

  return <Home onSignOut={signOut} signedInAs={email} />;
}
