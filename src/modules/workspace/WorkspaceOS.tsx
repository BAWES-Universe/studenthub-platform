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
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

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
  const cmdInputRef = useRef<HTMLInputElement | null>(null);
  const seqRef = useRef("");

  const commands = useMemo(() => buildOSCommands(navItems, session.role), [navItems, session.role]);

  const visit = useCallback(
    (href: string) => {
      setCmdOpen(false);
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
        window.setTimeout(() => cmdInputRef.current?.focus(), 0);
        return;
      }
      if (!typing && e.key === "?") {
        e.preventDefault();
        setCmdOpen(true);
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

      // j/k navigation on rows (when not in input or command palette)
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
  }, [cmdOpen, commands, visit]);

  const chords = useMemo(() => roleChords(session.role), [session.role]);

  return (
    <WorkspaceOSContext.Provider value={{ embedded: true, session }}>
      <main className="min-h-svh grid grid-cols-[236px_minmax(0,1fr)] bg-background">
        {/* ── Sidebar Rail ─────────────────────────────────── */}
        <aside className="sticky top-0 h-screen grid grid-rows-[auto_1fr_auto] justify-items-center gap-3 border-r border-border bg-card p-3">
          <Link
            className="w-full min-h-12 flex items-center gap-2.5 px-3 border border-border rounded-lg bg-foreground text-card-foreground no-underline transition-opacity hover:opacity-90 font-black text-sm"
            href="/app"
            aria-label="StudentHub app"
          >
            <span className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-[7px] bg-white/14">SH</span>
            <strong>StudentHub</strong>
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
        <section className="min-w-0 overflow-x-hidden grid content-start gap-3.5 p-3.5">
          {children}
        </section>

        {/* ── Mobile Tab Bar ──────────────────────────────── */}
        <WorkspaceMobileNavigation items={navItems} role={session.role} />
      </main>

      {/* ── shadcn Command Dialog ─────────────────────────── */}
      <CommandDialog open={cmdOpen} onOpenChange={(open) => { if (!open) setCmdOpen(false); }}>
        <CommandInput
          ref={cmdInputRef}
          placeholder="Jump to a view, search records, or run an action..."
        />
        <CommandList>
          {chords.length > 0 && (
            <CommandGroup heading="Keyboard Shortcuts">
              {chords.map((row) => (
                <CommandItem
                  key={row.keys}
                  onSelect={() => {
                    // Chord hints are informational, not navigable directly
                  }}
                >
                  <span>{row.label}</span>
                  <CommandShortcut>{row.keys}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {["Navigation", "Quick Scopes"].map((section) => {
            const items = commands.filter((c) => c.section === section);
            if (!items.length) return null;
            return (
              <CommandGroup key={section} heading={section}>
                {items.map((cmd) => (
                  <CommandItem
                    key={cmd.id}
                    onSelect={() => visit(cmd.href)}
                  >
                    <span>{cmd.title}</span>
                    {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
          <CommandEmpty>
            <strong>No command found</strong>
            <span>Try a view, record name, scope, or shortcut.</span>
          </CommandEmpty>
        </CommandList>
      </CommandDialog>
    </WorkspaceOSContext.Provider>
  );
}
