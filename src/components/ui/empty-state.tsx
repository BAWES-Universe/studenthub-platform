"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/* ------------------------------------------------------------------ */
/*  EmptyState — shadcn-based illustration + CTA per state             */
/*  Each variant has a unique inline SVG illustration designed for the  */
/*  StudentHub OS aesthetic — playful, purposeful, never apologetic.    */
/*  Inspired by Linear's empty states.                                  */
/* ------------------------------------------------------------------ */

export type EmptyStateVariant =
  | "search"      // No search results found
  | "empty"       // List/view has no items yet
  | "error"       // Something went wrong
  | "success"     // Action completed (e.g. form submitted)
  | "loading"     // Initial loading state (skeleton style)
  | "idle";       // Feature not yet started (default)

export interface EmptyStateProps {
  /** The state variant determines the illustration and tone */
  variant?: EmptyStateVariant;
  /** Primary heading (required) */
  title: string;
  /** Secondary description text */
  description?: string;
  /** Optional CTA button label */
  actionLabel?: string;
  /** Optional CTA click handler */
  onAction?: () => void;
  /** Optional CTA href (link instead of button) */
  actionHref?: string;
  /** Entrance delay for stagger (pass index * 80) */
  entranceDelay?: number;
  className?: string;
}

/* ── Illustration components ───────────────────────────────────── */

function SearchEmpty({ className }: { className?: string }) {
  return (
    <svg
      width="120"
      height="100"
      viewBox="0 0 120 100"
      fill="none"
      className={cn("size-[120px] shrink-0", className)}
      aria-hidden="true"
    >
      {/* Magnifying glass */}
      <circle cx="46" cy="40" r="22" className="stroke-muted-foreground/50" strokeWidth="2.5" />
      <line x1="62" y1="56" x2="80" y2="74" className="stroke-muted-foreground/50" strokeWidth="2.5" strokeLinecap="round" />
      {/* Dashed circle — searching motion */}
      <circle cx="46" cy="40" r="26" className="stroke-[var(--sh-info)]/40" strokeWidth="1.5" strokeDasharray="4 4" />
      {/* Small sparkle dots */}
      <circle cx="88" cy="28" r="3" className="fill-[var(--sh-info)]/30" />
      <circle cx="94" cy="44" r="2" className="fill-[var(--sh-warning)]/25" />
      <circle cx="78" cy="18" r="2" className="fill-[var(--sh-success)]/20" />
    </svg>
  );
}

function EmptyCanvas({ className }: { className?: string }) {
  return (
    <svg
      width="120"
      height="100"
      viewBox="0 0 120 100"
      fill="none"
      className={cn("size-[120px] shrink-0", className)}
      aria-hidden="true"
    >
      {/* Empty frame */}
      <rect x="15" y="18" width="90" height="64" rx="8" className="stroke-muted-foreground/30" strokeWidth="2" />
      {/* Plus icon in center */}
      <line x1="60" y1="36" x2="60" y2="64" className="stroke-muted-foreground/40" strokeWidth="2" strokeLinecap="round" />
      <line x1="46" y1="50" x2="74" y2="50" className="stroke-muted-foreground/40" strokeWidth="2" strokeLinecap="round" />
      {/* Sparkle */}
      <circle cx="85" cy="30" r="3" className="fill-[var(--sh-info)]/35" />
    </svg>
  );
}

function ErrorState({ className }: { className?: string }) {
  return (
    <svg
      width="120"
      height="100"
      viewBox="0 0 120 100"
      fill="none"
      className={cn("size-[120px] shrink-0", className)}
      aria-hidden="true"
    >
      {/* Alert circle */}
      <circle cx="60" cy="46" r="24" className="stroke-[var(--sh-error)]/50" strokeWidth="2.5" />
      {/* Exclamation */}
      <line x1="60" y1="36" x2="60" y2="50" className="stroke-[var(--sh-error)]/60" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="60" cy="58" r="2" className="fill-[var(--sh-error)]/60" />
      {/* Dotted rings */}
      <circle cx="60" cy="46" r="30" className="stroke-[var(--sh-error)]/20" strokeWidth="1" strokeDasharray="3 5" />
    </svg>
  );
}

function SuccessState({ className }: { className?: string }) {
  return (
    <svg
      width="120"
      height="100"
      viewBox="0 0 120 100"
      fill="none"
      className={cn("size-[120px] shrink-0", className)}
      aria-hidden="true"
    >
      {/* Check circle */}
      <circle cx="60" cy="46" r="24" className="stroke-[var(--sh-success)]/50" strokeWidth="2.5" />
      {/* Checkmark */}
      <path d="M50 46l7 7 14-14" className="stroke-[var(--sh-success)]/70" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Glow ring */}
      <circle cx="60" cy="46" r="28" className="stroke-[var(--sh-success)]/20" strokeWidth="1" />
      {/* Sparkles */}
      <circle cx="78" cy="30" r="2.5" className="fill-[var(--sh-success)]/30" />
      <circle cx="42" cy="66" r="2" className="fill-[var(--sh-success)]/20" />
    </svg>
  );
}

function LoadingState({ className }: { className?: string }) {
  return (
    <svg
      width="120"
      height="100"
      viewBox="0 0 120 100"
      fill="none"
      className={cn("size-[120px] shrink-0", className)}
      aria-hidden="true"
    >
      {/* Pulsing circle */}
      <circle cx="60" cy="46" r="22" className="stroke-[var(--sh-info)]/30" strokeWidth="2" />
      <circle cx="60" cy="46" r="16" className="stroke-[var(--sh-info)]/50" strokeWidth="2" strokeDasharray="6 6" />
      {/* Dashed orbital path */}
      <ellipse cx="60" cy="46" rx="34" ry="12" className="stroke-[var(--sh-info)]/15" strokeWidth="1" strokeDasharray="3 6" />
    </svg>
  );
}

function IdleState({ className }: { className?: string }) {
  return (
    <svg
      width="120"
      height="100"
      viewBox="0 0 120 100"
      fill="none"
      className={cn("size-[120px] shrink-0", className)}
      aria-hidden="true"
    >
      {/* Window frame */}
      <rect x="22" y="20" width="76" height="60" rx="8" className="stroke-muted-foreground/25" strokeWidth="2" />
      {/* Window title bar dots */}
      <circle cx="34" cy="32" r="3" className="fill-[var(--sh-error)]/20" />
      <circle cx="46" cy="32" r="3" className="fill-[var(--sh-warning)]/20" />
      <circle cx="58" cy="32" r="3" className="fill-[var(--sh-success)]/20" />
      {/* Content lines */}
      <line x1="34" y1="48" x2="80" y2="48" className="stroke-muted-foreground/15" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="34" y1="56" x2="70" y2="56" className="stroke-muted-foreground/12" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="34" y1="64" x2="62" y2="64" className="stroke-muted-foreground/10" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* ── Variant map ──────────────────────────────────────────────── */

const illustrationMap: Record<EmptyStateVariant, React.ComponentType<{ className?: string }>> = {
  search: SearchEmpty,
  empty: EmptyCanvas,
  error: ErrorState,
  success: SuccessState,
  loading: LoadingState,
  idle: IdleState,
};

/* ── Component ────────────────────────────────────────────────── */

function EmptyState({
  variant = "idle",
  title,
  description,
  actionLabel,
  onAction,
  actionHref,
  entranceDelay = 0,
  className,
}: EmptyStateProps) {
  const Illustration = illustrationMap[variant];
  const delay = Math.min(entranceDelay, 600);

  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-4 py-16 px-6 text-center",
        className,
      )}
      style={{ animationDelay: `${delay}ms` } as React.CSSProperties}
      role="status"
    >
      <div className="flex items-center justify-center">
        <Illustration />
      </div>
      <div className="max-w-md mx-auto">
        <h3 className="text-lg font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="text-sm text-muted-foreground leading-relaxed mt-1">{description}</p>
        )}
      </div>
      {actionLabel && (onAction || actionHref) && (
        <div className="mt-2">
          {actionHref ? (
            <Button asChild size="sm">
              <a href={actionHref}>{actionLabel}</a>
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export { EmptyState };
