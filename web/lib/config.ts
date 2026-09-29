/**
 * Runtime configuration.
 *
 * The API base URL and the Cognito details are inlined at build time because
 * the site is a static export with no server. A missing value is a deployment
 * mistake, so the guard for it lives in the deploy workflow rather than here:
 * throwing at module scope would break `next build` locally, and the failure
 * surfaced during prerendering, which is a confusing place to learn that an
 * environment variable is unset.
 */

import { getAccessToken } from "./session";

const configured = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";

export const API_BASE = configured || "http://localhost:8000";

export const isApiConfigured = configured.length > 0;

const poolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID?.trim() ?? "";
const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID?.trim() ?? "";

/**
 * False when the pool details are missing, which is what local development
 * looks like until they are set. The app then runs with no sign-in, and the
 * API rejects it, so the developer finds out immediately rather than shipping a
 * site nobody can use.
 */
export const cognitoConfigured = poolId.length > 0 && clientId.length > 0;

export const COGNITO_REGION = process.env.NEXT_PUBLIC_AWS_REGION ?? "us-east-1";
export const COGNITO_POOL_ID = poolId;
export const COGNITO_CLIENT_ID = clientId;

/**
 * Headers for an API call.
 *
 * The bearer token is the whole of the authorisation: API Gateway's JWT
 * authorizer verifies it before the function is invoked, so a request without a
 * valid one never reaches the application. There is no shared secret, because
 * there is no longer a single client to share it with.
 *
 * Falls back to the token in the session so the callers deep in the store do
 * not have to know one exists.
 */
export function apiHeaders(token?: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const bearer = token ?? getAccessToken();
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  return headers;
}
