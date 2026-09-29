/**
 * What the browser actually sends.
 *
 * The bearer token is the whole of the authorisation now, so getting this
 * header wrong makes every call fail with a 401 that looks like a server
 * problem rather than a client one.
 */
import { afterEach, describe, expect, it } from "vitest";

import { apiHeaders, cognitoConfigured, isApiConfigured } from "../lib/config";
import { getAccessToken, setAccessToken } from "../lib/session";

afterEach(() => setAccessToken(null));

describe("apiHeaders", () => {
  it("always sends JSON, whatever the auth state", () => {
    expect(apiHeaders()["Content-Type"]).toBe("application/json");
  });

  it("omits Authorization when there is no token", () => {
    expect(apiHeaders()).not.toHaveProperty("Authorization");
  });

  it("uses the token passed in", () => {
    expect(apiHeaders("abc")["Authorization"]).toBe("Bearer abc");
  });

  it("falls back to the session token", () => {
    setAccessToken("from-session");
    expect(apiHeaders()["Authorization"]).toBe("Bearer from-session");
  });

  it("prefers an explicit token over the session", () => {
    setAccessToken("stale");
    expect(apiHeaders("fresh")["Authorization"]).toBe("Bearer fresh");
  });

  it("does not send a stale session token after sign-out", () => {
    setAccessToken("live");
    expect(getAccessToken()).toBe("live");
    setAccessToken(null);
    expect(apiHeaders()).not.toHaveProperty("Authorization");
  });
});

describe("build-time configuration", () => {
  it("reports the API as unconfigured when the URL is missing", () => {
    // The suite runs with no .env.local, so this is the local-development case.
    expect(isApiConfigured).toBe(false);
  });

  it("reports Cognito as unconfigured when the pool is missing", () => {
    // Which is why the app shows a setup message rather than a sign-in button
    // that cannot work.
    expect(cognitoConfigured).toBe(false);
  });
});
