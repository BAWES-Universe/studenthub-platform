// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
  cleanup();
  mockPath("/admin");
});

// ---------------------------------------------------------------------------
// Tests — WorkspaceNavigation
// ---------------------------------------------------------------------------

describe("WorkspaceNavigation", () => {
  it("renders all nav items as links", () => {
    render(<WorkspaceNavigation items={navItems} role="admin" />);

    navItems.forEach((item) => {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    });
  });

  it("renders each item as a link with the correct href", () => {
    render(<WorkspaceNavigation items={navItems} role="admin" />);

    const overviewLink = screen.getByText("Overview").closest("a");
    expect(overviewLink).toHaveAttribute("href", "/admin");

    const candidatesLink = screen.getByText("Candidates").closest("a");
    expect(candidatesLink).toHaveAttribute("href", "/admin/candidates");
  });

  it("renders the nav with the correct aria-label", () => {
    render(<WorkspaceNavigation items={navItems} role="admin" />);

    const nav = screen.getByRole("navigation");
    expect(nav).toHaveAttribute("aria-label", "admin workspace navigation");
  });

  it("applies the role to the aria-label", () => {
    render(<WorkspaceNavigation items={navItems} role="staff" />);

    const nav = screen.getByRole("navigation");
    expect(nav).toHaveAttribute("aria-label", "staff workspace navigation");
  });

  it("marks the active item with aria-current='page' when pathname matches exactly", () => {
    mockPath("/admin/candidates");
    render(<WorkspaceNavigation items={navItems} role="admin" />);

    const candidatesLink = screen.getByText("Candidates").closest("a");
    expect(candidatesLink).toHaveAttribute("aria-current", "page");

    // Companies should not be active because pathname doesn't match
    const companiesLink = screen.getByText("Companies").closest("a");
    expect(companiesLink).not.toHaveAttribute("aria-current");
  });

  it("marks the active item when pathname is a sub-route of the item's href", () => {
    mockPath("/admin/candidates/123");
    render(<WorkspaceNavigation items={navItems} role="admin" />);

    const candidatesLink = screen.getByText("Candidates").closest("a");
    expect(candidatesLink).toHaveAttribute("aria-current", "page");
  });

  it("does not mark any item as active when pathname matches no items", () => {
    mockPath("/some/unknown/path");
    render(<WorkspaceNavigation items={navItems} role="admin" />);

    const links = screen.getAllByRole("link");
    links.forEach((link) => {
      expect(link).not.toHaveAttribute("aria-current");
    });
  });

  it("applies the correct active classes to the active item", () => {
    mockPath("/admin/candidates");
    render(<WorkspaceNavigation items={navItems} role="admin" />);

    const candidatesLink = screen.getByText("Candidates").closest("a");
    // Active link gets aria-current="page" and the Zendesk blue bg/text classes
    expect(candidatesLink).toHaveAttribute("aria-current", "page");
    expect(candidatesLink).toHaveClass("text-[#1f73b7]");

    // Inactive items should not have aria-current
    const companiesLink = screen.getByText("Companies").closest("a");
    expect(companiesLink).not.toHaveAttribute("aria-current");
  });

  it("renders a title attribute on each link", () => {
    render(<WorkspaceNavigation items={navItems} role="admin" />);

    navItems.forEach((item) => {
      const link = screen.getByText(item.label).closest("a");
      expect(link).toHaveAttribute("title", item.label);
    });
  });

  it("renders nothing when items array is empty", () => {
    const { container } = render(<WorkspaceNavigation items={[]} role="admin" />);

    const nav = container.querySelector("nav");
    expect(nav).toBeInTheDocument();
    expect(nav?.children.length).toBe(0);
  });

  it("handles a single nav item", () => {
    render(<WorkspaceNavigation items={singleNav} role="admin" />);

    expect(screen.getByText("Home")).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — WorkspaceMobileNavigation
// ---------------------------------------------------------------------------

describe("WorkspaceMobileNavigation", () => {
  it("renders all nav items as links", () => {
    render(<WorkspaceMobileNavigation items={navItems} role="admin" />);

    navItems.forEach((item) => {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    });
  });

  it("renders with the correct aria-label", () => {
    render(<WorkspaceMobileNavigation items={navItems} role="admin" />);

    const nav = screen.getByRole("navigation");
    expect(nav).toHaveAttribute("aria-label", "admin mobile navigation");
  });

  it("marks the active item with aria-current='page'", () => {
    mockPath("/admin/companies");
    render(<WorkspaceMobileNavigation items={navItems} role="admin" />);

    const companiesLink = screen.getByText("Companies").closest("a");
    expect(companiesLink).toHaveAttribute("aria-current", "page");
  });

  it("marks the active item on sub-route matches", () => {
    mockPath("/admin/requests/new");
    render(<WorkspaceMobileNavigation items={navItems} role="admin" />);

    const requestsLink = screen.getByText("Requests").closest("a");
    expect(requestsLink).toHaveAttribute("aria-current", "page");
  });

  it("renders nothing when items array is empty", () => {
    const { container } = render(<WorkspaceMobileNavigation items={[]} role="admin" />);

    const nav = container.querySelector("nav");
    expect(nav).toBeInTheDocument();
    expect(nav?.children.length).toBe(0);
  });
});
