"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PageHeaderBreadcrumb = {
  /** Display label (e.g. "Requests") */
  label: string;
  /** Optional href — renders as a link; plain span when omitted */
  href?: string;
};

export interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Page title (required) */
  title: string;
  /** Optional breadcrumb trail (e.g. [{label:"Requests", href:"/requests"}, {label:"Detail"}]) */
  breadcrumbs?: PageHeaderBreadcrumb[];
  /** Optional description / subtitle rendered below the title */
  description?: string;
  /** Optional primary action element (button or link) */
  action?: React.ReactNode;
  /** Optional back navigation href for detail pages — renders a chevron-left icon link */
  backHref?: string;
  /** Entrance animation delay in ms (default: 0, max: 400) */
  entranceDelay?: number;
  /** Remove extra bottom margin (for nested or custom-spaced layouts) */
  noSpacing?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PageHeader = React.forwardRef<HTMLDivElement, PageHeaderProps>(
  function PageHeader(
    {
      className,
      title,
      breadcrumbs,
      description,
      action,
      backHref,
      entranceDelay = 0,
      noSpacing = false,
      ...props
    },
    ref,
  ) {
    const delay = Math.min(entranceDelay, 400);

    return (
      <div
        ref={ref}
        data-slot="page-header"
        className={cn(
          "mb-6",
          noSpacing && "mb-0",
          className,
        )}
        style={{ animationDelay: `${delay}ms` }}
        {...props}
      >
        {/* ── Breadcrumbs ───────────────────────────────────────────── */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-3" aria-label="Breadcrumbs">
            <ol className="flex items-center gap-1">
              {breadcrumbs.map((crumb, i) => {
                const isLast = i === breadcrumbs.length - 1;
                return (
                  <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                    {isLast ? (
                      <span aria-current="page" className="text-foreground font-medium">
                        {crumb.label}
                      </span>
                    ) : crumb.href ? (
                      <Link href={crumb.href as any} className="text-muted-foreground hover:text-foreground transition-colors">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{crumb.label}</span>
                    )}
                    {!isLast && (
                      <ChevronRight
                        className="text-muted-foreground/50"
                        aria-hidden="true"
                        size={14}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        {/* ── Title row ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {backHref && (
              <Link
                href={backHref as any}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft size={18} aria-hidden="true" />
              </Link>
            )}
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
          </div>
          {action && (
            <div className="flex items-center gap-2 shrink-0">
              {action}
            </div>
          )}
        </div>

        {/* ── Description ───────────────────────────────────────────── */}
        {description && (
          <p className="text-sm text-muted-foreground mt-1.5 max-w-prose">{description}</p>
        )}
      </div>
    );
  },
);

export { PageHeader };
