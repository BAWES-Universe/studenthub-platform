"use client";

import type { SessionUser } from "@/modules/auth/types";
import type { Route } from "next";
import { logoutAction } from "@/modules/auth/actions";
import { ThemeToggle } from "@/modules/theme/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
        className="w-full min-h-12 flex items-center gap-2.5 px-3 border border-border rounded-lg bg-foreground text-card-foreground no-underline transition-opacity hover:opacity-90 font-black text-sm"
        href="/app"
        aria-label="StudentHub app"
      >
        <span className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-[7px] bg-white/14">SH</span>
        <strong>StudentHub</strong>
      </Link>
      <WorkspaceNavigation items={navItems} role={session.role} />
      <div className="w-full grid gap-2">
        <ThemeToggle />
        <form action={logoutAction}>
          <Button variant="outline" size="sm" type="submit" className="w-full">
            Sign out
          </Button>
        </form>
      </div>
    </aside>
  );

  const stage = (
    <section className="min-w-0 overflow-x-hidden grid content-start gap-3.5 p-3.5">
      <section className="grid grid-cols-[1fr_minmax(220px,300px)] items-center gap-4.5 border border-border rounded-lg bg-card p-4">
        <div>
          <p className="text-blue-600 text-xs font-bold uppercase tracking-normal mb-2.5">{eyebrow}</p>
          <h1 className="max-w-[800px] mb-0 text-[clamp(27px,2.8vw,42px)] leading-[1.05] tracking-normal">{title}</h1>
        </div>
        <div className="min-w-0 grid gap-1.5 p-3.5 border border-border rounded-lg bg-card">
          <span className="text-blue-600 text-xs font-bold uppercase">{session.role}</span>
          <strong className="overflow-hidden text-ellipsis whitespace-nowrap">{session.name}</strong>
          <small className="text-muted-foreground overflow-hidden text-ellipsis">{session.email}</small>
        </div>
      </section>

      {metrics.length ? (
        <section className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3" aria-label={`${session.role} workspace metrics`}>
          {metrics.map((metric) => (
            <Card key={metric.label}>
              <CardContent className="p-4">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{metric.label}</span>
                <strong className="block text-[38px] leading-[1] my-3 font-bold">
                  {typeof metric.value === "number" ? metric.value.toLocaleString("en-US") : metric.value}
                </strong>
                <p className="text-muted-foreground/70 text-sm mb-0">{metric.note}</p>
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}

      {children}

      <section className="grid grid-cols-2 gap-3">
        {primary ? <WorkspaceListCard title={primary.title} count={primary.rows.length} rows={primary.rows} /> : null}
        {secondary ? <WorkspaceListCard title={secondary.title} count={secondary.rows.length} rows={secondary.rows} /> : null}
      </section>
    </section>
  );

  // When embedded in a WorkspaceOS layout, the layout already provides the rail and mobile nav.
  if (embedded) {
    return (
      <main className="block">
        {stage}
        <WorkspaceMobileNavigation items={navItems} role={session.role} />
      </main>
    );
  }

  return (
    <main className="min-h-svh grid grid-cols-[236px_minmax(0,1fr)] bg-background">
      {rail}
      {stage}
      <WorkspaceMobileNavigation items={navItems} role={session.role} />
    </main>
  );
}

function WorkspaceListCard({ title, count, rows }: { title: string; count: number; rows: Row[] }) {
  return (
    <Card className="min-h-[360px]">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border">
        <h2 className="text-xl mb-0">{title}</h2>
        <span className="min-w-[30px] min-h-[30px] inline-flex items-center justify-center text-blue-600 border border-blue-200 bg-blue-50 font-bold text-sm rounded">{count}</span>
      </div>
      <div className="grid">
        {rows.length ? (
          rows.map((row) => (
            <article
              key={row.id}
              className="min-h-[72px] grid grid-cols-[1fr_minmax(126px,auto)] gap-4 px-4 py-3.5 border-b border-border last:border-b-0"
            >
              <div className="min-w-0 grid gap-1.5 content-center">
                {row.href ? (
                  <Link href={row.href as Route}>
                    <strong className="text-foreground">{row.title}</strong>
                  </Link>
                ) : (
                  <strong className="text-foreground">{row.title}</strong>
                )}
                <span className="text-muted-foreground text-sm">{row.subtitle}</span>
              </div>
              <div className="flex items-center justify-end">
                {row.meta ? <span className="text-muted-foreground text-sm">{row.meta}</span> : null}
              </div>
            </article>
          ))
        ) : (
          <div className="grid gap-1.5 p-4 text-muted-foreground">
            <strong className="text-foreground text-[15px]">No items here</strong>
            <span className="text-sm">The imported database did not return rows for this panel.</span>
          </div>
        )}
      </div>
    </Card>
  );
}
