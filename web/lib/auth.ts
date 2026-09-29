/**
 * Sign-in, through the Cognito hosted UI.
 *
 * The hosted UI is a redirect, not a fetch: the browser leaves for Cognito,
 * the user signs in there, and Cognito sends them back with a one-time code.
 * That is why the app is a public client with no secret - there is nothing for
 * a browser to keep secret, and PKCE is what stops an intercepted code from
 * being replayed.
 *
 * `oidc-client-ts` does the PKCE dance, the token exchange, the refresh and the
 * state check. Hand-rolling that is about a hundred lines of code in the path
 * of every request, which is the wrong place to be clever.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

import { cognitoConfigured } from "./config";
import { setAccessToken } from "./session";

const region = process.env.NEXT_PUBLIC_AWS_REGION ?? "us-east-1";
const poolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "";
const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";

let manager: UserManager | null = null;

function userManager(): UserManager | null {
  if (!cognitoConfigured) return null;
  if (manager) return manager;

  // The redirect target has to be the origin, without a base path: Cognito
  // matches the registered callback literally.
  const origin = window.location.origin;

  manager = new UserManager({
    authority: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
    client_id: clientId,
    redirect_uri: `${origin}/`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: "code",
    scope: "openid email profile",
    // Session storage, not local storage. A token left in local storage outlives
    // the tab and is readable by anything with script access on the origin.
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
    // The hosted UI is a full page, so the browser is redirected away. There is
    // no third-party iframe to keep alive, and silent renew is not needed.
    silent_redirect_uri: `${origin}/`,
  });
  return manager;
}

export type AuthStatus = "loading" | "signed-in" | "signed-out" | "unconfigured";

export interface Auth {
  status: AuthStatus;
  email: string | null;
  signIn: () => void;
  signOut: () => void;
}

export function useAuth(): Auth {
  // Derived rather than set from inside the effect: whether Cognito is
  // configured is known at build time, so there is nothing to wait for.
  const [status, setStatus] = useState<AuthStatus>(
    cognitoConfigured ? "loading" : "unconfigured",
  );
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const um = userManager();
    if (!um) return;

    let cancelled = false;

    const settle = (next: User | null | undefined) => {
      if (cancelled) return;
      // The API client reads the token from the session module, so it is set
      // here rather than passed down to every call site that needs it.
      setAccessToken(next && !next.expired ? accessToken(next) : null);
      setUser(next ?? null);
      setStatus(next && !next.expired ? "signed-in" : "signed-out");
    };

    (async () => {
      // Coming back from the hosted UI: the URL carries a one-time code that has
      // to be exchanged before anything else will work.
      const params = new URLSearchParams(window.location.search);
      if (params.has("code") || params.has("error")) {
        try {
          settle(await um.signinCallback());
        } catch {
          settle(null);
        }
        // Drop the code from the address bar so a refresh does not try to
        // exchange the same one-time code a second time.
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
      }

      try {
        settle(await um.getUser());
      } catch {
        settle(null);
      }
    })();

    // A refresh in another tab, or a silent renew, should update this one.
    const onUserChanged = (next: User) => settle(next);
    um.events.addUserLoaded(onUserChanged);
    um.events.addUserSignedOut(() => settle(null));

    return () => {
      cancelled = true;
      um.events.removeUserLoaded(onUserChanged);
    };
  }, []);

  const signIn = useCallback(() => {
    // Nothing to hand over: the hosted UI collects the credentials.
    void userManager()?.signinRedirect();
  }, []);

  const signOut = useCallback(() => {
    // Clear locally first: a failed redirect must not leave a usable token
    // behind in this tab.
    setAccessToken(null);
    void userManager()?.signoutRedirect();
  }, []);

  return {
    status,
    email: user?.profile?.email ?? null,
    signIn,
    signOut,
  };
}

/** The access token, for the Authorization header. */
export function accessToken(user: User | null | undefined): string | null {
  return user?.access_token ?? null;
}
