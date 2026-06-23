"use client";

import { useTransition, useState, useEffect, type ChangeEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDebounce } from "@/hooks/use-debounce";
import type { Route } from "next";
import Link from "next/link";
import { logoutAction } from "@/modules/auth/actions";
import type { SessionUser } from "@/modules/auth/types";
import { HubShortcuts, type HubCommand } from "@/modules/hub/HubShortcuts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/modules/theme/ThemeToggle";
import { CandidateProfile } from "./CandidateProfile";
import { ExportCVsForm } from "./ExportCVsForm";
import type {
  CandidateSearchFacet,
  CandidateSearchFilter,
  CandidateSearchParams,
  getCandidateSearchWorkspace
} from "./search";

type CandidateSearchData = Awaited<ReturnType<typeof getCandidateSearchWorkspace>>;
type CandidateSearchParamKey =
  | "q"
  | "filter"
  | "view"
  | "candidate"
  | "tabs"
  | "selected"
  | "country"
  | "university"
  | "company"
  | "skill"
  | "gender"
  | "profile"
  | "assignment"
  | "document";

export function CandidateSearchOS({
  data,
  basePath,
  homePath,
  session,
  params
}: {
  data: CandidateSearchData;
  basePath: "/admin/candidates" | "/staff/candidates";
  homePath: Route;
  session: SessionUser;
  params: CandidateSearchParams;
}) {
  const commands = buildCandidateSearchCommands(data, basePath, params);
  const selectedIds = params.selectedIds ?? [];
  const selectedRows = data.rows.filter((row) => selectedIds.includes(row.id));
  const facetGroups = [...data.facets].sort((a, b) => Number(hasActiveFacet(b)) - Number(hasActiveFacet(a)));
  const activeFacetCount = data.facets.reduce((count, facet) => count + facet.options.filter((option) => option.active).length, 0);

  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [searchValue, setSearchValue] = useState(data.query ?? "");
  const debouncedQuery = useDebounce(searchValue, 300);

  const handleSearchChange = (e: ChangeEvent<HTMLInputElement>) => {
    setSearchValue(e.target.value);
  };

  // Update URL when debounced query settles
  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    if (debouncedQuery) {
      next.set("q", debouncedQuery);
    } else {
      next.delete("q");
    }

    startTransition(() => {
      router.replace(`${basePath}?${next.toString()}`);
    });
  }, [debouncedQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="flex flex-col gap-3 min-h-svh bg-background">
      {/* Topbar */}
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
        <Link
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "shrink-0 gap-2 px-2.5 no-underline font-black text-sm"
          )}
          href={homePath}
        >
          <span className="w-7 h-7 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-black">
            SH
          </span>
          <strong>Candidates</strong>
        </Link>

        <div className="flex flex-1 items-center gap-1.5">
          <Input
            data-command-search
            id="candidate-query"
            placeholder="Search name, email, phone, ID, skill, tag"
            defaultValue={data.query}
            onChange={handleSearchChange}
            className="max-w-md"
          />
          {isPending && (
            <Skeleton className="h-5 w-5 rounded-full" />
          )}
        </div>

        <div className="flex items-center gap-2">
          <HubShortcuts commands={commands} />
          <ThemeToggle />
          <div className="flex flex-col items-end text-right leading-tight">
            <span className="text-[11px] font-bold uppercase text-muted-foreground">{session.role}</span>
            <strong className="text-sm text-foreground">{session.name}</strong>
          </div>
          <form action={logoutAction}>
            <Button variant="ghost" size="sm" type="submit">
              Sign out
            </Button>
          </form>
        </div>
      </header>

      <ActiveSearchContext basePath={basePath} data={data} params={params} />
      <BulkCandidateBar basePath={basePath} params={params} selectedIds={selectedIds} selectedRows={selectedRows} />

      <section className="flex-1 px-4 pb-4 grid gap-0 min-h-0">
        <section className="flex flex-col gap-4" aria-label="Open candidate tabs">
          <CandidateTabs basePath={basePath} data={data} params={params} />
          {data.selected?.candidate ? (
            <CandidateProfile
              detail={data.selected}
              actions={data.selectedActions.filter((action) => action.label !== "Open full record")}
              viewerRole={session.role}
            />
          ) : (
            <CandidateSearchTab
              activeFacetCount={activeFacetCount}
              basePath={basePath}
              data={data}
              facetGroups={facetGroups}
              params={params}
              selectedIds={selectedIds}
            />
          )}
        </section>
      </section>
    </main>
  );
}

function CandidateSearchTab({
  activeFacetCount,
  basePath,
  data,
  facetGroups,
  params,
  selectedIds
}: {
  activeFacetCount: number;
  basePath: "/admin/candidates" | "/staff/candidates";
  data: CandidateSearchData;
  facetGroups: CandidateSearchFacet[];
  params: CandidateSearchParams;
  selectedIds: number[];
}) {
  return (
    <Card aria-label="Candidate search and filters">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <span className="text-[11px] font-bold uppercase text-[#1f73b7]">Search tab</span>
          <strong className="block text-lg text-foreground">
            {data.query ? `Results for ${data.query}` : "Candidate search"}
          </strong>
        </div>
        <Badge variant="secondary" className="shrink-0">
          {data.rows.length.toLocaleString("en-US")} of {data.matchingCount.toLocaleString("en-US")}
        </Badge>
      </CardHeader>

      {/* Power filters */}
      <details className="px-6 pb-3">
        <summary className="cursor-pointer text-sm font-semibold text-muted-foreground hover:text-foreground">
          <span>Filters</span>
          {activeFacetCount ? (
            <Badge variant="outline" className="ml-2 bg-[#1f73b7]/10 text-[#1f73b7] border-[#1f73b7]/20">
              {activeFacetCount} active
            </Badge>
          ) : (
            <span className="ml-2 text-xs text-muted-foreground">Open power filters</span>
          )}
        </summary>
        <section
          className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 border-t border-border pt-3"
          aria-label="Candidate power filters"
        >
          {facetGroups.map((facet) => (
            <FacetGroup basePath={basePath} facet={facet} key={facet.key} params={params} />
          ))}
        </section>
      </details>

      {/* Filter nav */}
      <nav
        className="flex flex-wrap items-center gap-1.5 border-t border-border px-6 py-2"
        aria-label="Candidate search filters"
      >
        {candidateFilterLinks.map((item) => (
          <Link
            key={item.value}
            className={cn(
              buttonVariants({ variant: item.value === data.filter ? "secondary" : "ghost" }),
              "text-sm no-underline"
            )}
            href={candidateSearchHref(basePath, params, { filter: item.value, candidate: "" })}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Access notice */}
      {data.selectedBlocked ? (
        <div className="mx-6 mb-3 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3">
          <strong className="text-sm text-red-800">Candidate unavailable</strong>
          <span className="text-xs text-red-600">
            This record is missing, deleted, or outside the candidates visible to this login.
          </span>
        </div>
      ) : null}

      {/* Results list */}
      <div className="grid">
        {data.rows.map((row) => (
          <article
            key={row.id}
            className={cn(
              "flex items-stretch border-b border-border last:border-b-0 hover:bg-muted/50 transition-colors",
              row.id === data.selectedId && "bg-[#1f73b7]/5"
            )}
          >
            <Link
              className="flex w-12 shrink-0 flex-col items-center justify-center gap-0.5 border-r border-border text-center no-underline hover:bg-muted/50"
              href={candidateSearchHref(basePath, params, { selected: toggleCandidateId(selectedIds, row.id).join(",") })}
              aria-label={selectedIds.includes(row.id) ? "Deselect" : "Select"}
            >
              <span className="text-xs">{selectedIds.includes(row.id) ? "✓" : ""}</span>
              <small className="text-[10px] text-muted-foreground">
                {selectedIds.includes(row.id) ? "Selected" : "Select"}
              </small>
            </Link>
            <Link
              className="flex flex-1 items-center gap-4 px-4 py-3 no-underline hover:bg-muted/30"
              href={candidateSearchHref(basePath, params, { candidate: String(row.id) })}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1f73b7]/10 text-[#1f73b7] text-xs font-bold">
                {candidateInitials(row.name)}
              </div>
              <div className="min-w-0 flex-1">
                <strong className="block text-sm text-foreground truncate">{row.name}</strong>
                <small className="text-xs text-muted-foreground truncate">{row.email}</small>
              </div>
              <Badge variant="outline" className="shrink-0 text-xs">{row.status}</Badge>
              <div className="hidden lg:flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
                <span>{row.signal}</span>
                <span>{row.country}</span>
                <span>{row.updated}</span>
              </div>
              <div className="hidden xl:flex items-center gap-1.5 shrink-0">
                {[...row.flags, ...row.skills].slice(0, 3).map((flag) => (
                  <Badge key={flag} variant="secondary" className="text-[10px]">{flag}</Badge>
                ))}
              </div>
            </Link>
          </article>
        ))}
        {data.rows.length === 0 ? (
          <Card className="mx-6 my-4 border-dashed">
            <CardContent className="flex flex-col items-center gap-2 py-12">
              <strong className="text-base text-foreground">No candidates match this search.</strong>
              <span className="text-sm text-muted-foreground text-center max-w-md">
                Remove a facet or search a different name, email, phone, skill, or candidate ID.
              </span>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </Card>
  );
}

function hasActiveFacet(facet: CandidateSearchFacet) {
  return facet.options.some((option) => option.active);
}

function BulkCandidateBar({
  basePath,
  params,
  selectedIds,
  selectedRows
}: {
  basePath: "/admin/candidates" | "/staff/candidates";
  params: CandidateSearchParams;
  selectedIds: number[];
  selectedRows: CandidateSearchData["rows"];
}) {
  if (!selectedIds.length) return null;
  const selectedValue = selectedIds.join(",");
  const loadedEmailRecipients = selectedRows.map((row) => row.email).filter(Boolean).join(",");

  return (
    <Card className="mx-4 border-[#eb6651]/30 bg-[#fef1ef]">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase text-[#eb6651]">Selection</span>
          <Badge variant="secondary">{selectedIds.length.toLocaleString("en-US")} selected</Badge>
        </div>
        <nav className="flex items-center gap-1" aria-label="Bulk actions">
          <Link
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "no-underline")}
            href={candidateSearchHref(basePath, params, { tabs: selectedValue, candidate: String(selectedIds[0] ?? ""), selected: selectedValue })}
          >
            Open as tabs
          </Link>
          {selectedIds.length === 2 ? (
            <Link
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "no-underline")}
              href={candidateSearchHref(basePath, params, { selected: selectedValue })}
            >
              Merge review
            </Link>
          ) : null}
          {loadedEmailRecipients ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={`mailto:${loadedEmailRecipients}`}>Email loaded</a>
            </Button>
          ) : null}
          <Link
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "no-underline")}
            href={candidateSearchHref(basePath, params, { selected: selectedValue })}
          >
            Generate ID batch
          </Link>
          <ExportCVsForm candidateIds={selectedValue} />
          <Link
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "no-underline")}
            href={candidateSearchHref(basePath, params, { selected: "" })}
          >
            Deselect
          </Link>
        </nav>
      </div>
    </Card>
  );
}

function CandidateTabs({
  basePath,
  data,
  params
}: {
  basePath: "/admin/candidates" | "/staff/candidates";
  data: CandidateSearchData;
  params: CandidateSearchParams;
}) {
  return (
    <nav className="flex items-center gap-0.5 border-b border-border" aria-label="Open candidate tabs">
      <Link
        className={cn(
          buttonVariants({ variant: !data.selectedId ? "secondary" : "ghost" }),
          "rounded-none border-b-2 no-underline text-sm",
          !data.selectedId
            ? "border-[#eb6651] text-[#eb6651]"
            : "border-transparent"
        )}
        href={candidateSearchHref(basePath, params, { candidate: "" })}
      >
        Search
      </Link>
      {data.openTabs.map((tab) => {
        const remainingTabs = data.openTabs.filter((item) => item.id !== tab.id).map((item) => item.id);
        const nextCandidate = data.selectedId === tab.id ? remainingTabs.at(-1) : data.selectedId;
        return (
          <div
            key={tab.id}
            className={cn(
              "flex items-center gap-1 px-3 py-2 border-b-2",
              data.selectedId === tab.id
                ? "border-[#eb6651]"
                : "border-transparent"
            )}
          >
            <Link
              className="flex items-center gap-2 no-underline text-sm"
              href={candidateSearchHref(basePath, params, {
                candidate: String(tab.id),
                tabs: data.openTabs.map((item) => item.id).join(",")
              })}
            >
              <strong className={data.selectedId === tab.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"}>
                {tab.title}
              </strong>
              <small className="text-[11px] text-muted-foreground">{tab.status}</small>
            </Link>
            <Link
              aria-label={`Close ${tab.title}`}
              className="text-muted-foreground hover:text-foreground ml-1 text-xs no-underline"
              href={candidateSearchHref(basePath, params, {
                candidate: nextCandidate ? String(nextCandidate) : "",
                tabs: remainingTabs.join(",")
              })}
            >
              ×
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

function ActiveSearchContext({
  basePath,
  data,
  params
}: {
  basePath: "/admin/candidates" | "/staff/candidates";
  data: CandidateSearchData;
  params: CandidateSearchParams;
}) {
  const activeFacets = data.facets.flatMap((facet) =>
    facet.options.filter((option) => option.active).map((option) => ({ key: facet.key, label: `${facet.label}: ${option.label}` }))
  );
  const activeItems = [
    data.query ? { key: "q" as const, label: `Search: ${data.query}` } : null,
    data.filter !== "all" ? { key: "filter" as const, label: candidateFilterLinks.find((item) => item.value === data.filter)?.label ?? data.filter } : null,
    data.role === "staff" && data.visibility === "assigned" ? { key: "view" as const, label: `Assigned: ${data.assignedCount ?? 0}` } : null,
    ...activeFacets
  ].filter((item): item is { key: Exclude<CandidateSearchParamKey, "candidate" | "tabs" | "selected">; label: string } => Boolean(item));

  return (
    <section className="mx-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="bg-[#1f73b7]/5 text-[11px] uppercase font-bold text-[#1f73b7] border-[#1f73b7]/20">
          {activeItems.length ? "Filtered view" : "Default view"}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {data.matchingCount.toLocaleString("en-US")} matching candidates from{" "}
          {data.role === "staff" && data.visibility === "assigned" ? "your assigned production records" : "all production data"}
        </span>
      </div>
      <nav className="flex items-center gap-1" aria-label="Active candidate filters">
        {data.role === "staff" ? (
          <>
            <Link
              className={cn(
                buttonVariants({ variant: data.visibility === "all" ? "secondary" : "ghost" }),
                "text-xs no-underline"
              )}
              href={candidateSearchHref(basePath, params, { view: "", candidate: "" })}
            >
              All production
            </Link>
            <Link
              className={cn(
                buttonVariants({ variant: data.visibility === "assigned" ? "secondary" : "ghost" }),
                "text-xs no-underline"
              )}
              href={candidateSearchHref(basePath, params, { view: "assigned", candidate: "" })}
            >
              Assigned to me
            </Link>
          </>
        ) : null}
        {activeItems.map((item) => (
          <Link
            key={`${item.key}-${item.label}`}
            className={cn(
              buttonVariants({ variant: "secondary" }),
              "text-xs no-underline gap-1"
            )}
            href={candidateSearchHref(basePath, params, { [item.key]: "", candidate: "" })}
          >
            {item.label}
            <span className="text-muted-foreground">×</span>
          </Link>
        ))}
        {activeItems.length ? (
          <Link
            className={cn(buttonVariants({ variant: "ghost" }), "text-xs no-underline")}
            href={basePath}
          >
            Clear all
          </Link>
        ) : (
          <Link
            className={cn(buttonVariants({ variant: "outline" }), "text-xs no-underline")}
            href={candidateSearchHref(basePath, params, { filter: "needs-review", candidate: "" })}
          >
            Review queue
          </Link>
        )}
      </nav>
    </section>
  );
}

const candidateFilterLinks: { label: string; value: CandidateSearchFilter }[] = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Needs review", value: "needs-review" },
  { label: "Incomplete", value: "incomplete" },
  { label: "Civil ID", value: "civil-id" }
];

function FacetGroup({ basePath, facet, params }: { basePath: "/admin/candidates" | "/staff/candidates"; facet: CandidateSearchFacet; params: CandidateSearchParams }) {
  return (
    <Card>
      <CardContent className="p-3">
        <h3 className="text-[11px] font-bold uppercase text-[#1f73b7] mb-2">{facet.label}</h3>
        <div className="grid gap-0.5">
          {facet.options.map((option) => (
            <Link
              key={option.value}
              className={cn(
                buttonVariants({ variant: option.active ? "secondary" : "ghost" }),
                "justify-between w-full no-underline text-xs"
              )}
              href={candidateSearchHref(basePath, params, { [facet.key]: option.active ? "" : option.value, candidate: "" })}
            >
              <span>{option.label}</span>
              <Badge variant="outline" className="text-[10px]">{option.count}</Badge>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function candidateSearchHref(
  basePath: "/admin/candidates" | "/staff/candidates",
  params: CandidateSearchParams,
  overrides: Partial<Record<CandidateSearchParamKey, string>>
) {
  const next = new URLSearchParams();
  const existingTabs = (params.tabIds ?? []).join(",");
  const values = {
    q: params.query ?? "",
    filter: params.filter && params.filter !== "all" ? params.filter : "",
    view: params.visibility === "assigned" ? "assigned" : "",
    candidate: params.candidateId ? String(params.candidateId) : "",
    tabs: existingTabs,
    selected: (params.selectedIds ?? []).join(","),
    country: params.country ?? "",
    university: params.university ?? "",
    company: params.company ?? "",
    skill: params.skill ?? "",
    gender: params.gender ?? "",
    profile: params.profile ?? "",
    assignment: params.assignment ?? "",
    document: params.document ?? "",
    ...overrides
  };
  if (values.candidate && overrides.tabs === undefined) {
    values.tabs = [...new Set([...(values.tabs ? values.tabs.split(",") : []), values.candidate])].filter(Boolean).join(",");
  }
  for (const [key, value] of Object.entries(values)) {
    if (value) next.set(key, value);
  }
  const suffix = next.toString();
  return (suffix ? `${basePath}?${suffix}` : basePath) as Route;
}

function toggleCandidateId(ids: number[], id: number) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function candidateInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function buildCandidateSearchCommands(
  data: CandidateSearchData,
  basePath: "/admin/candidates" | "/staff/candidates",
  params: CandidateSearchParams
): HubCommand[] {
  return [
    { id: "candidate-search-focus", title: "Focus candidate search", subtitle: "Search production candidates", section: "Search", href: "#candidate-query", shortcut: "/" },
    { id: "candidate-clear", title: "Clear candidate filters", subtitle: "Return to the default search view", section: "Search", href: basePath },
    ...candidateFilterLinks.map((filter) => ({
      id: `filter-${filter.value}`,
      title: filter.label,
      subtitle: "Filter candidate search",
      section: "Filters",
      href: candidateSearchHref(basePath, params, { filter: filter.value, candidate: "" })
    })),
    ...data.rows.slice(0, 12).map((row) => ({
      id: `candidate-${row.id}`,
      title: row.name,
      subtitle: `${row.status} · ${row.company}`,
      section: "Candidates",
      href: candidateSearchHref(basePath, params, { candidate: String(row.id) })
    })),
    ...data.selectedActions.map((action) => ({
      id: `selected-${action.label}`,
      title: action.label,
      subtitle: data.selected?.candidate?.candidate_name ?? "Selected candidate",
      section: "Selected candidate",
      href: action.href
    }))
  ];
}
