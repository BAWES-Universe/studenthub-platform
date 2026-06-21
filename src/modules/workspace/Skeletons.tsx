"use client";

import { Skeleton } from "@/components/ui/skeleton";

/** Full-page skeleton matching the WorkspaceShell layout for route transitions. */
export function WorkspaceShellSkeleton({ rowCount = 8 }: { rowCount?: number }) {
  return (
    <main className="shell shellEmbedded">
      <section className="workspaceStage">
        {/* Topbar */}
        <section className="topbar">
          <div>
            <Skeleton className="h-3 w-24 mb-2" />
            <Skeleton className="h-7 w-64" />
          </div>
          <div className="accountBox">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
        </section>

        {/* Metrics */}
        <section className="metrics" aria-label="Loading metrics">
          {[1, 2, 3, 4].map((i) => (
            <article className="metric" key={i}>
              <Skeleton className="h-3 w-16 mb-2" />
              <Skeleton className="h-9 w-20 mb-1" />
              <Skeleton className="h-3 w-12" />
            </article>
          ))}
        </section>

        {/* Content area */}
        <div className="skeletonContent px-[22px] py-[18px] grid gap-3.5">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>

        {/* Data lists */}
        <section className="lists">
          {[1, 2].map((col) => (
            <section className="dataList" key={col}>
              <div className="listHeader">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-8 rounded-full" />
              </div>
              <div className="rows">
                {Array.from({ length: rowCount }).map((_, i) => (
                  <article className="row" key={i}>
                    <div className="rowMain">
                      <Skeleton className="h-4 w-48 mb-1" />
                      <Skeleton className="h-3 w-64" />
                    </div>
                    <div className="rowMeta">
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </section>
      </section>
    </main>
  );
}

/** Skeleton for data-table list pages. */
export function DataTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="skeletonTable px-[22px] py-[18px] grid gap-3">
      {/* Header */}
      <div className="flex justify-between items-center mb-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>

      {/* Filter/search bar */}
      <div className="flex gap-2.5 mb-1">
        <Skeleton className="h-9 flex-1 rounded-lg" />
        <Skeleton className="h-9 w-24 rounded-lg" />
      </div>

      {/* Rows */}
      <div className="grid gap-px">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_1fr_120px_100px] gap-3 px-[14px] py-[10px]">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-16" />
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_120px_100px] gap-3 px-[14px] py-3 border-t border-border"
          >
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Compact skeleton for detail pages with fact panels. */
export function DetailPageSkeleton({ panels = 3 }: { panels?: number }) {
  return (
    <div className="px-[22px] py-[18px] grid gap-3.5">
      {/* Action bar placeholder */}
      <Skeleton className="h-32 w-full rounded-lg" />

      {/* Hero section */}
      <Skeleton className="h-56 w-full rounded-lg" />

      {/* Fact panels */}
      <div className={`grid ${Math.min(panels, 2) === 2 ? 'grid-cols-2' : 'grid-cols-1'} gap-3`}>
        {Array.from({ length: panels }).map((_, i) => (
          <div key={i} className="grid gap-2 p-4 border border-border rounded-[10px]">
            <Skeleton className="h-4 w-24" />
            {[1, 2, 3, 4].map((r) => (
              <div key={r} className="flex justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-32" />
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Related lists */}
      <div className="grid grid-cols-2 gap-3">
        {[1, 2].map((col) => (
          <div key={col} className="grid gap-1 p-4 border border-border rounded-[10px]">
            <Skeleton className="h-4 w-32 mb-2" />
            {[1, 2, 3, 4].map((r) => (
              <Skeleton key={r} className="h-10 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Lightweight top-of-page pulse skeleton for Suspense fallbacks. */
export function QuickSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="px-[22px] py-[14px] grid gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={i === 0 ? "h-5 w-48" : "h-3 w-36"} />
      ))}
    </div>
  );
}
