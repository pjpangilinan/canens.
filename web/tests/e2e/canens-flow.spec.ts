import { test, expect } from '@playwright/test';

test.describe('Canens App Full Flow', () => {
  test('creates a goal, generates tasks, completes them, and tests search', async ({ page }) => {
    // 1. Go to app
    await page.goto('/');
    
    // 2. Create a Goal
    const goalTitle = `Test Goal ${Date.now()}`;
    const goalInput = page.getByPlaceholder('What is your next goal?');
    await goalInput.fill(goalTitle);
    await goalInput.press('Enter');
    
    // 3. Verify Goal appears
    await expect(page.getByText(goalTitle)).toBeVisible();
    
    // 4. Expand the goal
    const goalCardHeader = page.getByText(goalTitle);
    await goalCardHeader.click();
    
    // 5. Generate Next Steps
    // Note: this will hit the actual backend.
    const generateBtn = page.getByRole('button', { name: /Generate Steps/i }).first();
    await generateBtn.click();
    
    // Wait for the AI generation to finish
    await expect(generateBtn).not.toBeDisabled({ timeout: 60000 });
    
    // Verify some tasks were created
    const taskRows = page.locator('li.group\\/task');
    await taskRows.first().waitFor({ state: 'visible', timeout: 30000 });
    
    // 6. Complete the first task
    const firstTaskCompleteBtn = taskRows.first().locator('button[title="Mark as complete"]');
    await firstTaskCompleteBtn.click();
    
    // 7. Search for the goal
    const searchInput = page.getByPlaceholder('Search goals and tasks...');
    await searchInput.fill(goalTitle);
    
    // Goal should still be visible
    await expect(page.getByText(goalTitle)).toBeVisible();
    
    // 8. Complete the Goal
    const completeGoalBtn = page.locator('button[title="Complete Goal"]').first();
    await completeGoalBtn.click();
    
    // Goal status should change to Completed
    await expect(page.getByText('Completed').first()).toBeVisible();
  });
});
