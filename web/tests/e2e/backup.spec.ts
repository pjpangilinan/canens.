import { expect, test } from "@playwright/test";

import { apiAvailable, clearLocalStore, resetServerSnapshot, startFromEmptyStore, waitForSnapshot } from "./helpers";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

/**
 * The backup round trip, against a running API.
 *
 * Needs a real backend:
 *
 *   cd backend && uvicorn app.main:app --port 8000
 *   CANENS_E2E_API=1 npm run test:e2e
 *
 * It is not in CI because the web build is a static export with the API URL
 * inlined at build time, so the suite would need a live deploy to point at.
 */
test.describe("Backup", () => {
  test.beforeEach(async ({ page, request }) => {
    test.skip(!apiAvailable, "Set CANENS_E2E_API=1 and run the backend");
    await resetServerSnapshot(request);
    await startFromEmptyStore(page);
  });

  test("uploads a snapshot and restores it into an empty store", async ({ page, request }) => {
    // Deliberately not prefixed "Backed up", which would collide with the
    // status line of the same name.
    const goalTitle = `Uploaded ${Date.now()}`;

    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();

    await waitForSnapshot(request, goalTitle);
    await expect(page.getByText(/^Backed up /)).toBeVisible();

    // Simulate losing the browser: wipe the store and reload.
    await clearLocalStore(page);
    await page.reload();

    // Having already backed up, an empty store means the user emptied it, so
    // the restore is offered rather than performed. That is the point: deleting
    // everything and finding it all back is not a recovery, it is a surprise.
    const restore = page.getByRole("button", { name: "Restore" });
    await expect(restore).toBeVisible();
    await restore.click();

    await expect(page.getByText("Restored your goals from backup.")).toBeVisible();
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
  });

  test("restores automatically on a browser that has never backed up", async ({ page, request }) => {
    await request.put(`${API_URL}/api/backup`, {
      data: {
        goals: [
          {
            id: "seed-goal",
            user_id: "00000000-0000-0000-0000-000000000000",
            title: `Fresh device ${Date.now()}`,
            status: "Active",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        tasks: [],
      },
    });

    // startFromEmptyStore already reloaded with nothing local; localStorage is
    // empty in a fresh context, so this is a genuinely new device.
    await startFromEmptyStore(page);

    await expect(page.getByRole("button", { name: "Restore" })).toBeHidden();
    await expect(page.getByText("Restored your goals from backup.")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Fresh device/ })).toBeVisible();
  });

  test("does not overwrite existing work on load", async ({ page, request }) => {
    const goalTitle = `Protected ${Date.now()}`;
    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
    await waitForSnapshot(request, goalTitle);

    // Add a second goal after the snapshot was taken, then reload. The stale
    // snapshot must not be allowed to remove it.
    const newer = `Newer ${Date.now()}`;
    await page.getByLabel("New goal").fill(newer);
    await page.getByLabel("New goal").press("Enter");
    await expect(page.getByRole("heading", { name: newer })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: newer })).toBeVisible();
    await expect(page.getByText("Restored your goals from backup.")).toBeHidden();
  });

  test("reports a backup failure instead of losing data", async ({ page }) => {
    await page.route("**/api/backup", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
        : route.continue(),
    );

    await page.getByLabel("New goal").fill(`Unbacked up ${Date.now()}`);
    await page.getByLabel("New goal").press("Enter");

    await expect(page.getByText(/Backup failed/)).toBeVisible({ timeout: 20_000 });
    // The goal is still there, and a retry is offered.
    await expect(page.getByRole("heading", { name: /Unbacked up/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
