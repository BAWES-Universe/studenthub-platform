"use client";

import type { Route } from "next";
import Link from "next/link";
import type { SessionUser } from "@/modules/auth/types";
import { useWorkspaceOS } from "@/modules/workspace/WorkspaceOSContext";
import { HubShortcuts, type HubCommand } from "./HubShortcuts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type HubNavigationItem = {
  label: string;
  description: string;
  href: Route;
};

type HubScopeItem = {
  value: string;
  label: string;
};

type HubQueue = {
  label: string;
  value: number;
  note: string;
  href?: string;
  tone: string;
};

type HubResult = {
  id: string;
  type: string;
  title: string;
  subtitle: string;
  meta: string;
  href?: string;
};

type HubPreviewAction = { label: string; href: string };
type HubPreviewFact = { label: string; value: string | number };
type HubPreviewRelatedRow = {
  id: string | number;
  title: string;
  subtitle: string;
  meta: string;
  href?: string;
};
type HubPreviewRelated = {
  title: string;
  rows: HubPreviewRelatedRow[];
};

type HubPreview = {
  id: string;
  type: string;
  title: string;
  subtitle: string;
  meta: string;
  href?: string;
  actions: HubPreviewAction[];
  flags: string[];
  facts: HubPreviewFact[];
  related: HubPreviewRelated[];
};

type HubSystemItem = {
  label: string;
  value: number;
  note: string;
};

type RoleJourney = {
  kicker: string;
  title: string;
  description: string;
  steps: string[];
  href: string;
  action: string;
};

type RoleGuide = {
  title: string;
  description: string;
  guardrail: string;
  primary: { label: string; href: string };
  journeys: RoleJourney[];
};

export type HubContentData = {
  query: string;
  scope: string;
  scopes: HubScopeItem[];
  navigation: HubNavigationItem[];
  queues: HubQueue[];
  system: HubSystemItem[];
  results: HubResult[];
  preview: HubPreview | null;
};

export function HubContent({
  data,
  guide,
  commands,
  session,
  requiredRole,
}: {
  data: HubContentData;
  guide: RoleGuide;
  commands: HubCommand[];
  session: SessionUser;
  requiredRole?: string | null;
}) {
  const { embedded } = useWorkspaceOS();
  const hubContext = hubContextHref(data.query, data.scope);

  const desk = (
    <div className="flex flex-col gap-0 min-h-svh bg-background">
      {/* Topbar — replaces commandTopbar + commandIdentity + commandSearch */}
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex flex-col items-end text-right leading-tight">
            <span className="text-[11px] font-bold uppercase text-[#1f73b7]">{session.role}</span>
            <strong className="text-sm text-foreground truncate max-w-[140px]">{session.name}</strong>
            <small className="text-[11px] text-muted-foreground truncate max-w-[140px]">{session.email}</small>
          </div>
        </div>

        <form className="flex flex-1 items-center gap-2" id="hub-search-form">
          <Input
            aria-label="Find records"
            data-command-search
            defaultValue={data.query}
            id="hub-search"
            name="q"
            placeholder="Search candidates, companies, requests, transfers, ID batches"
            className="max-w-md"
          />
          <input type="hidden" name="scope" value={data.scope} />
          <Button type="submit" size="sm" className="bg-[#eb6651] hover:bg-[#d45441] text-white">
            Search
          </Button>
        </form>

        {embedded ? null : <HubShortcuts commands={commands} />}
      </header>

      {/* Content area */}
      <div className="flex-1 p-4 flex flex-col gap-4">
        {/* Role boundary notice */}
        {requiredRole && requiredRole !== session.role ? (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div>
                <span className="text-[11px] font-bold uppercase text-destructive">Access boundary</span>
                <strong className="block text-sm text-foreground mt-1">
                  You are signed in as {session.role}, not {requiredRole}.
                </strong>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Use the matching production credentials to enter that workspace. This keeps candidate, staff, company, and
                  admin data separated.
                </p>
              </div>
              <Link className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0 no-underline")} href="/login">
                Switch account
              </Link>
            </CardContent>
          </Card>
        ) : null}

        {/* Hero section — replaces journeyHero + journeyGuardrail */}
        <Card>
          <CardContent className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)] gap-4 p-6">
            <div>
              <span className="text-[11px] font-bold uppercase text-[#1f73b7]">Start here</span>
              <h1 className="text-2xl font-bold text-foreground mt-1 mb-1">{guide.title}</h1>
              <p className="text-sm text-muted-foreground">{guide.description}</p>
              <div className="flex flex-wrap items-center gap-2 mt-4">
                <Link
                  className={cn(
                    buttonVariants({ variant: "default", size: "default" }),
                    "no-underline bg-[#eb6651] hover:bg-[#d45441] text-white"
                  )}
                  href={guide.primary.href as Route}
                >
                  {guide.primary.label}
                </Link>
                <Link className={cn(buttonVariants({ variant: "outline", size: "sm" }), "no-underline")} href={hubContext as Route}>
                  Open focused search
                </Link>
              </div>
            </div>
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="p-4 flex flex-col gap-1">
                <span className="text-[11px] font-bold uppercase text-[#1f73b7]">Signed in as {session.role}</span>
                <strong className="text-sm text-foreground">{session.name}</strong>
                <p className="text-xs text-muted-foreground">{guide.guardrail}</p>
              </CardContent>
            </Card>
          </CardContent>
        </Card>

        {/* Workflow journey cards — replaces journeyGrid + journeyCard */}
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3" aria-label={`${session.role} workflows`}>
          {guide.journeys.map((journey) => (
            <Card key={journey.title} className="flex flex-col">
              <CardHeader className="p-4 pb-2">
                <Badge variant="secondary" className="self-start text-[11px] uppercase font-bold bg-[#fef1ef] text-[#eb6651] border-[#eb6651]/20">
                  {journey.kicker}
                </Badge>
                <h3 className="text-sm font-bold text-foreground mt-2">{journey.title}</h3>
                <p className="text-xs text-muted-foreground">{journey.description}</p>
              </CardHeader>
              <CardContent className="p-4 pt-0 flex-1 flex flex-col justify-between gap-3">
                <ol className="list-decimal list-inside text-xs text-muted-foreground space-y-1">
                  {journey.steps.map((step) => (
                    <li key={step} className="text-foreground/80">
                      {step}
                    </li>
                  ))}
                </ol>
                <Link
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "no-underline w-full")}
                  href={journey.href as Route}
                >
                  {journey.action}
                </Link>
              </CardContent>
            </Card>
          ))}
        </section>

        {/* Workbench panels — replaces journeyWorkbench */}
        <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3" aria-label="Search and live queues">
          {/* Panel A: Live queues */}
          <Card>
            <CardHeader className="pb-2">
              <span className="text-[11px] font-bold uppercase text-[#1f73b7]">Live queues</span>
              <h3 className="text-sm font-bold text-foreground">What needs attention</h3>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {data.queues.map((queue) => {
                  const content = (
                    <Card key={queue.label} className="border-border/60">
                      <CardContent className="p-3 flex flex-col gap-0.5">
                        <span className="text-[10px] font-bold uppercase text-muted-foreground">{queue.label}</span>
                        <strong className="text-lg text-foreground">{queue.value.toLocaleString("en-US")}</strong>
                        <small className="text-[11px] text-muted-foreground">{queue.note}</small>
                      </CardContent>
                    </Card>
                  );
                  return queue.href ? (
                    <Link className="no-underline hover:opacity-80 transition-opacity" href={queue.href as Route} key={queue.label}>
                      {content}
                    </Link>
                  ) : (
                    content
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Panel B: Search & Results */}
          <Card>
            <CardHeader className="pb-2">
              <span className="text-[11px] font-bold uppercase text-[#1f73b7]">{data.scope}</span>
              <h3 className="text-sm font-bold text-foreground">
                {data.query ? `Search results for ${data.query}` : "Find a record"}
              </h3>
            </CardHeader>
            <CardContent>
              <nav className="flex flex-wrap items-center gap-1 mb-3" aria-label="Search scopes">
                {data.scopes.map((item) => {
                  const query = data.query ? `&q=${encodeURIComponent(data.query)}` : "";
                  return (
                    <Link
                      className={cn(
                        buttonVariants({ variant: item.value === data.scope ? "secondary" : "ghost" }),
                        "text-[11px] no-underline"
                      )}
                      href={`/app?scope=${item.value}${query}` as Route}
                      key={item.value}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
              <div className="grid">
                {data.results.slice(0, 6).map((result) => (
                  <Link
                    className="flex items-center gap-2 px-2 py-2 border-b border-border last:border-b-0 hover:bg-muted/50 no-underline transition-colors"
                    href={hubRecordHref(data.query, data.scope, result.id) as Route}
                    key={result.id}
                  >
                    <Badge variant="outline" className="text-[10px] uppercase shrink-0">{result.type}</Badge>
                    <strong className="text-sm text-foreground truncate">{result.title}</strong>
                    <small className="text-xs text-muted-foreground truncate ml-auto">{result.meta}</small>
                  </Link>
                ))}
                {data.results.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No matching records for this login and scope.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Record preview */}
        {data.preview ? <RecordPreview preview={data.preview} /> : null}
      </div>
    </div>
  );

  return desk;
}

function RecordPreview({ preview }: { preview: HubPreview }) {
  return (
    <Card aria-label="Selected record preview">
      <CardHeader className="pb-2">
        <Badge variant="outline" className="text-[10px] uppercase self-start">{preview.type}</Badge>
        <h2 className="text-lg font-bold text-foreground mt-1">{preview.title}</h2>
        <p className="text-sm text-muted-foreground">{preview.subtitle}</p>
        <small className="text-xs text-muted-foreground">{preview.meta}</small>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {preview.flags.length ? (
          <div className="flex flex-wrap gap-1">
            {preview.flags.map((flag) => (
              <Badge key={flag} variant="secondary">{flag}</Badge>
            ))}
          </div>
        ) : null}

        {preview.actions.length ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3" aria-label="Record actions">
            {preview.actions.map((action) => (
              <Button key={`${action.label}-${action.href}`} variant="outline" size="sm" asChild>
                <a href={action.href}>{action.label}</a>
              </Button>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 border-t border-border pt-3">
          {preview.facts.map((fact) => (
            <div key={fact.label}>
              <span className="text-[10px] font-bold uppercase text-muted-foreground">{fact.label}</span>
              <strong className="block text-sm text-foreground">{fact.value}</strong>
            </div>
          ))}
        </div>

        {preview.related.length ? (
          <div className="border-t border-border pt-3 space-y-3">
            {preview.related.map((section) => (
              <section key={section.title}>
                <h3 className="text-sm font-bold text-foreground mb-2">{section.title}</h3>
                {section.rows.length ? (
                  <div className="grid">
                    {section.rows.map((row) =>
                      row.href ? (
                        <Link
                          className="flex items-center gap-2 px-2 py-2 border-b border-border last:border-b-0 hover:bg-muted/50 no-underline transition-colors"
                          href={row.href as Route}
                          key={row.id}
                        >
                          <strong className="text-sm text-foreground truncate">{row.title}</strong>
                          <span className="text-xs text-muted-foreground truncate">{row.subtitle}</span>
                          <small className="text-xs text-muted-foreground ml-auto">{row.meta}</small>
                        </Link>
                      ) : (
                        <article className="flex items-center gap-2 px-2 py-2 border-b border-border last:border-b-0" key={row.id}>
                          <strong className="text-sm text-foreground truncate">{row.title}</strong>
                          <span className="text-xs text-muted-foreground truncate">{row.subtitle}</span>
                          <small className="text-xs text-muted-foreground ml-auto">{row.meta}</small>
                        </article>
                      )
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No related records visible to this login.</p>
                )}
              </section>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function hubContextHref(query: string, scope: string) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("scope", scope);
  return `/app?${params.toString()}`;
}

function hubRecordHref(query: string, scope: string, record: string) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("scope", scope);
  params.set("record", record);
  return `/app?${params.toString()}`;
}
