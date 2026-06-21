import type { Route } from "next";
import Link from "next/link";
import { ArrowRight, BriefcaseBusiness, Clock3, FileText, Search, Users } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { getStaffWorkspace } from "@/modules/workspace/data";

type StaffWorkspaceData = Awaited<ReturnType<typeof getStaffWorkspace>>;

export function StaffHome({ data }: { data: StaffWorkspaceData }) {
  const productionCandidates = data.metrics.find((metric) => metric.label === "Candidates")?.value ?? 0;
  const assignedRequests = data.metrics.find((metric) => metric.label === "Assigned Requests")?.value ?? 0;

  const workflows = [
    {
      title: "Find candidates",
      subtitle: "Search all imported production candidates, then narrow to assigned records when needed.",
      href: "/staff/candidates",
      icon: Search,
      metric: productionCandidates,
    },
    {
      title: "Work requests",
      subtitle: "Open assigned employer demand, review matches, suggestions, interviews, and shortlists.",
      href: "/staff/requests",
      icon: BriefcaseBusiness,
      metric: assignedRequests,
    },
    {
      title: "Time and pay",
      subtitle: "Use candidate profiles to inspect work logs, appeals, transfer rows, and unpaid context.",
      href: "/staff/candidates#time",
      icon: Clock3,
      metric: "Live",
    },
    {
      title: "Documents",
      subtitle: "Candidate CVs, profile links, civil ID records, certificates, and PDF/export work belong here.",
      href: "/staff/candidates#documents",
      icon: FileText,
      metric: "Next",
    },
  ];

  const productionCount = Number(productionCandidates).toLocaleString("en-US");

  return (
    <div className="max-w-5xl mx-auto p-6 grid gap-4">
      {/* Hero Section */}
      <Card className="grid md:grid-cols-[1fr_300px] gap-4 p-4 items-stretch">
        <div className="grid content-center gap-2">
          <span className="text-blue-zendesk text-xs font-black uppercase tracking-wide">
            Staff operating home
          </span>
          <h2 className="text-3xl md:text-5xl leading-[0.98] font-bold m-0 text-foreground">
            Start with the work, not the database.
          </h2>
          <p className="text-muted-foreground leading-relaxed max-w-[720px] m-0">
            Search production candidates, open a profile, move into request fulfillment, and keep
            time/pay/document context attached to the same person.
          </p>
          <div className="flex flex-wrap gap-3 mt-2">
            <Link
              href="/staff/candidates"
              className={buttonVariants({ variant: "default", size: "default" })}
            >
              <Users aria-hidden="true" size={16} className="mr-1.5" />
              Search candidates
            </Link>
            <Link
              href="/staff/requests"
              className={buttonVariants({ variant: "outline", size: "default" })}
            >
              <BriefcaseBusiness aria-hidden="true" size={16} className="mr-1.5" />
              Open requests
            </Link>
          </div>
        </div>

        <aside className="grid content-end gap-1.5 border border-border rounded-lg bg-blue-zendesk/5 p-3.5">
          <span className="text-blue-zendesk text-xs font-black uppercase tracking-wide">
            Production data loaded
          </span>
          <strong className="text-[42px] leading-[1] font-bold text-foreground">
            {productionCount}
          </strong>
          <small className="text-muted-foreground text-sm leading-relaxed">
            Candidates available to search from the imported database.
          </small>
        </aside>
      </Card>

      {/* Workflow Grid */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Staff workflows">
        {workflows.map((workflow) => {
          const Icon = workflow.icon;
          const metricLabel =
            typeof workflow.metric === "number"
              ? workflow.metric.toLocaleString("en-US")
              : workflow.metric;
          return (
            <Link
              href={workflow.href as Route}
              key={workflow.title}
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-auto flex-col items-start gap-2 p-4 no-underline text-left",
                "hover:bg-accent hover:text-accent-foreground transition-colors",
              )}
            >
              <div className="flex items-center gap-2 w-full">
                <Icon aria-hidden="true" size={18} className="text-blue-zendesk shrink-0" />
                <span className="text-blue-zendesk text-xs font-black uppercase tracking-wide ml-auto">
                  {metricLabel}
                </span>
              </div>
              <strong className="text-sm font-semibold text-foreground">{workflow.title}</strong>
              <small className="text-muted-foreground text-xs leading-relaxed">
                {workflow.subtitle}
              </small>
              <em className="flex items-center gap-1 text-xs font-medium text-blue-zendesk mt-1 not-italic">
                Open <ArrowRight aria-hidden="true" size={14} />
              </em>
            </Link>
          );
        })}
      </section>

      {/* Recent rows */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <StaffRows
          title="Recent requests"
          rows={data.requests}
          empty="No assigned requests for this staff login yet."
        />
        <StaffRows
          title="Recent stories"
          rows={data.stories}
          empty="No stories connected to this staff login yet."
        />
      </section>
    </div>
  );
}

function StaffRows({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { id: string | number; title: string; subtitle: string; meta?: string; href?: string }[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 py-3 px-4">
        <span className="text-blue-zendesk text-xs font-black uppercase tracking-wide">{title}</span>
        <strong className="text-sm font-semibold text-foreground">{rows.length}</strong>
      </CardHeader>
      <CardContent className="grid gap-px p-0">
        {rows.map((row) =>
          row.href ? (
            <Link
              href={row.href as Route}
              key={row.id}
              className="grid gap-0.5 px-4 py-2.5 hover:bg-accent transition-colors no-underline"
            >
              <strong className="text-sm font-medium text-foreground">{row.title}</strong>
              <span className="text-xs text-muted-foreground">{row.subtitle}</span>
              {row.meta ? <small className="text-xs text-muted-foreground/70">{row.meta}</small> : null}
            </Link>
          ) : (
            <article key={row.id} className="grid gap-0.5 px-4 py-2.5">
              <strong className="text-sm font-medium text-foreground">{row.title}</strong>
              <span className="text-xs text-muted-foreground">{row.subtitle}</span>
              {row.meta ? <small className="text-xs text-muted-foreground/70">{row.meta}</small> : null}
            </article>
          ),
        )}
        {!rows.length ? (
          <p className="px-4 py-3 text-sm text-muted-foreground m-0">{empty}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
