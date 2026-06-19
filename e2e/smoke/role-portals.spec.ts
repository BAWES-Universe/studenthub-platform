import { test, expect } from "@playwright/test";
import { getMockFixtures } from "../fixtures/mock";

const fixtures = getMockFixtures();

type RoleFixture = { role: string; id: string; name: string; email: string; cookie: string };

function cookieArgs(user: RoleFixture) {
  return [
    { name: "studenthub_next_session", value: user.cookie, domain: "127.0.0.1", path: "/" },
  ];
}

const ROLES: Array<{ key: string; label: string; expectedUrl?: string; expectedText?: string }> = [
  { key: "admin", label: "admin", expectedUrl: "/admin" },
  { key: "staff", label: "staff", expectedUrl: "/staff", expectedText: "Staff operating home" },
  { key: "candidate", label: "candidate", expectedUrl: "/candidate", expectedText: "Readiness" },
  { key: "company", label: "company", expectedUrl: "/company" },
  { key: "inspector", label: "inspector", expectedUrl: "/inspector" },
];

test.describe("Role portal smoke tests", () => {
  // ── Each role's portal loads ──
  for (const { key, label, expectedUrl, expectedText } of ROLES) {
    test(`${label} portal loads`, async ({ browser }) => {
      const user = fixtures.get(key)!;
      const context = await browser.newContext();
      await context.addCookies(cookieArgs(user));
      const page = await context.newPage();
      await page.goto(`/${expectedUrl}`);
      await expect(page).toHaveURL(`/${expectedUrl}`);
      await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
      if (expectedText) {
        await expect(page.locator(`text="${expectedText}"`)).toBeVisible({ timeout: 15000 });
      }
      await context.close();
    });
  }

  // ── Admin sub-routes ──
  const adminRoutes = ["/admin/candidates", "/admin/companies", "/admin/transfers"];
  for (const route of adminRoutes) {
    test(`admin can access ${route}`, async ({ browser }) => {
      const admin = fixtures.get("admin")!;
      const context = await browser.newContext();
      await context.addCookies(cookieArgs(admin));
      const page = await context.newPage();
      await page.goto(route);
      await expect(page).toHaveURL(route);
      await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
      await context.close();
    });
  }

  // ── Staff sub-routes ──
  test("staff can access requests list", async ({ browser }) => {
    const staff = fixtures.get("staff")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(staff));
    const page = await context.newPage();
    await page.goto("/staff/requests");
    await expect(page).toHaveURL("/staff/requests");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await context.close();
  });

  // ── Candidate sub-routes ──
  const candidateRoutes = ["/candidate/invitations", "/candidate/work-logs"];
  for (const route of candidateRoutes) {
    test(`candidate can access ${route}`, async ({ browser }) => {
      const candidate = fixtures.get("candidate")!;
      const context = await browser.newContext();
      await context.addCookies(cookieArgs(candidate));
      const page = await context.newPage();
      await page.goto(route);
      await expect(page).toHaveURL(route);
      await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
      await context.close();
    });
  }

  // ── Company sub-routes ──
  test("company can access linked companies", async ({ browser }) => {
    const company = fixtures.get("company")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(company));
    const page = await context.newPage();
    await page.goto("/company/companies");
    await expect(page).toHaveURL("/company/companies");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await context.close();
  });

  // ── Inspector sub-routes ──
  test("inspector can access ID requests", async ({ browser }) => {
    const inspector = fixtures.get("inspector")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(inspector));
    const page = await context.newPage();
    await page.goto("/inspector/id-requests");
    await expect(page).toHaveURL("/inspector/id-requests");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await context.close();
  });

  // ── Cross-role guards ──
  test("admin cannot access staff portal", async ({ browser }) => {
    const admin = fixtures.get("admin")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(admin));
    const page = await context.newPage();
    await page.goto("/staff");
    await expect(page).not.toHaveURL("/staff");
    await context.close();
  });

  test("staff cannot access admin portal", async ({ browser }) => {
    const staff = fixtures.get("staff")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(staff));
    const page = await context.newPage();
    await page.goto("/admin");
    await expect(page).not.toHaveURL("/admin");
    await context.close();
  });

  test("company cannot access candidate portal", async ({ browser }) => {
    const company = fixtures.get("company")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(company));
    const page = await context.newPage();
    await page.goto("/candidate");
    await expect(page).not.toHaveURL("/candidate");
    await context.close();
  });

  test("candidate cannot access admin portal", async ({ browser }) => {
    const candidate = fixtures.get("candidate")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(candidate));
    const page = await context.newPage();
    await page.goto("/admin");
    await expect(page).not.toHaveURL("/admin");
    await context.close();
  });

  // ── App shell ──
  test("authenticated user can access /app shell", async ({ browser }) => {
    const admin = fixtures.get("admin")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(admin));
    const page = await context.newPage();
    await page.goto("/app");
    await expect(page).toHaveURL("/app");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await context.close();
  });

  test("authenticated user can access /hub shell", async ({ browser }) => {
    const admin = fixtures.get("admin")!;
    const context = await browser.newContext();
    await context.addCookies(cookieArgs(admin));
    const page = await context.newPage();
    await page.goto("/hub");
    await expect(page).toHaveURL("/hub");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await context.close();
  });
});
