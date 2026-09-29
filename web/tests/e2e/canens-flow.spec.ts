import { expect, test } from "@playwright/test";

import { resetServerSnapshot, startFromEmptyStore } from "./helpers";

/**
 * Exercises the flow that matters: a goal becomes next steps, steps get done,
 * and finishing them does not make the work unreachable.
 */
test.describe("Canens", () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerSnapshot(request);
    await startFromEmptyStore(page);
  });

  test("turns a goal into steps and completes them", async ({ page }) => {
    // Generating steps calls Amazon Bedrock, which needs a real AWS account
    // and costs money. Without CANENS_E2E_AI=1 the test is skipped rather than
    // failed, so the suite still means something on a machine that is not
    // configured for model access. The tests that do not touch the model
    // always run, including the one asserting a model failure is surfaced.
    test.skip(process.env.CANENS_E2E_AI !== "1", "Set CANENS_E2E_AI=1 to exercise Bedrock");
    // A real model call plus the 30s client timeout needs more than the
    // default 30s budget for the test as a whole.
    test.setTimeout(120_000);

    const goalTitle = `Ship the MVP ${Date.now()}`;

    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");

    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();

    // Collapse again so the flow reads top to bottom.
    await page.getByRole("button", { name: `Expand ${goalTitle}` }).click();

    await page.getByRole("button", { name: "Generate steps" }).click();

    // Wait for the outcome, not for the button. The button renames itself to
    // "Thinking..." while the model is working, so asserting on "Generate
    // steps" afterwards is a race that loses whenever the call is slow.
    const steps = page.locator("li.group\\/task");
    await expect(steps.first()).toBeVisible({ timeout: 60_000 });
    expect(await steps.count()).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Generate steps" })).toBeEnabled();

    // Completing every step archives the goal, which is the rule the browser
    // enforces. The step labels are read up front and each completion is
    // awaited by its effect on the count: clicking "the first one" in a loop
    // races the card's transition, so the element detaches mid-click and
    // Playwright retries against a re-render forever.
    const stepToggles = page.getByRole("checkbox", { name: /as done/ });
    const remaining = await stepToggles.count();
    for (let i = 0; i < remaining; i += 1) {
      const label = await stepToggles.first().getAttribute("aria-label");
      await page.getByRole("checkbox", { name: label! }).click();
      await expect(stepToggles).toHaveCount(remaining - i - 1);
    }

    // Every step completed, so the goal is archived: it leaves the active
    // list, and stays reachable in the Activity Log.
    await expect(page.getByRole("heading", { name: goalTitle })).toBeHidden();

    await page.getByRole("link", { name: "Activity Log" }).click();
    await expect(page.getByText(goalTitle)).toBeVisible();
  });

  test("reports a model failure instead of inventing a step", async ({ page }) => {
    // The old backend returned a hardcoded "Work on: <goal>" task when every
    // provider failed, which hid both the failure and the cost.
    await page.route("**/api/goals/next-steps", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Bedrock request failed" }),
      }),
    );

    const goalTitle = `Unreachable ${Date.now()}`;
    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");
    await page.getByRole("button", { name: `Expand ${goalTitle}` }).click();

    await page.getByRole("button", { name: "Generate steps" }).click();

    await expect(page.getByText(/Could not generate next steps/)).toBeVisible();
    await expect(page.locator("li.group\\/task")).toHaveCount(0);
  });

  test("keeps an added step undoable", async ({ page }) => {
    const goalTitle = `Undoable ${Date.now()}`;
    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();

    await page.getByRole("button", { name: `Expand ${goalTitle}` }).click();

    // Two steps, so completing one does not archive the goal and remove the
    // card. Completing the only step archiving the goal is covered separately.
    for (const step of ["Write the outline", "Send it to a publisher"]) {
      await page.getByRole("button", { name: "Add step" }).click();
      await page.getByPlaceholder("Describe the next step...").fill(step);
      await page.getByPlaceholder("Describe the next step...").press("Enter");
    }

    await page.getByRole("checkbox", { name: /Mark "Write the outline" as done/ }).click();
    await page.getByText("1 completed").click();

    const undo = page.getByRole("checkbox", { name: /Undo completion of "Write the outline"/ });
    await expect(undo).toBeChecked();
    // Click rather than uncheck: undoing the only completed step removes the
    // completed list, so the checkbox is detached by the time the click lands
    // and Playwright cannot re-assert its state.
    await undo.click();

    await expect(page.getByText("1 completed")).toBeHidden();
    await expect(page.getByText("Write the outline")).toBeVisible();
    // The goal stays archived-by-rule only if it was archived; here one step is
    // still outstanding, so it is still active and still on screen.
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
  });

  test("an un-completed step does not archive the goal again", async ({ page }) => {
    const goalTitle = `Stays archived ${Date.now()}`;
    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
    await page.getByRole("button", { name: `Expand ${goalTitle}` }).click();

    await page.getByRole("button", { name: "Add step" }).click();
    await page.getByPlaceholder("Describe the next step...").fill("Only step");
    await page.getByPlaceholder("Describe the next step...").press("Enter");

    await page.getByRole("checkbox", { name: /Mark "Only step" as done/ }).click();

    // The last step completed, so the goal left the active list.
    await expect(page.getByRole("heading", { name: goalTitle })).toBeHidden();

    // Reopen it deliberately from the Activity Log, then undo the step. It has
    // work outstanding again, but archiving is a one-way door: the goal stays
    // where it is until it is archived, or reopened, again.
    await page.getByRole("link", { name: "Activity Log" }).click();
    await expect(page.getByText(goalTitle)).toBeVisible();
    await page.getByRole("button", { name: "Reopen" }).first().click();
    await expect(page.getByText(goalTitle)).toBeHidden();

    await page.getByRole("link", { name: "Home" }).click();
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
    await page.getByRole("button", { name: `Expand ${goalTitle}` }).click();
    await page.getByText("1 completed").click();
    await page.getByRole("checkbox", { name: /Undo completion of "Only step"/ }).click();

    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
    await expect(page.getByText("Only step")).toBeVisible();
  });

  test("finds a goal by one of its step titles", async ({ page }) => {
    const goalTitle = `Searchable ${Date.now()}`;
    const stepTitle = `quokka migration plan`;

    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");
    await page.getByRole("button", { name: `Expand ${goalTitle}` }).click();
    await page.getByRole("button", { name: "Add step" }).click();
    await page.getByPlaceholder("Describe the next step...").fill(stepTitle);
    await page.getByPlaceholder("Describe the next step...").press("Enter");

    await page.getByRole("searchbox", { name: "Search goals and steps" }).fill("quokka");

    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
    await expect(page.getByText(stepTitle)).toBeVisible();

    await page.getByRole("searchbox", { name: "Search goals and steps" }).fill("nothing matches this");
    await expect(page.getByText(/Nothing matches/)).toBeVisible();
  });

  test("archives a completed goal into the activity log", async ({ page }) => {
    const goalTitle = `Historic ${Date.now()}`;
    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");

    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
    await page.getByRole("button", { name: "Complete goal", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: goalTitle })).toBeHidden();

    // Archived goals leave the active list but must remain reachable.
    await page.getByRole("link", { name: "Activity Log" }).click();
    await expect(page.getByText(goalTitle)).toBeVisible();
  });

  test("reopening an archived goal returns it to the active list", async ({ page }) => {
    const goalTitle = `Reopenable ${Date.now()}`;
    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();

    await page.getByRole("button", { name: "Complete goal", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: goalTitle })).toBeHidden();

    await page.getByRole("link", { name: "Activity Log" }).click();
    await expect(page.getByText(goalTitle)).toBeVisible();

    await page.getByRole("button", { name: "Reopen" }).first().click();
    await expect(page.getByText(goalTitle)).toBeHidden();

    await page.getByRole("link", { name: "Home" }).click();
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();
  });

  test("renaming a goal supports escape cancellation and enter saving", async ({ page }) => {
    const original = `Original Goal ${Date.now()}`;
    await page.getByLabel("New goal").fill(original);
    await page.getByLabel("New goal").press("Enter");
    await expect(page.getByRole("heading", { name: original })).toBeVisible();

    // Click rename button
    await page.getByRole("button", { name: `Rename "${original}"` }).click();
    const renameInput = page.getByRole("textbox", { name: `Rename "${original}"` });
    await expect(renameInput).toBeVisible();

    // Type something else and press Escape to cancel
    await renameInput.fill("Cancelled Name");
    await renameInput.press("Escape");
    await expect(page.getByRole("heading", { name: original })).toBeVisible();

    // Now rename and save with Enter
    await page.getByRole("button", { name: `Rename "${original}"` }).click();
    const updated = `Updated Goal ${Date.now()}`;
    const activeInput = page.getByRole("textbox", { name: `Rename "${original}"` });
    await activeInput.fill(updated);
    await activeInput.press("Enter");

    await expect(page.getByRole("heading", { name: updated })).toBeVisible();
  });

  test("step creation and inline editing support escape cancellation and deletion", async ({ page }) => {
    const goalTitle = `Step Ops ${Date.now()}`;
    await page.getByLabel("New goal").fill(goalTitle);
    await page.getByLabel("New goal").press("Enter");
    await expect(page.getByRole("heading", { name: goalTitle })).toBeVisible();

    await page.getByRole("button", { name: `Expand ${goalTitle}` }).click();

    // Open add step, press Escape to cancel
    await page.getByRole("button", { name: "Add step" }).click();
    const stepInput = page.getByLabel(`Add a step to "${goalTitle}"`);
    await expect(stepInput).toBeVisible();
    await stepInput.press("Escape");
    await expect(stepInput).toBeHidden();

    // Now add a real step
    await page.getByRole("button", { name: "Add step" }).click();
    const addInput = page.getByLabel(`Add a step to "${goalTitle}"`);
    await addInput.fill("Initial Step Name");
    await addInput.press("Enter");
    await expect(page.getByText("Initial Step Name")).toBeVisible();

    // Edit step and cancel with Escape
    await page.getByRole("button", { name: 'Edit "Initial Step Name"' }).click();
    const editInput = page.getByLabel("Step title");
    await expect(editInput).toBeVisible();
    await editInput.fill("Cancelled Step Edit");
    await editInput.press("Escape");
    await expect(page.getByText("Initial Step Name")).toBeVisible();

    // Edit step and save with Enter
    await page.getByRole("button", { name: 'Edit "Initial Step Name"' }).click();
    await page.getByLabel("Step title").fill("Saved Step Edit");
    await page.getByLabel("Step title").press("Enter");
    await expect(page.getByText("Saved Step Edit")).toBeVisible();

    // Delete step
    await page.getByRole("button", { name: 'Delete "Saved Step Edit"' }).click();
    await expect(page.getByText("Saved Step Edit")).toBeHidden();

    // Delete entire goal
    await page.getByRole("button", { name: `Delete "${goalTitle}"` }).click();
    await expect(page.getByRole("heading", { name: goalTitle })).toBeHidden();
  });

  test("account options: export data and delete account confirmation modal", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Export data (JSON)" })).toBeVisible();

    // Verify export triggers download event
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export data (JSON)" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^canens-backup-.*\.json$/);

    // Verify Delete Account modal opens and cancels
    await page.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("heading", { name: "Delete Account and Data?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Delete Account and Data?" })).toBeHidden();
  });
});
