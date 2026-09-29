/**
 * The Cognito action client.
 *
 * Two things are worth pinning down here. The first is the request: it is
 * unsigned and carries no credential, which is what makes a public client
 * callable from a browser at all, and it would be easy to "fix" a future bug by
 * quietly adding a signing key to the bundle. The second is the error
 * translation, because Cognito's raw codes are what a person stares at when
 * they mistype a password, and "NotAuthorizedException" is not an answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirmAccount,
  createAccount,
  emailProblem,
  passwordProblem,
  readSession,
  signIn,
  forgotPassword,
  confirmForgotPassword,
  AuthError,
} from "../lib/auth";

/** Minimal sessionStorage, since the suite runs in the node environment. */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

function jwt(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${body}.signature`;
}

let lastRequest: { url: string; init: RequestInit } | null = null;

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    lastRequest = { url, init };
    return new Response(JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  stubStorage();
  lastRequest = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the action request", () => {
  it("is unsigned, because a user pool client is public", async () => {
    respondWith({ UserConfirmed: false, UserSub: "sub-1" });
    await createAccount("someone@example.com", "Correct-Horse-9!Batt");

    const headers = lastRequest!.init.headers as Record<string, string>;
    expect(headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.SignUp");
    expect(headers["Content-Type"]).toBe("application/x-amz-json-1.1");
    // No secret, no session, no signature. A key here would ship to the browser.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("posts to the service root, not the dead OIDC paths", async () => {
    respondWith({ UserConfirmed: false, UserSub: "sub-1" });
    await createAccount("someone@example.com", "Correct-Horse-9!Batt");

    expect(lastRequest!.url).toMatch(/^https:\/\/cognito-idp\.[\w-]+\.amazonaws\.com\/$/);
    expect(lastRequest!.url).not.toContain("oauth2");
  });

  it("calls ForgotPassword with client id and username", async () => {
    respondWith({ CodeDeliveryDetails: { Destination: "s***@e***.com" } });
    await forgotPassword("someone@example.com");

    const headers = lastRequest!.init.headers as Record<string, string>;
    expect(headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.ForgotPassword");
    const body = JSON.parse(String(lastRequest!.init.body));
    expect(body.Username).toBe("someone@example.com");
  });

  it("calls ConfirmForgotPassword with code and new password", async () => {
    respondWith({});
    await confirmForgotPassword("someone@example.com", "123456", "Correct-Horse-9!Batt");

    const headers = lastRequest!.init.headers as Record<string, string>;
    expect(headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.ConfirmForgotPassword");
    const body = JSON.parse(String(lastRequest!.init.body));
    expect(body.Username).toBe("someone@example.com");
    expect(body.ConfirmationCode).toBe("123456");
    expect(body.Password).toBe("Correct-Horse-9!Batt");
  });

  it("calls GlobalSignOut with access token", async () => {
    respondWith({});
    const { globalSignOut } = await import("../lib/auth");
    await globalSignOut("access-token-xyz");

    const headers = lastRequest!.init.headers as Record<string, string>;
    expect(headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.GlobalSignOut");
    const body = JSON.parse(String(lastRequest!.init.body));
    expect(body.AccessToken).toBe("access-token-xyz");
  });

  it("calls DeleteUser with access token", async () => {
    respondWith({});
    const { deleteAccount } = await import("../lib/auth");
    await deleteAccount("access-token-xyz");

    const headers = lastRequest!.init.headers as Record<string, string>;
    expect(headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.DeleteUser");
    const body = JSON.parse(String(lastRequest!.init.body));
    expect(body.AccessToken).toBe("access-token-xyz");
  });
});

describe("error translation", () => {
  const cases: [string, string][] = [
    ["NotAuthorizedException", "do not match"],
    ["UserNotFoundException", "no account"],
    ["UserNotConfirmedException", "Confirm the code"],
    ["CodeMismatchException", "code is not right"],
    ["UserAlreadyExistsException", "already an account"],
  ];

  it.each(cases)("turns %s into something a person can act on", async (code, expected) => {
    respondWith({ __type: code }, 400);
    await expect(signIn("someone@example.com", "whatever-12!A")).rejects.toThrow(expected);
  });

  it("copes with the shape Cognito actually sends", async () => {
    // Cognito appends the HTTP status to __type on some error paths.
    respondWith({ __type: "NotAuthorizedException:400", message: "Incorrect username or password." }, 400);
    const error = await signIn("someone@example.com", "whatever-12!A").catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe("NotAuthorizedException");
    expect(error.message).not.toContain("Exception");
  });

  it("does not leave a session behind after a failure", async () => {
    respondWith({ __type: "NotAuthorizedException" }, 400);
    await signIn("someone@example.com", "wrong-12!A").catch(() => undefined);
    expect(readSession()).toBeNull();
  });
});

describe("sign in", () => {
  it("keeps the session the application and its tests both read", async () => {
    respondWith({
      AuthenticationResult: {
        AccessToken: jwt({ sub: "sub-42", token_use: "access" }),
        IdToken: jwt({ sub: "sub-42", email: "someone@example.com" }),
        RefreshToken: "refresh-1",
        ExpiresIn: 3600,
      },
    });

    const session = await signIn("someone@example.com", "Correct-Horse-9!Batt");

    expect(session.sub).toBe("sub-42");
    expect(session.email).toBe("someone@example.com");
    expect(session.refreshToken).toBe("refresh-1");
    // A minute of slack, so a token cannot expire between storing and using.
    expect(session.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);
    expect(readSession()?.accessToken).toBe(session.accessToken);
  });
});

describe("confirmAccount", () => {
  it("sends the email as the username, since that is what it was created with", async () => {
    respondWith({});
    await confirmAccount("someone@example.com", "123456");

    const body = JSON.parse(lastRequest!.init.body as string) as Record<string, string>;
    expect(lastRequest!.init.headers).toMatchObject({
      "X-Amz-Target": "AWSCognitoIdentityProviderService.ConfirmSignUp",
    });
    expect(body.Username).toBe("someone@example.com");
    expect(body.ConfirmationCode).toBe("123456");
  });
});

describe("readSession", () => {
  it("ignores an expired session rather than handing back a dead token", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: { getItem: (key: string) => store.get(key) ?? null },
    });
    store.set(
      "canens.session",
      JSON.stringify({ accessToken: "old", expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    );
    expect(readSession()).toBeNull();
  });
});

describe("passwordProblem", () => {
  it("accepts a password the pool would accept", () => {
    expect(passwordProblem("Correct-Horse-9!Batt")).toBeNull();
  });

  it("names every rule that is missing, rather than only the first", () => {
    const problem = passwordProblem("short");
    expect(problem).toContain("12 characters");
    expect(problem).toContain("upper case");
    expect(problem).toContain("symbol");
  });
});

describe("emailProblem", () => {
  it.each(["", "nope", "@example.com", "someone@"])("rejects %j", (value) => {
    expect(emailProblem(value)).not.toBeNull();
  });

  it("accepts an ordinary address", () => {
    expect(emailProblem("someone@example.com")).toBeNull();
  });
});

describe("signup velocity", () => {
  it("allows up to 3 sign-up attempts and then blocks further attempts", async () => {
    localStorage.removeItem("canens.signup_attempts");
    const { checkSignupVelocity, recordSignupAttempt } = await import("../lib/auth");
    
    expect(() => checkSignupVelocity()).not.toThrow();
    recordSignupAttempt();
    expect(() => checkSignupVelocity()).not.toThrow();
    recordSignupAttempt();
    expect(() => checkSignupVelocity()).not.toThrow();
    recordSignupAttempt();
    expect(() => checkSignupVelocity()).toThrow("Too many sign-up attempts");
  });
});
