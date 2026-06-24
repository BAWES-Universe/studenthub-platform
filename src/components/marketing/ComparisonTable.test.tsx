// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Check: () => <span data-testid="icon-check" />,
  X: () => <span data-testid="icon-x" />,
  Minus: () => <span data-testid="icon-minus" />,
  Sparkles: () => <span data-testid="icon-sparkles" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  Star: () => <span data-testid="icon-star" />,
  Users: () => <span data-testid="icon-users" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import ComparisonTable from "./ComparisonTable";

describe("ComparisonTable (visual redesign)", () => {
  it("renders section with comparison label", async () => {
    render(<ComparisonTable />);
    await waitFor(() => {
      expect(
        screen.getByLabelText("Feature comparison"),
      ).toBeInTheDocument();
    });
  });

  it("renders StudentHub score ring label", async () => {
    render(<ComparisonTable />);
    await waitFor(() => {
      const labels = screen.getAllByText("StudentHub");
      expect(labels.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders feature rows with data", async () => {
    render(<ComparisonTable />);
    await waitFor(() => {
      const features = screen.getAllByText("Unified profile visible to all employers");
      expect(features.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders category labels as pills", async () => {
    render(<ComparisonTable persona="candidate" />);
    await waitFor(() => {
      expect(screen.getAllByText("Profile").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Search").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Matching").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Payments").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Documents").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("applies custom className", async () => {
    const { container } = render(
      <ComparisonTable className="custom-class" />,
    );
    await waitFor(() => {
      const section = container.querySelector("[class*='custom-class']");
      expect(section).toBeTruthy();
    });
  });

  it("renders candidate-specific heading", async () => {
    render(<ComparisonTable persona="candidate" />);
    await waitFor(() => {
      expect(
        screen.getByText("Why students choose StudentHub."),
      ).toBeInTheDocument();
    });
  });

  it("renders company-specific heading", async () => {
    render(<ComparisonTable persona="company" />);
    await waitFor(() => {
      expect(
        screen.getByText("Why companies choose StudentHub."),
      ).toBeInTheDocument();
    });
  });

  it("renders company feature rows for company persona", async () => {
    render(<ComparisonTable persona="company" />);
    await waitFor(() => {
      const features = screen.getAllByText("Staff-matched candidates");
      expect(features.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders check icons for StudentHub features", async () => {
    const { container } = render(<ComparisonTable persona="candidate" />);
    await waitFor(() => {
      const dots = container.querySelectorAll('[class*="bg-green-500"]');
      expect(dots.length).toBeGreaterThan(0);
    });
  });

  it("renders comparison cards in a responsive grid on mobile", async () => {
    const { container } = render(<ComparisonTable persona="candidate" />);
    // Cards render as collapsible category sections — desktop uses a hidden md:grid,
    // mobile uses md:hidden grid. Check that category cards render with headers.
    await waitFor(() => {
      // Each category header is a button. Find by unique selector — the desktop and mobile
      // headers both render "PROFILE", so verify at least one exists.
      const categoryHeaders = screen.getAllByText("Profile", { exact: false });
      expect(categoryHeaders.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders feature count context note", async () => {
    render(<ComparisonTable persona="candidate" />);
    await waitFor(() => {
      const notes = screen.getAllByText(/features compared/i);
      expect(notes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
