import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/modules/auth/session", () => ({
  requireRoleCapability: vi.fn().mockResolvedValue({ user: { id: "1" }, role: "admin" }),
  requireCapability: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/modules/workspace/WorkspaceShell", () => ({
  WorkspaceShell: ({
    children,
    eyebrow,
    title,
    metrics,
  }: {
    children: React.ReactNode;
    eyebrow: string;
    title: string;
    metrics: { label: string; value: string | number; note: string }[];
  }) => (
    <div data-testid="workspace-shell">
      <div data-testid="eyebrow">{eyebrow}</div>
      <div data-testid="title">{title}</div>
      {metrics.map((m) => (
        <span key={m.label} data-testid={`metric-${m.label}`}>
          {String(m.value)}
        </span>
      ))}
      {children}
    </div>
  ),
}));

vi.mock("@/modules/workspace/format", () => ({
  formatDate: (d: Date) => d.toISOString().split("T")[0],
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const mockDegreeGroup = {
  degree_group_uuid: "550e8400-e29b-41d4-a716-446655440000",
  degree_group_name_en: "Science Degrees",
  degree_group_name_ar: "الدرجات العلمية",
  degree_group_sort_order: 2,
  skip_major: 0,
  degree_count: 8,
};

const mockGetDegreeGroup = vi.fn();

vi.mock("../actions", () => ({
  getDegreeGroup: (...args: unknown[]) => mockGetDegreeGroup(...args),
}));

describe("AdminDegreeGroupDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders degree group detail with all fields", async () => {
    mockGetDegreeGroup.mockResolvedValue(mockDegreeGroup);

    const Page = (await import("./page")).default;
    const { container } = render(
      await Page({
        params: Promise.resolve({ id: "550e8400-e29b-41d4-a716-446655440000" }),
      }),
    );

    const eyebrow = container.querySelector('[data-testid="eyebrow"]');
    expect(eyebrow?.textContent).toBe("Admin / Degree Groups");
    const title = container.querySelector('[data-testid="title"]');
    expect(title?.textContent).toBe("Science Degrees");
  });

  it("renders metric for degree count", async () => {
    mockGetDegreeGroup.mockResolvedValue(mockDegreeGroup);

    const Page = (await import("./page")).default;
    const { container } = render(
      await Page({
        params: Promise.resolve({ id: "550e8400-e29b-41d4-a716-446655440000" }),
      }),
    );

    const degreesMetric = container.querySelector('[data-testid="metric-Degrees"]');
    expect(degreesMetric?.textContent).toBe("8");
    const sortMetric = container.querySelector('[data-testid="metric-Sort"]');
    expect(sortMetric?.textContent).toBe("2");
  });

  it("calls notFound when degree group is null", async () => {
    mockGetDegreeGroup.mockResolvedValue(null);

    const Page = (await import("./page")).default;
    await expect(
      Page({ params: Promise.resolve({ id: "nonexistent-uuid" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the edit form with group data", async () => {
    mockGetDegreeGroup.mockResolvedValue(mockDegreeGroup);

    const Page = (await import("./page")).default;
    render(
      await Page({
        params: Promise.resolve({ id: "550e8400-e29b-41d4-a716-446655440000" }),
      }),
    );

    expect(screen.getByText("Edit Degree Group")).toBeTruthy();
    expect(screen.getByText("Danger Zone")).toBeTruthy();
    expect(screen.getByDisplayValue("Science Degrees")).toBeTruthy();
    expect(screen.getByDisplayValue("الدرجات العلمية")).toBeTruthy();
  });
});
