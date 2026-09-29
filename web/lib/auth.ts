/**
 * Sign-in, talking to Cognito's action API directly.
 *
 * The obvious implementation is a redirect to Cognito's hosted UI with the
 * authorization-code flow and PKCE, and that is what this did first. It cannot
 * work against this pool: every path under the OIDC surface -
 * /oauth2/authorize, /authorize, /oauth2/token, /login, /userInfo - answers
 * 400 "The server did not understand the operation that was requested", the
 * pool's own discovery document advertises those broken endpoints, and the
 * Cognito domain the hosted UI would live on is not exposed by any API, so it
 * cannot be addressed. The action API - what boto3 and the AWS SDKs call - works
 * perfectly.
 *
 * That is reachable from a browser. A user pool *client* is public, so its
 * requests are unsigned: no SigV4, no secret, no signing key in a bundle. The
 * request is a POST to the service root with an X-Amz-Target naming the
 * operation, and Cognito answers with Access-Control-Allow-Origin: * so a page
 * can call it. This is what the AWS JS SDK does under the hood; the only thing
 * dropped is the hosted UI, so there is no password reset and no hosted page
 * for sign-up - both are described in components/SignIn.tsx.
 *
 * The token this produces is the same one the authorizer accepts, verified
 * end to end against the deployed API.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import { COGNITO_CLIENT_ID, COGNITO_REGION, cognitoConfigured } from "./config";
import { setAccessToken } from "./session";

const ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

const SESSION_KEY = "canens.session";

export interface Session {
  accessToken: string;
  refreshToken: string | null;
  idToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  email: string;
  sub: string;
}

/** Cognito's error code, e.g. "NotAuthorizedException", from a failed call. */
export class AuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface CognitoClaims {
  sub: string;
  email?: string;
  "cognito:username"?: string;
  username?: string;
  email_verified?: boolean;
  token_use: string;
}

function decodeClaims(token: string): CognitoClaims {
  const part = token.split(".")[1] ?? "";
  const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  try {
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch {
    return { sub: "", token_use: "" };
  }
}

/**
 * One Cognito action.
 *
 * The Content-Type and X-Amz-Target headers are the whole protocol. There is
 * no Authorization header, and that is the point rather than an omission: a
 * public client has nothing to sign with.
 */
async function action<T = Record<string, unknown>>(
  operation: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Cognito reports the failure in the body as __type, sometimes with a
    // trailing ":..." suffix.
    const raw = String(body?.__type ?? body?.message ?? "UnknownError");
    const code = raw.split(":")[0];
    throw new AuthError(code, messageFor(code, body?.message));
  }
  return body as T;
}

function messageFor(code: string, fallback?: string): string {
  switch (code) {
    case "NotAuthorizedException":
      return "That email and password do not match an account.";
    case "UserNotFoundException":
      return "There is no account with that email.";
    case "UserAlreadyExistsException":
    case "UsernameExistsException":
      return "There is already an account with that email. Sign in instead.";
    case "UserNotConfirmedException":
      return "Confirm the code we emailed you first.";
    case "CodeMismatchException":
      return "That code is not right.";
    case "ExpiredCodeException":
      return "That code has expired. Ask for another.";
    case "InvalidPasswordException":
      return "Use at least 12 characters, with an upper case letter, a lower case letter, a number and a symbol.";
    case "LimitExceededException":
      return "Too many attempts. Wait a minute and try again.";
    case "NotAuthorizedException2":
      return "Sign in failed.";
    default:
      return fallback ?? "Something went wrong. Try again.";
  }
}

// -------------------------------------------------------------- passwords

/** The pool's policy, mirrored so the form can say so before a round trip. */
export const PASSWORD_RULES = [
  { test: /.{12,}/, message: "at least 12 characters" },
  { test: /[a-z]/, message: "a lower case letter" },
  { test: /[A-Z]/, message: "an upper case letter" },
  { test: /[0-9]/, message: "a number" },
  { test: /[^A-Za-z0-9]/, message: "a symbol" },
];

export function passwordProblem(password: string): string | null {
  const missing = PASSWORD_RULES.filter((rule) => !rule.test.test(password)).map(
    (rule) => rule.message,
  );
  return missing.length ? `Needs ${missing.join(", ")}.` : null;
}

export function emailProblem(email: string): string | null {
  if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
    return "That does not look like an email address.";
  }
  return null;
}

// ----------------------------------------------------------------- actions

interface AuthResult {
  AccessToken: string;
  IdToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
}

interface AuthResponse {
  AuthenticationResult: AuthResult;
}

function toSession(result: AuthResult): Session {
  const claims = decodeClaims(result.IdToken || result.AccessToken);
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    // A refresh returns no new refresh token, so the existing one is kept by
    // the caller.
    refreshToken: result.RefreshToken ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + result.ExpiresIn,
    email: claims.email ?? claims["cognito:username"] ?? claims.username ?? "",
    sub: claims.sub,
  };
}

export function createAccount(email: string, password: string): Promise<void> {
  return action("SignUp", {
    ClientId: COGNITO_CLIENT_ID,
    Username: email,
    Password: password,
    // Silently ignored unless a pre-confirmed sign-up policy is in place, and
    // harmless to send, so a pool reconfigured later does not send a second
    // code.
    ClientMetadata: {},
  }).then(() => undefined);
}

export function confirmAccount(email: string, code: string): Promise<void> {
  return action("ConfirmSignUp", {
    ClientId: COGNITO_CLIENT_ID,
    Username: email,
    ConfirmationCode: code,
  }).then(() => undefined);
}

export async function signIn(email: string, password: string): Promise<Session> {
  const result = await action<AuthResponse>("InitiateAuth", {
    ClientId: COGNITO_CLIENT_ID,
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const session = toSession(result.AuthenticationResult);
  persist(session);
  return session;
}

async function refreshSession(session: Session): Promise<Session> {
  if (!session.refreshToken) throw new AuthError("NotAuthorizedException", "Session expired.");
  const result = await action<AuthResponse>("InitiateAuth", {
    ClientId: COGNITO_CLIENT_ID,
    AuthFlow: "REFRESH_TOKEN_AUTH",
    AuthParameters: { REFRESH_TOKEN: session.refreshToken },
  });
  const next = toSession(result.AuthenticationResult);
  const merged: Session = { ...next, refreshToken: next.refreshToken ?? session.refreshToken };
  persist(merged);
  return merged;
}

// ----------------------------------------------------------------- storage

function persist(session: Session): void {
  // Session storage, not local storage: the token dies with the tab, so a
  // machine left open does not keep a usable credential in it.
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  setAccessToken(session.accessToken);
}

export function readSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    return session.expiresAt > Math.floor(Date.now() / 1000) ? session : null;
  } catch {
    return null;
  }
}

export function forgetSession(): void {
  window.sessionStorage.removeItem(SESSION_KEY);
  setAccessToken(null);
}

/** A token that will still be valid in a minute, refreshing if it is not. */
let inFlight: Promise<Session> | null = null;

export async function validSession(): Promise<Session | null> {
  const current = readSession();
  if (!current) return null;
  if (current.expiresAt - Math.floor(Date.now() / 1000) > 60) return current;

  // Concurrent callers must not each fire a refresh: Cognito rotates the
  // refresh token, and the losers of that race invalidate the winner.
  if (!inFlight) {
    inFlight = refreshSession(current)
      .catch((error) => {
        forgetSession();
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export { COGNITO_CLIENT_ID };

// -------------------------------------------------------------------- hook

export type AuthStatus = "loading" | "signed-out" | "signed-in" | "unconfigured";

/**
 * The signed-in user, kept fresh.
 *
 * Access tokens last an hour, so something has to refresh them or a page left
 * open starts failing. It is done here rather than in the request path: the
 * header helper is synchronous, so putting a refresh in front of every call
 * would mean making it async and touching every caller for no gain. Refreshing
 * a minute before expiry is early enough to be invisible, and re-checking on
 * focus covers a machine that was asleep past the deadline.
 */
export function useAuth(): {
  status: AuthStatus;
  session: Session | null;
  signOut: () => void;
  recheck: () => void;
} {
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);

  const recheck = useCallback(() => {
    setSession(readSession());
    setLoaded(true);
  }, []);

  const signOut = useCallback(() => {
    forgetSession();
    setSession(null);
  }, []);

  // The session lives in sessionStorage, which does not exist while the server
  // renders, so the first render has to say "loading" on both sides. Reading it
  // during render would fix that and break hydration instead: the client's
  // first pass would disagree with the server's HTML and React would throw
  // error 418. The read therefore has to wait for the effect, which is the case
  // the set-state-in-effect rule is aimed away from - it is about cascading
  // renders, and this is a one-time read of storage the server never sees.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSession(readSession());
    setLoaded(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    const settle = (next: Session | null) => {
      if (!cancelled) setSession(next);
    };
    const refresh = () => {
      validSession().then(settle, () => {
        forgetSession();
        settle(null);
      });
    };

    const timer = setTimeout(refresh, Math.max(5_000, (session.expiresAt - 60) * 1000 - Date.now()));
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [session]);

  const status: AuthStatus = !loaded
    ? "loading"
    : session
      ? "signed-in"
      : cognitoConfigured
        ? "signed-out"
        : "unconfigured";

  return { status, session, signOut, recheck };
}
