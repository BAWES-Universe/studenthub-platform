import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import ReactDOM from "react-dom/client";
import { WorkspaceNavigation, WorkspaceMobileNavigation } from "./WorkspaceNavigation";
import type { NavItem } from "./navigation";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockPathname = "/admin";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function mockPath(value: string) {
  mockPathname = value;
}

// Self-contained render — no @testing-library/react dependency
function renderInDoc(ui: React.ReactElement): { container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  root.render(ui);
  return { container };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const navItems: NavItem[] = [
  { label: "Overview", href: "/admin" as NavItem["href"], icon: (() => null) as any },
  { label: "Candidates", href: "/admin/candidates" as NavItem["href"], icon: (() => null) as any },
  { label: "Companies", href: "/admin/companies" as NavItem["href"], icon: (() => null) as any },
  { label: "Requests", href: "/admin/requests" as NavItem["href"], icon: (() => null) as any },
];

const singleNav: NavItem[] = [
  { label: "Home", href: "/admin" as NavItem["href"], icon: (() => null) as any },
];

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  document.body.innerHTML = "";
  mockPath("/admin");
});

// ---------------------------------------------------------------------------
// Tests — WorkspaceNavigation
// ---------------------------------------------------------------------------

describe("WorkspaceNavigation", () => {
  it("renders all nav items as links", () => {
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="admin" />);
    navItems.forEach((item) => {
      expect(container.querySelector(`[title="${item.label}"]`)).not.toBeNull();
    });
  });

  it("renders each item as a link with the correct href", () => {
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="admin" />);
    const links = container.querySelectorAll("a");
    const hrefs: (string | null)[] = [];
    links.forEach((l) => hrefs.push(l.getAttribute("href")));
    navItems.forEach((item) => {
      expect(hrefs).toContain(item.href);
    });
  });

  it("renders the nav with the correct aria-label", () => {
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="admin" />);
    const nav = container.querySelector("nav[aria-label='admin workspace navigation']");
    expect(nav).not.toBeNull();
  });

  it("applies the role to the aria-label", () => {
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="staff" />);
    const nav = container.querySelector("nav[aria-label='staff workspace navigation']");
    expect(nav).not.toBeNull();
  });

  it("marks the active item with aria-current='page' when pathname matches exactly", () => {
    mockPath("/admin/candidates");
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="admin" />);
    const candidatesLink = container.querySelector('a[href="/admin/candidates"]');
    expect(candidatesLink?.getAttribute("aria-current")).toBe("page");
    const companiesLink = container.querySelector('a[href="/admin/companies"]');
    expect(companiesLink?.hasAttribute("aria-current")).toBe(false);
  });

  it("marks the active item when pathname is a sub-route of the item's href", () => {
    mockPath("/admin/candidates/123");
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="admin" />);
    const candidatesLink = container.querySelector('a[href="/admin/candidates"]');
    expect(candidatesLink?.getAttribute("aria-current")).toBe("page");
  });

  it("does not mark any item as active when pathname matches no items", () => {
    mockPath("/some/unknown/path");
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="admin" />);
    const links = container.querySelectorAll("a");
    links.forEach((link) => {
      expect(link.hasAttribute("aria-current")).toBe(false);
    });
  });

  it("applies the CSS class 'active' to the active item", () => {
    mockPath("/admin/candidates");
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="admin" />);
    const candidatesLink = container.querySelector('a[href="/admin/candidates"]');
    expect(candidatesLink?.classList.contains("active")).toBe(true);
  });

  it("renders a title attribute on each link", () => {
    const { container } = renderInDoc(<WorkspaceNavigation items={navItems} role="admin" />);
    navItems.forEach((item) => {
      const link = container.querySelector(`a[title="${item.label}"]`);
      expect(link).not.toBeNull();
      expect(link?.getAttribute("title")).toBe(item.label);
    });
  });

  it("renders nothing when items array is empty", () => {
    const { container } = renderInDoc(<WorkspaceNavigation items={[]} role="admin" />);
    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    expect(nav?.children.length).toBe(0);
  });

  it("handles a single nav item", () => {
    const { container } = renderInDoc(<WorkspaceNavigation items={singleNav} role="admin" />);
    expect(container.querySelector('[title="Home"]')).not.toBeNull();
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — WorkspaceMobileNavigation
// ---------------------------------------------------------------------------

describe("WorkspaceMobileNavigation", () => {
  it("renders all nav items as links", () => {
    const { container } = renderInDoc(<WorkspaceMobileNavigation items={navItems} role="admin" />);
    navItems.forEach((item) => {
      expect(container.querySelector(`[title="${item.label}"]`)).not.toBeNull();
    });
  });

  it("renders with the correct aria-label", () => {
    const { container } = renderInDoc(<WorkspaceMobileNavigation items={navItems} role="admin" />);
    const nav = container.querySelector("nav[aria-label='admin mobile navigation']");
    expect(nav).not.toBeNull();
  });

  it("marks the active item with aria-current='page'", () => {
    mockPath("/admin/companies");
    const { container } = renderInDoc(<WorkspaceMobileNavigation items={navItems} role="admin" />);
    const companiesLink = container.querySelector('a[href="/admin/companies"]');
    expect(companiesLink?.getAttribute("aria-current")).toBe("page");
  });

  it("marks the active item on sub-route matches", () => {
    mockPath("/admin/requests/new");
    const { container } = renderInDoc(<WorkspaceMobileNavigation items={navItems} role="admin" />);
    const requestsLink = container.querySelector('a[href="/admin/requests"]');
    expect(requestsLink?.getAttribute("aria-current")).toBe("page");
  });

  it("renders nothing when items array is empty", () => {
    const { container } = renderInDoc(<WorkspaceMobileNavigation items={[]} role="admin" />);
    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    expect(nav?.children.length).toBe(0);
  });
});
