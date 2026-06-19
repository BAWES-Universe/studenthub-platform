import { test, expect } from "@playwright/test";
import { getMockFixtures } from "../fixtures/mock";

const mockFixtures = getMockFixtures();

test.describe("Candidate search", () => {
  test.describe.configure({ mode: "serial" });

  let adminCookie: string;
  let staffCookie: string;

  test.beforeAll(async () => {
    adminCookie = mockFixtures.get("admin")!.cookie;
    staffCookie = mockFixtures.get("staff")!.cookie;
  });

  test("admin can access candidate search page", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "studenthub_next_session",
        value: adminCookie,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    await page.goto("/admin/candidates");
    await expect(page).toHaveURL("/admin/candidates");
    // Should render the candidate workspace
    await expect(
      page.getByRole("region", { name: "Open candidate tabs" }),
    ).toBeVisible({ timeout: 15000 });
    await context.close();
  });

  test("admin candidate search renders search input", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "studenthub_next_session",
        value: adminCookie,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    await page.goto("/admin/candidates");
    // Search should be present (Command menu or search input)
    await expect(
      page
        .locator(
          'input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]',
        )
        .or(page.locator("[cmdk-input]")),
    ).toBeVisible({ timeout: 15000 });
    await context.close();
  });

  test("admin can search candidates by query", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "studenthub_next_session",
        value: adminCookie,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    await page.goto("/admin/candidates?q=test");
    await expect(page).toHaveURL(/\/admin\/candidates\?q=test/);
    await expect(page.locator('text="Filtered view"')).toBeVisible({
      timeout: 15000,
    });
    await context.close();
  });

  test("staff can access candidate search page", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "studenthub_next_session",
        value: staffCookie,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    await page.goto("/staff/candidates");
    await expect(page).toHaveURL("/staff/candidates");
    await expect(page.locator('text="All production"')).toBeVisible({
      timeout: 15000,
    });
    await context.close();
  });

  test("staff can view assigned candidates", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "studenthub_next_session",
        value: staffCookie,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    await page.goto("/staff/candidates?view=assigned");
    await expect(page).toHaveURL(/\/staff\/candidates\?view=assigned/);
    await expect(page.locator('text="Assigned to me"')).toBeVisible({
      timeout: 15000,
    });
    await context.close();
  });

  test("staff cannot access admin candidates page (cross-role guard)", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "studenthub_next_session",
        value: staffCookie,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    await page.goto("/admin/candidates");
    // Should be redirected away from admin
    await expect(page).not.toHaveURL("/admin/candidates");
    await context.close();
  });

  test("unauthenticated users are redirected from candidate pages", async ({
    page,
  }) => {
    await page.goto("/admin/candidates");
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/staff/candidates");
    await expect(page).toHaveURL(/\/login/);
  });
});
