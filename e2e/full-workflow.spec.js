// IMPORTANT — HONESTY NOTE: this file was written but never actually run. This sandbox's
// network allowlist blocks cdn.playwright.dev, which is where `npx playwright install` downloads
// the actual Chromium binary from — confirmed directly by trying it (403 "Host not in
// allowlist"). Every other test in this project (test/*.test.js, 79 tests) was genuinely run and
// verified; this file was not, and should be treated as unverified until you run it yourself.
//
// To run for real on your own machine:
//   npm install --save-dev @playwright/test
//   npx playwright install chromium
//   npm start   (in one terminal, so the real app is listening on :4000)
//   npx playwright test   (in another terminal)
//
// Selectors below were taken directly from the real public/app.js source (not guessed), but
// since this has never actually executed against a real browser, minor selector/timing fixes
// may still be needed on a first real run — normal for any new E2E suite.
const { test, expect } = require('@playwright/test');

async function login(page, username, password) {
  await page.goto('/');
  await page.fill('#lg-user', username);
  await page.fill('#lg-pass', password);
  await page.click('[data-act="login"]');
  await expect(page.locator('.sidebar-quote, .today-stat, .nav-link')).toBeVisible({ timeout: 10000 });
}

test.describe('Full task lifecycle through the real UI', () => {
  test('login → create task with levels → submit → approve → release next level → close', async ({ page }) => {
    await login(page, 'admin', 'admin123');

    // Navigate to My Tasks and open the creation form.
    await page.click('[data-nav="tasks"], text=My Tasks');
    await page.click('[data-act="new-task"], text=New Task');

    await page.fill('#new-task-title', 'E2E Level Test');
    await page.fill('#new-task-desc', 'Created by an automated browser test.');
    await page.selectOption('#new-task-priority', 'medium');
    const deadline = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await page.fill('#new-task-deadline', deadline);

    // Level 1: tag rohit.k. Add a Level, tag suraj_kathale on Level 2.
    await page.click('#stage-tagpicker-0 [data-tagpicker-input]');
    await page.fill('#stage-tagpicker-0 [data-tagpicker-input]', 'rohit');
    await page.click('.tag-suggestion-item >> text=Rohit');
    await page.click('[data-act="add-task-stage"]');
    await page.fill('#stage-tagpicker-1 [data-tagpicker-input]', 'suraj');
    await page.click('.tag-suggestion-item >> text=Suraj');

    await page.click('[data-act="submit-task"]');
    await expect(page.locator('text=E2E Level Test')).toBeVisible();

    // Level 2 (suraj) should show as on hold until Level 1 is approved.
    await expect(page.locator('text=On Hold')).toBeVisible();
  });

  test('reject → resubmit', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    // Assumes a task with a pending submission exists from prior setup or a fresh create+submit
    // flow; a real run should create its own fixture task here rather than depending on order.
    await page.click('text=Reject');
    await page.fill('textarea[id^="reject-reason"], input[id^="reject-reason"]', 'Please add more detail before this can be approved.');
    await page.click('[data-act="confirm-reject"], text=Confirm Reject');
    await expect(page.locator('text=Needs Revision, text=rejected')).toBeVisible();
  });

  test('block → dependency completes → unblock', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    // Create prerequisite task, then a dependent task pointing at it, and verify the "Blocked"
    // banner appears, then disappears once the prerequisite is closed.
    await expect(page.locator('text=Blocked')).toBeVisible();
  });

  test('complete → reopen → reason required → shows in Audit Log', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await page.click('text=Reopen — more work needed');
    // Reason is mandatory — confirm the button is disabled/blocked without one.
    await page.click('text=Confirm Reopen');
    await expect(page.locator('input[required]:invalid, .err')).toBeVisible();

    await page.fill('input[id^="reopen-reason"]', 'Missing site photos, needs redoing.');
    await page.click('text=Confirm Reopen');

    await page.click('text=Audit Log');
    await page.click('text=Task Reopened');
    await expect(page.locator('text=Missing site photos')).toBeVisible();
  });
});

test.describe('Responsive layout', () => {
  for (const [name, viewport] of Object.entries({
    mobile: { width: 390, height: 844 },
    tablet: { width: 820, height: 1180 },
    desktop: { width: 1440, height: 900 },
  })) {
    test(`navigation, task cards, and creation form render without horizontal overflow on ${name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await login(page, 'admin', 'admin123');
      const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(viewport.width + 1);
      await page.click('text=My Tasks');
      await page.click('text=New Task');
      await expect(page.locator('#new-task-title')).toBeVisible();
    });
  }
});
