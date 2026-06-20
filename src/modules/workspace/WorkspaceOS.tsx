"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import type { Route } from "next";
import type { SessionUser } from "@/modules/auth/types";
import { logoutAction } from "@/modules/auth/actions";
import { ThemeToggle } from "@/modules/theme/ThemeToggle";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { WorkspaceOSContext } from "./WorkspaceOSContext";
import { WorkspaceMobileNavigation, WorkspaceNavigation } from "./WorkspaceNavigation";
import { navForRole } from "./navigation";
import type { NavItem } from "./navigation";

// ── Command types ─────────────────────────────────────────────

export type OSCommand = {
  id: string;
  title: string;
  subtitle: string;
  section: string;
  href: string;
  shortcut?: string;
};

const builtinShortcuts = [
  { keys: "⌘K", label: "Open command menu" },
  { keys: "/", label: "Focus workspace search" },
  { keys: "G H", label: "Go to command workspace" },
  { keys: "Esc", label: "Close menu or clear focus" }
];

// ── Keyboard shortcut chords per role ──────────────────────────

function roleChords(role: string): { keys: string; label: string }[] {
  const base = builtinShortcuts;
  if (role === "admin") {
    return [
      ...base,
      { keys: "G C", label: "Go to candidates" },
      { keys: "G R", label: "Go to requests" },
      { keys: "G T", label: "Go to transfers" },
      { keys: "G O", label: "Go to companies" }
    ];
  }
  if (role === "staff") {
    return [
      ...base,
      { keys: "G R", label: "Go to requests" },
      { keys: "G C", label: "Go to candidates" },
      { keys: "G I", label: "Go to interviews" }
    ];
  }
  if (role === "candidate") {
    return [
      ...base,
      { keys: "G I", label: "Go to invitations" },
      { keys: "G W", label: "Go to work logs" }
    ];
  }
  return base;
}

// ── Build commands from nav items ──────────────────────────────

function buildOSCommands(navItems: NavItem[], role: string): OSCommand[] {
  const chordByHref: Record<string, string> = {};
  chordByHref[`/${role}`] = "G H";
  if (role === "admin") {
    chordByHref[`/${role}/candidates`] = "G C";
    chordByHref[`/${role}/requests`] = "G R";
    chordByHref[`/${role}/transfers`] = "G T";
    chordByHref[`/${role}/companies`] = "G O";
  } else if (role === "staff") {
    chordByHref[`/${role}/requests`] = "G R";
    chordByHref[`/${role}/candidates`] = "G C";
    chordByHref[`/${role}/interviews`] = "G I";
  } else if (role === "candidate") {
    chordByHref[`/${role}/invitations`] = "G I";
    chordByHref[`/${role}/work-logs`] = "G W";
  }

  const shortcutFor = (href: string) => chordByHref[href];

  const nav = navItems.map((item) => ({
    id: `nav-${item.href}`,
    title: item.label,
    subtitle: item.href,
    section: "Navigation",
    href: item.href,
    shortcut: shortcutFor(item.href)
  }));

  const scopes: OSCommand[] = [];
  if (role === "admin" || role === "staff") {
    scopes.push(
      { id: "scope-candidates", title: "Candidates", subtitle: "Search and manage student candidates", section: "Quick Scopes", href: `/${role}/candidates`, shortcut: shortcutFor(`/${role}/candidates`) },
      { id: "scope-requests", title: "Requests", subtitle: "Hiring requests and fulfillment", section: "Quick Scopes", href: `/${role}/requests`, shortcut: shortcutFor(`/${role}/requests`) }
    );
  }
  if (role === "admin") {
    scopes.push(
      { id: "scope-companies", title: "Companies", subtitle: "Client company profiles", section: "Quick Scopes", href: "/admin/companies", shortcut: shortcutFor("/admin/companies") },
      { id: "scope-transfers", title: "Transfers", subtitle: "Financial transfers and payouts", section: "Quick Scopes", href: "/admin/transfers", shortcut: shortcutFor("/admin/transfers") }
    );
  }
  if (role === "candidate") {
    scopes.push(
      { id: "scope-invitations", title: "Invitations", subtitle: "Your open invitations", section: "Quick Scopes", href: "/candidate/invitations", shortcut: shortcutFor("/candidate/invitations") },
      { id: "scope-work-logs", title: "Work Logs", subtitle: "Track your work activities", section: "Quick Scopes", href: "/candidate/work-logs", shortcut: shortcutFor("/candidate/work-logs") }
    );
  }

  return [...nav, ...scopes];
}

// ── WorkspaceOS Component ──────────────────────────────────────

export function WorkspaceOS({
  session,
  children
}: {
  session: SessionUser;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const navItems = useMemo(() => navForRole(session.role), [session.role]);

  // ── Command palette state ────────────────────────────────────
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const cmdInputRef = useRef<HTMLInputElement | null>(null);
  const seqRef = useRef("");

  const commands = useMemo(() => buildOSCommands(navItems, session.role), [navItems, session.role]);

  const filtered = useMemo(() => {
    const q = cmdQuery.trim().toLowerCase();
    if (!q) return commands.slice(0, 18);
    return commands
      .filter((c) =>
        [c.title, c.subtitle, c.section, c.shortcut].filter(Boolean).join(" ").toLowerCase().includes(q)
      )
      .slice(0, 18);
  }, [commands, cmdQuery]);

  const grouped = useMemo(() => {
    const g = new Map<string, OSCommand[]>();
    for (const c of filtered) {
      g.set(c.section, [...(g.get(c.section) ?? []), c]);
    }
    return [...g.entries()];
  }, [filtered]);

  const visit = useCallback(
    (href: string) => {
      setCmdOpen(false);
      setCmdQuery("");
      router.push(href as Route);
    },
    [router]
  );

  // ── Global keyboard handler ──────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable === true;

      // Cmd+K or ? → open command palette
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCmdOpen(true);
        setCmdIndex(0);
        setCmdQuery("");
        window.setTimeout(() => cmdInputRef.current?.focus(), 0);
        return;
      }
      if (!typing && e.key === "?") {
        e.preventDefault();
        setCmdOpen(true);
        setCmdIndex(0);
        setCmdQuery("shortcut");
        window.setTimeout(() => cmdInputRef.current?.focus(), 0);
        return;
      }

      // G then key chord navigation
      if (!typing && e.key.toLowerCase() === "g") {
        seqRef.current = "g";
        window.setTimeout(() => { seqRef.current = ""; }, 900);
        return;
      }
      if (!typing && seqRef.current === "g") {
        const key = e.key.toLowerCase();
        const match = commands.find((c) => c.shortcut?.toLowerCase() === `g ${key}`);
        if (match) {
          e.preventDefault();
          seqRef.current = "";
          visit(match.href);
        }
        return;
      }

      // / → focus search
      if (!typing && e.key === "/") {
        const input = document.querySelector<HTMLInputElement>("[data-command-search]");
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
        return;
      }

      // Command palette open → arrow keys / enter / esc
      if (cmdOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setCmdOpen(false);
          setCmdQuery("");
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setCmdIndex((i) => Math.min(i + 1, filtered.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setCmdIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" && filtered[cmdIndex]) {
          e.preventDefault();
          visit(filtered[cmdIndex].href);
          return;
        }
      }

      // j/k navigation on rows (when not in input)
      if (!typing && !cmdOpen && (e.key === "j" || e.key === "k")) {
        const rows = document.querySelectorAll("[data-os-navigable]");
        if (!rows.length) return;
        const current = document.activeElement;
        const idx = Array.from(rows).indexOf(current as Element);
        const next = e.key === "j" ? idx + 1 : idx - 1;
        const target = rows[Math.max(0, Math.min(next, rows.length - 1))] as HTMLElement | undefined;
        if (target) {
          e.preventDefault();
          target.focus();
          target.scrollIntoView({ block: "nearest" });
        }
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cmdOpen, cmdIndex, filtered, commands, visit]);

  // Reset active index when query changes
  useEffect(() => { setCmdIndex(0); }, [cmdQuery]);

  const chords = useMemo(() => roleChords(session.role), [session.role]);

  return (
    <WorkspaceOSContext.Provider value={{ embedded: true, session }}>
      <main className="shell">
        {/* ── Sidebar Rail ─────────────────────────────────── */}
        <aside className="sticky top-0 h-screen grid grid-rows-[auto_1fr_auto] justify-items-center gap-3 border-r border-border bg-card p-3">
          <Link
            className="w-full min-h-12 flex items-center gap-2.5 px-3 border border-border rounded-lg bg-[var(--ink)] text-[var(--surface)] no-underline transition-opacity hover:opacity-90"
            href="/app"
            aria-label="StudentHub app"
          >
            <span className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-[7px] bg-white/14 font-black">SH</span>
            <strong className="text-sm font-black">StudentHub</strong>
          </Link>
          <WorkspaceNavigation items={navItems} role={session.role} />
          <div className="w-full grid gap-2">
            <Button variant="outline" size="sm" className="w-full justify-between font-black" type="button" onClick={() => { setCmdOpen(true); }}>
              <span>⌘K</span>
            </Button>
            <ThemeToggle />
            <form action={logoutAction}>
              <Button variant="outline" size="sm" type="submit" className="w-full font-black">
                Sign out
              </Button>
            </form>
          </div>
        </aside>

        {/* ── Content Stage ───────────────────────────────── */}
        <section className="workspaceStage">
          {children}
        </section>

        {/* ── Mobile Tab Bar ──────────────────────────────── */}
        <WorkspaceMobileNavigation items={navItems} role={session.role} />
      </main>

      {/* ── Command Palette Overlay ───────────────────────── */}
      {cmdOpen ? (
        <div className="commandOverlay" role="dialog" aria-modal="true" aria-label="Command menu">
          <button className="commandScrim" aria-label="Close" type="button" onClick={() => setCmdOpen(false)} />
          <section className="commandMenu">
            <div className="commandInputWrap">
              <span>⌘</span>
              <input
                ref={cmdInputRef}
                autoFocus
                placeholder="Jump to a view, search records, or run an action..."
                value={cmdQuery}
                onChange={(e) => setCmdQuery(e.target.value)}
              />
              <kbd>Esc</kbd>
            </div>
            <div className="commandList">
              {grouped.length ? (
                grouped.map(([section, items]) => (
                  <div className="commandGroup" key={section}>
                    <h3>{section}</h3>
                    {items.map((cmd) => {
                      const idx = filtered.findIndex((f) => f.id === cmd.id);
                      return (
                        <button
                          className={idx === cmdIndex ? "active" : ""}
                          key={cmd.id}
                          type="button"
                          onMouseEnter={() => setCmdIndex(idx)}
                          onClick={() => visit(cmd.href)}
                        >
                          <span>
                            <strong>{cmd.title}</strong>
                            <small>{cmd.subtitle}</small>
                          </span>
                          {cmd.shortcut ? <kbd>{cmd.shortcut}</kbd> : null}
                        </button>
                      );
                    })}
                  </div>
                ))
              ) : (
                <div className="commandEmpty">
                  <strong>No command found</strong>
                  <span>Try a view, record name, scope, or shortcut.</span>
                </div>
              )}
            </div>
            <div className="shortcutGrid">
              {chords.map((row) => (
                <div key={row.keys}>
                  <kbd>{row.keys}</kbd>
                  <span>{row.label}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </WorkspaceOSContext.Provider>
  );
}
