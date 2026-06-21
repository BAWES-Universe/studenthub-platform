import type { Route } from "next";
import Link from "next/link";
import { ArrowRight, BriefcaseBusiness, Clock3, FileText, Search, Users } from "lucide-react";
import type { getStaffWorkspace } from "@/modules/workspace/data";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type StaffWorkspaceData = Awaited<ReturnType<typeof getStaffWorkspace>>;

export function StaffHome({ data }: { data: StaffWorkspaceData }) {
  const productionCandidates = data.metrics.find((metric) => metric.label === "Candidates")?.value ?? 0;
  const assignedRequests = data.metrics.find((metric) => metric.label === "Assigned Requests")?.value ?? 0;

  const workflows = [
    {
      title: "Find candidates",
      subtitle: "Search all imported production candidates, then narrow to assigned records when needed.",
      href: "/staff/candidates" as Route,
      icon: Search,
      metric: productionCandidates
    },
    {
      title: "Work requests",
      subtitle: "Open assigned employer demand, review matches, suggestions, interviews, and shortlists.",
      href: "/staff/requests" as Route,
      icon: BriefcaseBusiness,
      metric: assignedRequests
    },
    {
      title: "Time and pay",
      subtitle: "Use candidate profiles to inspect work logs, appeals, transfer rows, and unpaid context.",
      href: "/staff/candidates#time" as Route,
      icon: Clock3,
      metric: "Live"
    },
    {
      title: "Documents",
      subtitle: "Candidate CVs, profile links, civil ID records, certificates, and PDF/export work belong here.",
      href: "/staff/candidates#documents" as Route,
      icon: FileText,
      metric: "Next"
    }
  ];

  return (
    <section className="grid gap-3">
      {/* Hero section */}
      <section className="grid grid-cols-[minmax(0,1fr)_minmax(240px,340px)] gap-3.5 items-stretch border border-border rounded-lg bg-card p-4">
        <div className="grid content-center gap-2">
          <span className="text-[#1f73b7] text-[11px] font-black uppercase tracking-normal">
            Staff operating home
          </span>
          <h2 className="max-w-[760px] mb-0 text-[clamp(30px,4vw,56px)] leading-[0.98]">
            Start with the work, not the database.
          </h2>
          <p className="max-w-[720px] mb-0 text-muted-foreground leading-[1.45]">
            Search production candidates, open a profile, move into request fulfillment, and keep time/pay/document
            context attached to the same person.
          </p>
          <div className="flex flex-wrap gap-2 mt-2.5">
            <Link
              className={cn(buttonVariants({ variant: "default" }), "gap-2 bg-[#1f73b7] hover:bg-[#1a5e96]")}
              href="/staff/candidates"
            >
              <Users aria-hidden="true" size={16} />
              Search candidates
            </Link>
            <Link
              className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
              href="/staff/requests"
            >
              <BriefcaseBusiness aria-hidden="true" size={16} />
              Open requests
            </Link>
          </div>
        </div>
        <aside className="grid content-end gap-1.5 border border-border rounded-lg bg-[#1f73b7]/[0.07] p-3.5">
          <span className="text-[#1f73b7] text-[11px] font-black uppercase">Production data loaded</span>
          <strong className="text-[42px] leading-[1]">
            {Number(productionCandidates).toLocaleString("en-US")}
          </strong>
          <small className="text-muted-foreground">
            Candidates available to search from the imported database.
          </small>
        </aside>
      </section>

      {/* Workflow grid */}
      <section
        className="grid grid-cols-4 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-2.5"
        aria-label="Staff workflows"
      >
        {workflows.map((workflow) => {
          const Icon = workflow.icon;
          return (
            <Link
              className="min-w-0 grid gap-2.5 p-3 border border-border rounded-lg bg-card no-underline text-foreground transition-colors hover:border-[#1f73b7] hover:bg-[#1f73b7]/[0.07]"
              href={workflow.href}
              key={workflow.title}
            >
              <div className="flex items-center justify-between">
                <Icon aria-hidden="true" size={18} className="text-[#1f73b7]" />
                <span className="text-[#1f73b7] text-[11px] font-black uppercase">
                  {typeof workflow.metric === "number" ? workflow.metric.toLocaleString("en-US") : workflow.metric}
                </span>
              </div>
              <strong className="text-lg">{workflow.title}</strong>
              <small className="text-muted-foreground leading-[1.45]">{workflow.subtitle}</small>
              <em className="flex items-center gap-1 not-italic text-[#1f73b7] text-xs font-black">
                Open <ArrowRight aria-hidden="true" size={14} />
              </em>
            </Link>
          );
        })}
      </section>

      {/* Rows panels */}
      <section className="grid grid-cols-2 max-md:grid-cols-1 gap-2.5">
        <StaffRows title="Recent requests" rows={data.requests} empty="No assigned requests for this staff login yet." />
        <StaffRows title="Recent stories" rows={data.stories} empty="No stories connected to this staff login yet." />
      </section>
    </section>
  );
}

function StaffRows({
  title,
  rows,
  empty
}: {
  title: string;
  rows: { id: string | number; title: string; subtitle: string; meta?: string; href?: string }[];
  empty: string;
}) {
  return (
    <Card className="min-h-[240px] overflow-hidden">
      <div className="flex items-center justify-between gap-2.5 border-b border-border px-3 py-2.5">
        <span className="text-[#1f73b7] text-[11px] font-black uppercase">{title}</span>
        <span className="inline-flex items-center justify-center min-w-[30px] min-h-[30px] text-[#1f73b7] border border-[#1f73b7]/20 bg-[#1f73b7]/[0.07] font-bold text-sm rounded">
          {rows.length}
        </span>
      </div>
      {rows.length ? (
        rows.map((row) =>
          row.href ? (
            <Link
              href={row.href as Route}
              key={row.id}
              className="min-w-0 grid gap-1 border-b border-border last:border-b-0 px-3 py-2.5 no-underline text-foreground transition-colors hover:bg-muted/50"
            >
              <strong className="truncate text-sm">{row.title}</strong>
              <span className="truncate text-muted-foreground text-sm">{row.subtitle}</span>
              {row.meta ? <small className="truncate text-muted-foreground text-xs">{row.meta}</small> : null}
            </Link>
          ) : (
            <article
              key={row.id}
              className="min-w-0 grid gap-1 border-b border-border last:border-b-0 px-3 py-2.5"
            >
              <strong className="truncate text-sm">{row.title}</strong>
              <span className="truncate text-muted-foreground text-sm">{row.subtitle}</span>
              {row.meta ? <small className="truncate text-muted-foreground text-xs">{row.meta}</small> : null}
            </article>
          )
        )
      ) : (
        <p className="m-0 p-3 text-muted-foreground text-sm">{empty}</p>
      )}
    </Card>
  );
}
