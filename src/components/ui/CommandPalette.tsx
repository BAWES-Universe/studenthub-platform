"use client";

import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { cn } from "@/lib/utils";

// ── Types ───────────────────────────────────────────────────────────

export type OSCommand = {
  id: string;
  title: string;
  subtitle: string;
  section: string;
  href: string;
  shortcut?: string;
};

export type CommandChord = {
  keys: string;
  label: string;
};

// ── Fuzzy match highlighting ────────────────────────────────────────

type HighlightSegment = { text: string; match: boolean };

function highlightMatches(text: string, query: string): HighlightSegment[] {
  if (!query.trim()) return [{ text, match: false }];

  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let qi = 0;

  // Find matching characters in sequence (fuzzy: non-consecutive allowed)
  for (let ti = 0; ti < text.length; ti++) {
    if (qi < q.length && lower[ti] === q[qi]) {
      segments.push({ text: text[ti], match: true });
      qi++;
    } else {
      // Merge consecutive non-matching segments
      const last = segments[segments.length - 1];
      if (last && !last.match) {
        last.text += text[ti];
      } else {
        segments.push({ text: text[ti], match: false });
      }
    }
  }

  if (qi < q.length) return [{ text, match: false }]; // not a fuzzy match
  return segments;
}

function fuzzyMatchScore(text: string, query: string): number {
  if (!query.trim()) return Infinity;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return q.length * 3; // prefix match bonus
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? q.length : -1;
}

// ── Recent items (localStorage-backed) ──────────────────────────────

const RECENT_KEY = "sh-cmd-recent";
const MAX_RECENT = 6;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecent(href: string) {
  try {
    const recent = loadRecent().filter((h) => h !== href);
    recent.unshift(href);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // localStorage unavailable
  }
}

// ── CommandPalette Props ────────────────────────────────────────────

export type CommandPaletteProps = {
  open: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  selectedIndex: number;
  onSelectIndex: (i: number) => void;
  onClose: () => void;
  onVisit: (href: string) => void;
  /** All available commands */
  commands: OSCommand[];
  /** Filtered subset already computed by the parent */
  filtered: OSCommand[];
  /** Shortcut chords to display in the footer */
  chords: CommandChord[];
  inputRef: React.RefObject<HTMLInputElement | null>;
};

// ── CommandPalette Component ────────────────────────────────────────

export function CommandPalette({
  open,
  query,
  onQueryChange,
  selectedIndex,
  onSelectIndex,
  onClose,
  onVisit,
  commands,
  filtered,
  chords,
  inputRef,
}: CommandPaletteProps) {
  const initialFocusRef = useRef<HTMLInputElement | null>(null);

  // Focus input on open
  useEffect(() => {
    if (open) {
      // Small delay to let the animation start
      const id = setTimeout(() => {
        initialFocusRef.current?.focus();
      }, 50);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Group commands by section
  const grouped = useMemo(() => {
    const g = new Map<string, OSCommand[]>();
    for (const c of filtered) {
      g.set(c.section, [...(g.get(c.section) ?? []), c]);
    }
    return [...g.entries()];
  }, [filtered]);

  // Recent items (from full commands list, matched by href)
  const recent = useMemo(() => {
    if (query.trim()) return []; // only show recent when empty
    const recentHrefs = loadRecent();
    const recentCmds = recentHrefs
      .map((href) => commands.find((c) => c.href === href))
      .filter((c): c is OSCommand => !!c);
    // Remove duplicates (the find may match same href for nav+scope)
    const seen = new Set<string>();
    return recentCmds.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    }).slice(0, MAX_RECENT);
  }, [commands, query]);

  const handleVisit = useCallback(
    (href: string) => {
      saveRecent(href);
      onVisit(href);
    },
    [onVisit],
  );

  // Render a single command item
  const renderItem = useCallback(
    (cmd: OSCommand, idx: number) => {
      const active = idx === selectedIndex;
      const segments = highlightMatches(cmd.title, query);

      return (
        <button
          key={cmd.id}
          type="button"
          className={cn(
            "w-full flex items-center justify-between gap-3 border border-transparent rounded-md bg-transparent text-foreground px-2.5 py-2 text-left text-sm cursor-pointer transition-colors",
            "hover:border-border hover:bg-muted/30",
            active && "border-border bg-muted/50 shadow-sm",
          )}
          onMouseEnter={() => onSelectIndex(idx)}
          onClick={() => handleVisit(cmd.href)}
        >
          <span className="min-w-0 grid gap-0.5">
            <strong className="truncate text-sm font-semibold text-foreground">
              {segments.map((seg, si) =>
                seg.match ? (
                  <mark key={si} className="bg-transparent text-primary font-extrabold">{seg.text}</mark>
                ) : (
                  <span key={si}>{seg.text}</span>
                ),
              )}
            </strong>
            <small className="truncate text-[11px] font-medium text-muted-foreground">{cmd.subtitle}</small>
          </span>
          {cmd.shortcut ? (
            <kbd className="shrink-0 inline-flex items-center justify-center min-w-8 h-5.5 rounded-md px-1.5 bg-muted/30 border border-border text-muted-foreground text-[11px] font-bold tracking-wide">
              {cmd.shortcut}
            </kbd>
          ) : null}
        </button>
      );
    },
    [selectedIndex, query, onSelectIndex, handleVisit],
  );

  if (!open) return null;

  // ── Has recent items to show at top? ───────────────────────────
  const showRecent = recent.length > 0 && !query.trim();

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-start justify-center pt-[9vh] px-4 pb-6 animate-[shCmdFadeIn_200ms_var(--sh-easing)_both]"
      role="dialog"
      aria-modal="true"
      aria-label="Command menu"
    >
      <button
        className="absolute inset-0 border-0 bg-background/80 backdrop-blur-sm cursor-default"
        aria-label="Close"
        type="button"
        onClick={onClose}
      />

      <section className="relative w-full max-w-[680px] overflow-hidden rounded-xl bg-card shadow-[0_0_0_1px_hsl(var(--border)),0_24px_80px_rgba(0,0,0,0.25)] animate-[shCmdSlideIn_200ms_var(--sh-easing)_both]">
        {/* ── Search input ───────────────────────────────────── */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span className="size-8 inline-flex items-center justify-center rounded-md text-muted-foreground shrink-0" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            ref={(el) => {
              initialFocusRef.current = el;
              if (typeof inputRef === "object" && inputRef) {
                (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
              }
            }}
            placeholder="Jump to a view, search records, or run an action..."
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 border-0 outline-0 bg-transparent text-foreground text-[15px] font-semibold placeholder:text-muted-foreground/60 placeholder:font-medium"
          />
          <kbd className="inline-flex items-center justify-center min-w-8 h-6 rounded-md bg-muted/20 border border-border text-muted-foreground text-[11px] font-bold shrink-0 px-1.5">
            Esc
          </kbd>
        </div>

        {/* ── Results list ────────────────────────────────────── */}
        <div className="max-h-[min(48vh,480px)] overflow-y-auto p-1.5">
          {/* Recent section */}
          {showRecent && (
            <div className="grid gap-0.5 [&+&]:mt-1 [&+&]:pt-1">
              <h3 className="mx-2 my-1.5 text-muted-foreground text-[11px] font-extrabold uppercase tracking-wider">Recent</h3>
              {recent.map((cmd) => {
                const idx = filtered.findIndex((f) => f.id === cmd.id);
                const realIdx = idx >= 0 ? idx : -1;
                return renderItem(cmd, realIdx);
              })}
            </div>
          )}

          {/* Results by section */}
          {grouped.length > 0 ? (
            grouped.map(([section, items]) => (
              <div className="grid gap-0.5 [&+&]:mt-1 [&+&]:pt-1" key={section}>
                <h3 className="mx-2 my-1.5 text-muted-foreground text-[11px] font-extrabold uppercase tracking-wider">{section}</h3>
                {items.map((cmd) => {
                  const idx = filtered.findIndex((f) => f.id === cmd.id);
                  return renderItem(cmd, idx);
                })}
              </div>
            ))
          ) : !showRecent ? (
            <div className="grid place-items-center gap-1.5 py-9 px-4 text-center">
              <div className="size-11 inline-flex items-center justify-center rounded-lg bg-muted/20 text-muted-foreground mb-1" aria-hidden="true">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </div>
              <strong className="text-foreground text-sm font-semibold">No results for &ldquo;{query}&rdquo;</strong>
              <span className="text-muted-foreground text-xs">Try a view, record name, scope, or shortcut.</span>
            </div>
          ) : null}
        </div>

        {/* ── Shortcut footer ─────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-1 px-3.5 py-2.5 border-t border-border bg-muted/15">
          {chords.map((row) => (
            <div key={row.keys} className="flex items-center gap-2 px-2 py-1 rounded-md">
              <kbd className="inline-flex items-center justify-center min-w-[30px] h-5 rounded-sm bg-muted/30 border border-border text-muted-foreground text-[10px] font-bold px-1 leading-none">
                {row.keys}
              </kbd>
              <span className="text-xs text-muted-foreground">{row.label}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
