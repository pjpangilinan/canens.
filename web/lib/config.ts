/**
 * Runtime configuration.
 *
 * The API base URL and token are inlined at build time because the site is a
 * static export with no server. The previous build fell back to
 * `http://<hostname>:8000`, which meant a deployed page silently pointed at a
 * port that does not exist on the host serving it.
 *
 * A missing API URL is a deployment mistake, so the guard for it lives in the
 * deploy workflow rather than here: throwing at module scope would break
 * `next build` locally, and the failure surfaced during prerendering, which is
 * a confusing place to learn that an environment variable is unset. The
 * deploy workflow fails the build if it is missing, and the app shows an
 * explicit message at runtime if the endpoint is unreachable.
 */

const configured = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";

export const API_BASE = configured || "http://localhost:8000";

export const isApiConfigured = configured.length > 0;

/**
 * Shared secret required by the API. This is not real authentication: it
 * ships in the public bundle, so anyone who can load the page has it. It
 * exists to stop casual abuse of a public endpoint, alongside API Gateway
 * throttling. Unset locally so development needs no configuration.
 */
export const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN;

export function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_TOKEN) headers["X-Canens-Token"] = API_TOKEN;
  return headers;
}
