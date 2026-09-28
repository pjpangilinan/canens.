import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

/** Set CANENS_E2E_API=1 and run the backend to exercise the network paths. */
export const apiAvailable = process.env.CANENS_E2E_API === "1";

/**
 * Empty the stored snapshot.
 *
 * The snapshot is shared server state. Without this, a spec that does not
 * care about the network still restores whatever the previous spec left
 * behind, and its "the store is empty" precondition quietly stops holding.
 */
export async function resetServerSnapshot(request: APIRequestContext): Promise<void> {
  if (!apiAvailable) return;
  const response = await request.put(`${API_URL}/api/backup`, { data: { goals: [], tasks: [] } });
  expect(response.status(), "could not reset the stored snapshot").toBe(200);
}

/**
 * Empty the local store and get the app into a known state.
 *
 * IndexedDB is scoped to the page origin, so this never touches a
 * developer's real data. The delete is done via evaluate and followed by a
 * reload rather than with addInitScript, which would re-run on every
 * navigation and re-wipe the store mid-test.
 */
export async function startFromEmptyStore(page: Page): Promise<void> {
  await page.goto("/");
  await clearLocalStore(page);
  await page.reload();
  // Waiting for the first client render also waits for hydration, so a
  // submit is handled by React rather than falling through to a native form
  // submission and reloading the page.
  await expect(page.getByRole("heading", { name: "Start with a goal" })).toBeVisible();
}

export function clearLocalStore(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase("CanensLocalDB");
        request.onsuccess = request.onerror = request.onblocked = () => resolve(null);
      }),
  );
}

/** Wait for a goal to reach the stored snapshot. */
export async function waitForSnapshot(request: APIRequestContext, title: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const body = await (await request.get(`${API_URL}/api/backup`)).json();
        return (body.goals ?? []).some((goal: { title: string }) => goal.title === title);
      },
      { timeout: 20_000, message: "the goal was never uploaded" },
    )
    .toBe(true);
}
