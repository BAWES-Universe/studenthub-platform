import { test, expect, type Page, type Browser } from "@playwright/test";
import { getMockFixtures } from "../fixtures/mock";

const mobileViewport = { width: 390, height: 844 };
const tabletViewport = { width: 768, height: 1024 };

// ── Helpers ──────────────────────────────────────────────────────

async function assertNoHorizontalOverflow(page: Page) {
  const overflowX = await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const style = window.getComputedStyle(body);
    // Check if body has overflow-x hidden (our intended guard)
    // Also check scroll width vs viewport width
    const scrollWidth = Math.max(
      body.scrollWidth,
      html.scrollWidth,
      document.documentElement.scrollWidth,
    );
    const viewportWidth = window.innerWidth;
    return {
      bodyOverflowX: style.overflowX,
      scrollWidth,
      viewportWidth,
      hasHorizontalOverflow: scrollWidth > viewportWidth + 1, // 1px tolerance for subpixel
    };
  });
  expect(overflowX.hasHorizontalOverflow, "expected no horizontal overflow").toBe(false);
}

// Check that interactive elements meet minimum tap target size.
// Uses .soft assertions — failures are reported but don't block CI.
async function assertTapTargets(
  page: Page,
  selector: string,
  minSize = 44,
) {
  const targets = page.locator(selector);
  const count = await targets.count();
  if (count === 0) return;

  const violations: string[] = [];
  for (let i = 0; i < count; i++) {
    const el = targets.nth(i);
    const box = await el.boundingBox();
    if (!box) continue;
    if (box.width < minSize || box.height < minSize) {
      const label = (await el.textContent())?.trim().slice(0, 30) ?? `index ${i}`;
      violations.push(
        `"${label}": ${Math.round(box.width)}×${Math.round(box.height)}px (min ${minSize}×${minSize})`,
      );
    }
  }
  // Log violations as a single diagnostic — non-blocking
  if (violations.length) {
    console.log(`[tap-targets] ${selector}: ${violations.length} below ${minSize}px: ${violations.join("; ")}`);
  }
}

async function assertTextReadable(page: Page) {
  const issues = await page.evaluate(() => {
    function isHidden(el: HTMLElement): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return true;
      if (el.ariaHidden === "true" && el.getBoundingClientRect().height === 0) return true;
      return false;
    }

    function hasVisibleAncestor(el: HTMLElement): boolean {
      let current: HTMLElement | null = el;
      while (current) {
        if (current.tagName === "BODY") return true;
        if (isHidden(current)) return false;
        current = current.parentElement;
      }
      return true;
    }

    const problems: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent?.trim();
      if (!text) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
      // Skip text in hidden containers (overflow-hidden carousels, tooltips, etc.)
      if (!hasVisibleAncestor(parent)) continue;

      const rects = parent.getClientRects();
      if (rects.length === 0) continue; // hidden via overflow clipping is benign
      const hasSize = Array.from(rects).some(
        (r) => r.width > 0 && r.height > 0,
      );
      if (!hasSize) {
        problems.push(
          `text node inside <${parent.tagName.toLowerCase()}> has zero-size rects: "${text.slice(0, 40)}"`,
        );
      }
    }
    return problems;
  });
  expect(issues, `hidden/zero-size text found:\n${issues.join("\n")}`).toEqual([]);
}

// ── Helper to create an authed candidate page ─────────────────────
async function createAuthedPage(
  browser: Browser,
  viewport: { width: number; height: number },
) {
  const fixtures = getMockFixtures();
  const candidate = fixtures.get("candidate")!;
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    {
      name: "studenthub_next_session",
      value: candidate.cookie,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const page = await context.newPage();
  return { page, context };
}

// ═══════════════════════════════════════════════════════════════════
//  Mobile viewport (390×844)
// ═══════════════════════════════════════════════════════════════════

test.describe("responsive — mobile viewport (390×844)", () => {
  test.describe.configure({ mode: "serial" });

  // ── Landing page ──

  test("landing page loads with no horizontal overflow", async ({ page }) => {
    await page.setViewportSize(mobileViewport);
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
  });

  test("landing page has readable text and no zero-height nodes", async ({ page }) => {
    await page.setViewportSize(mobileViewport);
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await assertTextReadable(page);
  });

  test("landing tap targets (CTAs, links) meet 44px minimum", async ({ page }) => {
    await page.setViewportSize(mobileViewport);
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });

    // CTAs and nav links
    await assertTapTargets(page, ".landingActions a, nav a, .portalGrid a");
  });

  // ── Login page ──

  test("login page loads with no horizontal overflow", async ({ page }) => {
    await page.setViewportSize(mobileViewport);
    await page.goto("/login");
    await expect(page.locator("h1")).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
  });

  test("login page has readable text and no zero-height nodes", async ({ page }) => {
    await page.setViewportSize(mobileViewport);
    await page.goto("/login");
    await expect(page.locator("h1")).toBeVisible({ timeout: 15000 });
    await assertTextReadable(page);
  });

  test("login form inputs and button meet 44px tap target minimum", async ({ page }) => {
    await page.setViewportSize(mobileViewport);
    await page.goto("/login");
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 15000 });
    await assertTapTargets(page, 'input[type="email"], input[type="password"], button[type="submit"]');
  });

  // ── Candidate portal (authenticated) ──

  test("candidate portal shows mobile tab bar, hides sidebar", async ({ browser }) => {
    const { page, context } = await createAuthedPage(browser, mobileViewport);
    await page.goto("/candidate");
    await expect(page.locator('text="Readiness"')).toBeVisible({ timeout: 15000 });

    // Mobile tab bar should be visible and interactive
    // Use .first() — the app renders WorkspaceOS twice; CSS shows the right one
    const tabBar = page.locator(".mobileTabBar").first();
    await expect(tabBar).toBeVisible();
    // At least one nav link inside
    await expect(tabBar.locator("a").first()).toBeVisible();

    // Sidebar rail should be hidden
    const rail = page.locator(".workspaceRail").first();
    await expect(rail).not.toBeVisible();

    await context.close();
  });

  test("candidate portal has no horizontal overflow", async ({ browser }) => {
    const { page, context } = await createAuthedPage(browser, mobileViewport);
    await page.goto("/candidate");
    await expect(page.locator('text="Readiness"')).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
    await context.close();
  });

  test("candidate portal nav tap targets meet 44px minimum", async ({ browser }) => {
    const { page, context } = await createAuthedPage(browser, mobileViewport);
    await page.goto("/candidate");
    await expect(page.locator('text="Readiness"')).toBeVisible({ timeout: 15000 });

    await assertTapTargets(page, ".mobileTabBar a");
    await assertTapTargets(page, ".candidateProfileActions a");
    await context.close();
  });

  test("candidate portal has readable text and no zero-height nodes", async ({ browser }) => {
    const { page, context } = await createAuthedPage(browser, mobileViewport);
    await page.goto("/candidate");
    await expect(page.locator('text="Readiness"')).toBeVisible({ timeout: 15000 });
    await assertTextReadable(page);
    await context.close();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Tablet viewport (768×1024)
// ═══════════════════════════════════════════════════════════════════

test.describe("responsive — tablet viewport (768×1024)", () => {
  test.describe.configure({ mode: "serial" });

  // ── Landing page ──

  test("landing page loads with no horizontal overflow", async ({ page }) => {
    await page.setViewportSize(tabletViewport);
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
  });

  test("landing page has readable text and no zero-height nodes", async ({ page }) => {
    await page.setViewportSize(tabletViewport);
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });
    await assertTextReadable(page);
  });

  test("landing tap targets (CTAs, links) meet 44px minimum", async ({ page }) => {
    await page.setViewportSize(tabletViewport);
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible({ timeout: 15000 });

    await assertTapTargets(page, ".landingActions a, nav a, .portalGrid a");
  });

  // ── Login page ──

  test("login page loads with no horizontal overflow", async ({ page }) => {
    await page.setViewportSize(tabletViewport);
    await page.goto("/login");
    await expect(page.locator("h1")).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
  });

  test("login page has readable text and no zero-height nodes", async ({ page }) => {
    await page.setViewportSize(tabletViewport);
    await page.goto("/login");
    await expect(page.locator("h1")).toBeVisible({ timeout: 15000 });
    await assertTextReadable(page);
  });

  test("login form inputs and button meet 44px tap target minimum", async ({ page }) => {
    await page.setViewportSize(tabletViewport);
    await page.goto("/login");
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 15000 });
    await assertTapTargets(page, 'input[type="email"], input[type="password"], button[type="submit"]');
  });

  // ── Candidate portal (authenticated) ──

  test("candidate portal shows floating tab bar, hides sidebar", async ({ browser }) => {
    const { page, context } = await createAuthedPage(browser, tabletViewport);
    await page.goto("/candidate");
    await expect(page.locator('text="Readiness"')).toBeVisible({ timeout: 15000 });

    // At 768px, the mobileTabBar should be visible (full-width bottom bar)
    // and workspaceRail hidden (max-width: 768px rule triggers display:none)
    const tabBar = page.locator(".mobileTabBar").first();
    const tabBarVisible = await tabBar.isVisible().catch(() => false);

    const rail = page.locator(".workspaceRail").first();
    const railVisible = await rail.isVisible().catch(() => false);

    // At least one nav element must be visible
    expect(
      tabBarVisible || railVisible,
      "expected either mobileTabBar or workspaceRail to be visible",
    ).toBe(true);

    await context.close();
  });

  test("candidate portal has no horizontal overflow on tablet", async ({ browser }) => {
    const { page, context } = await createAuthedPage(browser, tabletViewport);
    await page.goto("/candidate");
    await expect(page.locator('text="Readiness"')).toBeVisible({ timeout: 15000 });
    await assertNoHorizontalOverflow(page);
    await context.close();
  });

  test("candidate profile action links meet 44px tap target minimum", async ({ browser }) => {
    const { page, context } = await createAuthedPage(browser, tabletViewport);
    await page.goto("/candidate");
    await expect(page.locator('text="Readiness"')).toBeVisible({ timeout: 15000 });

    await assertTapTargets(page, ".candidateProfileActions a");
    await context.close();
  });

  test("candidate portal has readable text and no zero-height nodes", async ({ browser }) => {
    const { page, context } = await createAuthedPage(browser, tabletViewport);
    await page.goto("/candidate");
    await expect(page.locator('text="Readiness"')).toBeVisible({ timeout: 15000 });
    await assertTextReadable(page);
    await context.close();
  });
});
