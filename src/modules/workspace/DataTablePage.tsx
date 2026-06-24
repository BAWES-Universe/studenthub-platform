"use client";

import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import type { Route } from "next";
import { DataTable, type DataTableColumn } from "./DataTable";
import { DataTableSkeleton } from "./Skeletons";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";

const EMPTY_NO_RECORDS = "No records found";
const EMPTY_HINT_DEFAULT = "There are no records to display yet.";

// ── Types ──────────────────────────────────────────────────

export type {
  DataTableColumn,
};

export type DataTablePageProps<T extends { id: string | number }> = {
  /** Page title shown in the header. */
  title: string;
  /** Page description / subtitle. */
  description: string;
  /** Column definitions for the data table. */
  columns: DataTableColumn<T>[];
  /** Row data. */
  rows: T[];
  /** URL function for clickable rows — passed directly to DataTable. */
  rowHref?: (row: T) => Route;
  /** Loading state — shows skeleton when true. */
  loading?: boolean;
  /** Error message — shows error state when set. */
  error?: string | null;
  /** Whether to show the search/filter bar. */
  searchable?: boolean;
  /** Placeholder text for the search input. */
  searchPlaceholder?: string;
  /** Current search value (controlled). */
  searchValue?: string;
  /** Search change handler (controlled). */
  onSearchChange?: (value: string) => void;
  /** Total number of pages for pagination. */
  totalPages?: number;
  /** Current page number (1-indexed). */
  page?: number;
  /** Page change handler. */
  onPageChange?: (page: number) => void;
  /** Action buttons rendered in the header (e.g. "Create" button). */
  actions?: ReactNode;
  /** Optional className override. */
  className?: string;
};

// ── Default filter function ─────────────────────────────────

function defaultFilter<T>(rows: T[], query: string): T[] {
  if (!query.trim()) return rows;
  const q = query.toLowerCase();
  return rows.filter((row) =>
    Object.values(row as Record<string, unknown>)
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .some((v) => String(v).toLowerCase().includes(q))
  );
}

// ── Component ──────────────────────────────────────────────

export function DataTablePage<T extends { id: string | number }>({
  title,
  description,
  columns,
  rows,
  rowHref,
  loading = false,
  error = null,
  searchable = false,
  searchPlaceholder = "Search...",
  searchValue: externalSearchValue,
  onSearchChange: externalOnSearchChange,
  totalPages,
  page = 1,
  onPageChange,
  actions,
  className,
}: DataTablePageProps<T>) {
  // Internal search state when uncontrolled
  const [internalSearch, setInternalSearch] = useState("");
  const isControlled = externalSearchValue !== undefined;
  const searchValue = isControlled ? externalSearchValue : internalSearch;
  const setSearchValue = isControlled
    ? (externalOnSearchChange ?? (() => {}))
    : setInternalSearch;

  // Filter rows by search
  const filtered = useMemo(
    () => defaultFilter(rows, searchValue),
    [rows, searchValue]
  );

  // ── Loading state ────────────────────────────────────────
  if (loading) {
    return (
      <div className={className}>
        <DataTableSkeleton rows={10} />
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────
  if (error) {
    return (
      <section className={className}>
        <div className="rounded-xl bg-card border border-border shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-4 p-4 border-b border-border sticky top-0 z-[5] bg-card">
            <div>
              <h2 className="text-[15px] font-bold tracking-tight mb-0.5">{title}</h2>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
            <div className="size-12 rounded-xl bg-red-500/10 flex items-center justify-center">
              <X size={24} className="text-red-400" />
            </div>
            <strong className="text-sm text-foreground">
              Error loading data
            </strong>
            <span className="text-sm text-muted-foreground">
              {error}
            </span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={className}>
      <div className="rounded-xl bg-card border border-border shadow-sm overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 p-4 border-b border-border sticky top-0 z-[5] bg-card">
          <div>
            <h2 className="text-[15px] font-bold tracking-tight mb-0.5">{title}</h2>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>

        {/* Search bar */}
        {searchable ? (
          <div className="px-5 py-3 border-b border-border">
            <div className="relative flex items-center">
              <Search size={15} className="absolute left-3 text-muted-foreground pointer-events-none" aria-hidden="true" />
              <Input
                data-command-search
                type="text"
                placeholder={searchPlaceholder}
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                className="w-full h-9 pl-9 pr-9 text-sm"
              />
              {searchValue ? (
                <button
                  type="button"
                  className="absolute right-1.5 inline-flex items-center justify-center size-6 rounded-md border-0 bg-transparent text-muted-foreground cursor-pointer hover:bg-muted hover:text-foreground transition-colors"
                  onClick={() => setSearchValue("")}
                  aria-label="Clear search"
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Table or filtered empty state */}
        {filtered.length > 0 ? (
          <DataTable
            title={title}
            description={description}
            rows={filtered}
            columns={columns}
            rowHref={rowHref}
          />
        ) : (
          <div className="py-14 px-6">
            <EmptyState
              variant={searchValue ? "search" : "empty"}
              title={searchValue ? `No results for "${searchValue}"` : EMPTY_NO_RECORDS}
              description={searchValue ? "Try a different search term or clear your filter." : EMPTY_HINT_DEFAULT}
            />
          </div>
        )}
      </div>
    </section>
  );
}
