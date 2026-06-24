"use client";

import type { ReactNode, MouseEventHandler } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Illustration variants — each is a hand-crafted SVG illustration with
// personality, inspired by Linear's playful empty states
// ---------------------------------------------------------------------------

function IllustrationNoData({ className }: { className?: string }) {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className={cn("shEmptyIllustration", className)} aria-hidden="true">
      {/* Folder body */}
      <path d="M10 20h18l4-4h22a3 3 0 013 3v26a3 3 0 01-3 3H10a3 3 0 01-3-3V23a3 3 0 013-3z"
        fill="currentColor" opacity="0.08" />
      <path d="M10 20h18l4-4h22a3 3 0 013 3v26a3 3 0 01-3 3H10a3 3 0 01-3-3V23a3 3 0 013-3z"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.25" />
      {/* Magnifying glass */}
      <g className="shEmptyIllustAnimateSearch">
        <circle cx="38" cy="36" r="8" stroke="var(--sh-info)" strokeWidth="1.5" fill="none" opacity="0.6" />
        <line x1="44" y1="42" x2="50" y2="48" stroke="var(--sh-info)" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
      </g>
      {/* Question mark dot */}
      <circle cx="22" cy="35" r="2" fill="currentColor" opacity="0.3" />
      <circle cx="22" cy="42" r="1.5" fill="currentColor" opacity="0.2" />
    </svg>
  );
}

function IllustrationEmpty({ className }: { className?: string }) {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className={cn("shEmptyIllustration", className)} aria-hidden="true">
      {/* Clipboard */}
      <rect x="16" y="12" width="32" height="42" rx="4" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.06" />
      <rect x="24" y="8" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.06" />
      {/* Checklist items */}
      <line x1="22" y1="25" x2="42" y2="25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.15" />
      <line x1="22" y1="32" x2="38" y2="32" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.15" />
      <line x1="22" y1="39" x2="34" y2="39" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.15" />
      {/* Pen icon */}
      <g opacity="0.5" className="shEmptyIllustAnimatePen">
        <line x1="44" y1="46" x2="50" y2="40" stroke="var(--sh-info)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="44" y1="46" x2="42" y2="48" stroke="var(--sh-info)" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function IllustrationNoActivity({ className }: { className?: string }) {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className={cn("shEmptyIllustration", className)} aria-hidden="true">
      {/* Timeline track */}
      <line x1="18" y1="20" x2="46" y2="20" stroke="currentColor" strokeWidth="1.5" opacity="0.12" strokeLinecap="round" />
      <line x1="18" y1="32" x2="46" y2="32" stroke="currentColor" strokeWidth="1.5" opacity="0.12" strokeLinecap="round" />
      <line x1="18" y1="44" x2="46" y2="44" stroke="currentColor" strokeWidth="1.5" opacity="0.12" strokeLinecap="round" />
      {/* Empty timeline dots (ghosted) */}
      <circle cx="18" cy="20" r="3" fill="currentColor" opacity="0.08" />
      <circle cx="18" cy="32" r="3" fill="currentColor" opacity="0.08" />
      <circle cx="18" cy="44" r="3" fill="currentColor" opacity="0.08" />
      {/* Clock hand */}
      <g className="shEmptyIllustAnimateClock" transform="translate(44, 44)">
        <circle cx="0" cy="0" r="10" stroke="var(--sh-info)" strokeWidth="1.5" fill="none" opacity="0.35" />
        <line x1="0" y1="-6" x2="0" y2="-2" stroke="var(--sh-info)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
        <line x1="0" y1="0" x2="4" y2="4" stroke="var(--sh-info)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
        <circle cx="0" cy="0" r="1.5" fill="var(--sh-info)" opacity="0.5" />
      </g>
    </svg>
  );
}

function IllustrationError({ className }: { className?: string }) {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className={cn("shEmptyIllustration shEmptyIllustAnimateError", className)} aria-hidden="true">
      {/* Alert circle */}
      <circle cx="32" cy="32" r="18" stroke="var(--sh-error)" strokeWidth="1.5" fill="currentColor" fillOpacity="0.06" opacity="0.6" />
      {/* Exclamation */}
      <line x1="32" y1="22" x2="32" y2="34" stroke="var(--sh-error)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="40" r="1.5" fill="var(--sh-error)" />
    </svg>
  );
}

function IllustrationSearchNoResults({ className }: { className?: string }) {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className={cn("shEmptyIllustration", className)} aria-hidden="true">
      {/* Magnifying glass */}
      <circle cx="30" cy="30" r="12" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.06" opacity="0.4" />
      <line x1="39" y1="39" x2="48" y2="48" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />
      {/* X mark over glass */}      
      <g className="shEmptyIllustAnimateX" opacity="0.5">
        <line x1="22" y1="22" x2="38" y2="38" stroke="var(--sh-warning)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="38" y1="22" x2="22" y2="38" stroke="var(--sh-warning)" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function IllustrationNoRecords({ className }: { className?: string }) {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className={cn("shEmptyIllustration", className)} aria-hidden="true">
      {/* Database stack - empty */}
      <ellipse cx="32" cy="20" rx="18" ry="6" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.06" opacity="0.25" />
      <path d="M14 20v8c0 3.3 8 6 18 6s18-2.7 18-6v-8" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.06" opacity="0.25" />
      <path d="M14 28v8c0 3.3 8 6 18 6s18-2.7 18-6v-8" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.06" opacity="0.18" />
      {/* Sparkle/empty indicator */}
      <g className="shEmptyIllustAnimateSparkle" opacity="0.5">
        <line x1="32" y1="8" x2="32" y2="12" stroke="var(--sh-info)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="24" y1="10" x2="27" y2="13" stroke="var(--sh-info)" strokeWidth="1" strokeLinecap="round" />
        <line x1="40" y1="10" x2="37" y2="13" stroke="var(--sh-info)" strokeWidth="1" strokeLinecap="round" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Illustration map
// ---------------------------------------------------------------------------

const ILLUSTRATIONS: Record<string, (props: { className?: string }) => ReactNode> = {
  "no-data": IllustrationNoData,
  empty: IllustrationEmpty,
  "no-activity": IllustrationNoActivity,
  error: IllustrationError,
  "search-no-results": IllustrationSearchNoResults,
  "no-records": IllustrationNoRecords,
};

const DEFAULT_ILLUSTRATION = IllustrationEmpty;

// ---------------------------------------------------------------------------
// Action type
// ---------------------------------------------------------------------------

export type EmptyStateAction = {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  /** Optional icon rendered before the label */
  icon?: ReactNode;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EmptyState({
  variant = "empty",
  message,
  hint,
  action,
  className,
}: {
  /** Illustration variant. Default: "empty". */
  variant?: string;
  /** Primary message — bold text. */
  message: string;
  /** Secondary hint — muted text below the message. */
  hint?: string;
  /** Optional CTA button shown below the hint. */
  action?: EmptyStateAction;
  /** Optional className override. */
  className?: string;
}) {
  const Illustration = ILLUSTRATIONS[variant] ?? DEFAULT_ILLUSTRATION;

  return (
    <div
      className={cn("grid gap-2.5 justify-items-center text-center p-10 rounded-xl bg-card border border-border shadow-sm", className)}
      data-variant={variant}
    >
      <div className="grid place-items-center size-[72px] mb-1 opacity-85" aria-hidden="true">
        <Illustration />
      </div>
      <strong className="text-sm font-semibold text-foreground leading-tight max-w-[380px]">{message}</strong>
      {hint ? <p className="text-sm text-muted-foreground leading-snug m-0 max-w-[380px]">{hint}</p> : null}
      {action ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={action.onClick}
          className="mt-2"
        >
          {action.icon ? <span className="inline-flex text-primary" aria-hidden="true">{action.icon}</span> : null}
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
