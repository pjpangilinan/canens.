/**
 * The access token for this tab.
 *
 * Deliberately a module rather than a prop. The token is needed by the API
 * client, the backup scheduler and the model calls, all of which are reached
 * from deep inside the store and from components that have no business knowing
 * about authentication. Threading it through every call site would put an auth
 * concern in the middle of the domain code to avoid one small module.
 *
 * It is cleared on sign-out and on expiry, so a stale token cannot be sent
 * after the session ends. apiHeaders() reads it, which is the only consumer.
 */

let current: string | null = null;

export function setAccessToken(token: string | null): void {
  current = token;
}

export function getAccessToken(): string | null {
  return current;
}
