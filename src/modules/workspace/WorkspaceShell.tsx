"use client";

import type { SessionUser } from "@/modules/auth/types";
import type { Route } from "next";
import { logoutAction } from "@/modules/auth/actions";
import { ThemeToggle } from "@/modules/theme/ThemeToggle";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { navForRole } from "./navigation";
import { WorkspaceMobileNavigation, WorkspaceNavigation } from "./WorkspaceNavigation";
import { useWorkspaceOS } from "./WorkspaceOSContext";

type Metric = {
  label: string;
  value: string | number;
  note: string;
};

type Row = {
  id: string | number;
  title: string;
  subtitle: string;
  meta?: string;
  href?: string;
};

export function WorkspaceShell({
  session,
  title,
  eyebrow,
  metrics,
  primary,
  secondary,
  children
}: {
  session: SessionUser;
  title: string;
  eyebrow: string;
  metrics: Metric[];
  primary?: { title: string; rows: Row[] };
  secondary?: { title: string; rows: Row[] };
  children?: React.ReactNode;
}) {
  const { embedded } = useWorkspaceOS();
  const navItems = navForRole(session.role);

  const rail = (
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
        <ThemeToggle />
        <form action={logoutAction}>
          <Button variant="outline" size="sm" type="submit" className="w-full font-black">
            Sign out
          </Button>
        </form>
      </div>
    </aside>
  );

  const stage = (
    <section className="workspaceStage">
      <section className="topbar">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
        </div>
        <div className="accountBox">
          <span>{session.role}</span>
          <strong>{session.name}</strong>
          <small>{session.email}</small>
        </div>
      </section>

      {metrics.length ? (
        <section className="metrics" aria-label={`${session.role} workspace metrics`}>
          {metrics.map((metric) => (
            <article className="metric" key={metric.label}>
              <span>{metric.label}</span>
              <strong>{typeof metric.value === "number" ? metric.value.toLocaleString("en-US") : metric.value}</strong>
              <p>{metric.note}</p>
            </article>
          ))}
        </section>
      ) : null}

      {children}

      <section className="lists">
        {primary ? <WorkspaceList title={primary.title} rows={primary.rows} /> : null}
        {secondary ? <WorkspaceList title={secondary.title} rows={secondary.rows} /> : null}
      </section>
    </section>
  );

  // When embedded in a WorkspaceOS layout, the layout already provides the rail and mobile nav.
  if (embedded) {
    return (
      <main className="shell shellEmbedded">
        {stage}
        <WorkspaceMobileNavigation items={navItems} role={session.role} />
      </main>
    );
  }

  return (
    <main className="shell">
      {rail}
      {stage}
      <WorkspaceMobileNavigation items={navItems} role={session.role} />
      </main>
  );
}

function WorkspaceList({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="dataList">
      <div className="listHeader">
        <h2>{title}</h2>
        <span>{rows.length}</span>
      </div>
      <div className="rows">
        {rows.length ? (
          rows.map((row) => (
            <article className="row" key={row.id}>
              <div className="rowMain">
                {row.href ? (
                  <Link href={row.href as Route}>
                    <strong>{row.title}</strong>
                  </Link>
                ) : (
                  <strong>{row.title}</strong>
                )}
                <span>{row.subtitle}</span>
              </div>
              <div className="rowMeta">{row.meta ? <span>{row.meta}</span> : null}</div>
            </article>
          ))
        ) : (
          <div className="emptyState">
            <strong>No items here</strong>
            <span>The imported database did not return rows for this panel.</span>
          </div>
        )}
      </div>
    </section>
  );
}
