import type { Route } from "next";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { getCandidateDetail } from "@/modules/workspace/data";
import { formatDate } from "@/modules/workspace/format";
import { WorkLogStaffActions } from "./WorkLogStaffActions";

type CandidateDetailData = Awaited<ReturnType<typeof getCandidateDetail>>;

type CandidateAction = {
  label: string;
  href: string;
};

export function CandidateProfile({
  detail,
  actions,
  backHref,
  compact = false,
  viewerRole
}: {
  detail: CandidateDetailData | null;
  actions: CandidateAction[];
  backHref?: Route;
  compact?: boolean;
  viewerRole?: string;
}) {
  const candidate = detail?.candidate;
  if (!candidate) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-2 py-12">
          <strong className="text-base text-foreground">No candidate selected</strong>
          <span className="text-sm text-muted-foreground text-center max-w-md">
            Select a production candidate to view profile, readiness, work history, notes, and documents.
          </span>
        </CardContent>
      </Card>
    );
  }

  const readiness = buildReadiness(detail);
  const timeline = buildTimeline(detail);
  const status = candidate.approved === 0 ? "Needs review" : candidate.candidate_status === 10 ? "Active" : `Status ${candidate.candidate_status}`;
  const title = candidate.candidate_name_ar || candidate.candidate_name;
  const profileActions = [...actions, ...legacyProfileActions(detail)];

  return (
    <Card>
      {/* Hero header */}
      <CardHeader className="flex flex-row items-start gap-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#1f73b7]/10 text-[#1f73b7] text-lg font-bold"
          aria-hidden="true"
        >
          {initials(candidate.candidate_name)}
        </div>
        <div className="min-w-0 flex-1">
          <span className="text-[11px] font-bold uppercase text-[#1f73b7]">
            {candidate.candidate_uid ?? `#${candidate.candidate_id}`}
          </span>
          <h2 className="text-2xl font-bold text-foreground mb-0.5 mt-0.5">{candidate.candidate_name}</h2>
          {title !== candidate.candidate_name ? (
            <p className="text-sm text-muted-foreground mb-0">{title}</p>
          ) : null}
          <div className="flex items-center gap-2 mt-1.5">
            <Badge variant={candidate.approved === 0 ? "outline" : "default"}>{status}</Badge>
            <span className="text-sm text-muted-foreground">
              {candidate.store?.company?.company_name ?? candidate.country?.country_name_en ?? "No company context"}
            </span>
          </div>
        </div>
      </CardHeader>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-1.5 border-y border-border px-6 py-2.5" aria-label="Candidate actions">
        {backHref ? (
          <Link className={cn(buttonVariants({ variant: "outline", size: "sm" }), "no-underline")} href={backHref}>
            Back to list
          </Link>
        ) : null}
        {profileActions.map((action) =>
          action.href.startsWith("/") ? (
            <Link
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "no-underline")}
              href={action.href as Route}
              key={`${action.label}-${action.href}`}
            >
              {action.label}
            </Link>
          ) : (
            <Button variant="ghost" size="sm" asChild key={`${action.label}-${action.href}`}>
              <a href={action.href}>{action.label}</a>
            </Button>
          )
        )}
      </div>

      {/* Readiness section */}
      <section className="border-b border-border px-6 py-4" aria-label="Candidate readiness">
        <div className="grid grid-cols-[1fr_auto] gap-4 items-center mb-3">
          <div>
            <span className="text-[11px] font-bold uppercase text-[#1f73b7]">Readiness</span>
            <strong className="block text-3xl font-bold text-foreground mt-0.5">{readiness.score}%</strong>
            <small className="text-sm text-muted-foreground">{readiness.summary}</small>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {readiness.items.map((item) => (
              <Badge
                key={item.label}
                variant={item.done ? "default" : "outline"}
                className={item.done ? "bg-[#2e7d32]" : ""}
              >
                {item.label}
              </Badge>
            ))}
          </div>
        </div>
        {readiness.missing?.length ? (
          <div className="mt-3 pt-3 border-t border-border">
            <span className="text-[11px] font-bold uppercase text-muted-foreground">Missing fields</span>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {readiness.missing.map((item) => (
                <li key={item.label}>
                  <Link
                    className="text-xs text-[#1f73b7] hover:underline"
                    href="/candidate/edit"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* Fact grid */}
      <section className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-px bg-border px-6" aria-label="Candidate facts">
        <Fact label="Email" value={candidate.candidate_email} />
        <Fact label="Phone" value={candidate.candidate_phone ?? "No phone"} />
        <Fact label="Country" value={candidate.country?.country_name_en ?? "Not set"} />
        <Fact label="University" value={candidate.university?.university_name_en ?? "Not set"} />
        <Fact label="Company" value={candidate.store?.company?.company_name ?? "Not assigned"} />
        <Fact label="Store" value={candidate.store?.store_name ?? "Not assigned"} />
        <Fact label="Rate" value={detail.metrics[1]?.value ?? "0"} />
        <Fact label="Revenue" value={detail.stats?.totalRevenue ?? "No revenue stats"} />
        <Fact label="Civil ID" value={candidate.candidate_civil_id ?? (candidate.candidate_civil_need_verification ? "Needs verification" : "Not set")} />
        <Fact label="Updated" value={formatDate(candidate.candidate_updated_at)} />
      </section>

      <CivilIdPanel candidate={candidate} viewerRole={viewerRole} />

      {!compact && candidate.candidate_intro ? (
        <section className="border-b border-border px-6 py-4">
          <span className="text-[11px] font-bold uppercase text-[#1f73b7]">Profile intro</span>
          <p className="mt-1.5 text-sm text-foreground">{candidate.candidate_intro}</p>
        </section>
      ) : null}

      {/* Skills / Timeline split */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
        <div className="bg-card p-6">
          <PanelHeader title="Skills and tags" count={detail.skills.length + detail.tags.length} />
          <div className="flex flex-wrap gap-1.5 mt-3">
            {[...detail.skills, ...detail.tags].slice(0, compact ? 12 : 28).map((item) => (
              <Badge key={`${item.title}-${item.id}`} variant="secondary">{item.title}</Badge>
            ))}
            {!detail.skills.length && !detail.tags.length ? (
              <small className="text-muted-foreground">No imported skills or tags.</small>
            ) : null}
          </div>
        </div>

        <RowsPanel title="Timeline" rows={timeline} limit={compact ? 5 : 12} />
      </section>

      {!compact ? (
        <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-border">
          <RowsPanel title="Education" rows={detail.education} />
          <RowsPanel title="Experience" rows={detail.experiences} />
          <RowsPanel title="Applications" rows={detail.applications} />
          <RowsPanel title="Interviews" rows={detail.interviews} />
          <RowsPanel title="Suggestions" rows={detail.suggestions} />
          <RowsPanel title="Invitations" rows={detail.invitations} />
          <RowsPanel title="Work history" rows={detail.histories} />
          {viewerRole === "staff" ? (
            <WorkLogStaffPanel hours={detail.workHours as any} />
          ) : (
            <RowsPanel title="Work logs" rows={detail.workHours} />
          )}
          <RowsPanel title="Notes" rows={detail.notes} />
          <RowsPanel title="Warnings" rows={detail.warnings} />
          <RowsPanel title="Documents and links" rows={[...detail.idCards, ...detail.certificates, ...detail.links]} />
        </section>
      ) : null}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-card p-3">
      <span className="block text-[11px] font-bold uppercase text-muted-foreground mb-0.5">{label}</span>
      <strong className="text-sm text-foreground truncate block">{value}</strong>
    </div>
  );
}

function CivilIdPanel({ candidate, viewerRole }: { candidate: NonNullable<CandidateDetailData["candidate"]>; viewerRole?: string }) {
  if (!candidate.candidate_civil_id && !candidate.candidate_civil_expiry_date && !candidate.candidate_civil_photo_front && !candidate.candidate_civil_photo_back && !candidate.candidate_civil_need_verification) {
    return null;
  }

  const now = new Date();
  const expiryDate = candidate.candidate_civil_expiry_date ? new Date(candidate.candidate_civil_expiry_date) : null;
  const daysUntilExpiry = expiryDate ? Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : null;
  const isExpired = daysUntilExpiry !== null && daysUntilExpiry < 0;
  const isNearExpiry = daysUntilExpiry !== null && daysUntilExpiry >= 0 && daysUntilExpiry <= 90;

  const badges: string[] = [];
  if (candidate.candidate_civil_need_verification) badges.push("Needs verification");
  if (isExpired) badges.push("Expired");
  else if (isNearExpiry) badges.push("Expires soon");

  return (
    <section className="border-b border-border px-6 py-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-bold uppercase text-[#1f73b7]">Civil ID</span>
        <Badge variant="outline">{badges.length ? badges.join(" · ") : "On file"}</Badge>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="block text-[11px] font-bold uppercase text-muted-foreground mb-0.5">ID Number</span>
            <strong className="text-sm text-foreground">{candidate.candidate_civil_id || "—"}</strong>
          </div>
          <div>
            <span className="block text-[11px] font-bold uppercase text-muted-foreground mb-0.5">Expiry date</span>
            <strong className={cn(
              "text-sm",
              isExpired ? "text-red-600" : isNearExpiry ? "text-amber-600" : "text-foreground"
            )}>
              {expiryDate ? formatDate(expiryDate) : "—"}
            </strong>
          </div>
        </div>
        {candidate.candidate_civil_photo_front || candidate.candidate_civil_photo_back ? (
          <div className="flex gap-3">
            {candidate.candidate_civil_photo_front ? (
              <div>
                <span className="block text-[10px] font-bold uppercase text-muted-foreground mb-1">Photo (front)</span>
                <img
                  src={candidate.candidate_civil_photo_front}
                  alt="Civil ID front"
                  loading="lazy"
                  className="h-20 w-auto rounded border border-border object-cover"
                />
              </div>
            ) : null}
            {candidate.candidate_civil_photo_back ? (
              <div>
                <span className="block text-[10px] font-bold uppercase text-muted-foreground mb-1">Photo (back)</span>
                <img
                  src={candidate.candidate_civil_photo_back}
                  alt="Civil ID back"
                  loading="lazy"
                  className="h-20 w-auto rounded border border-border object-cover"
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PanelHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-bold uppercase text-[#1f73b7]">{title}</span>
      <Badge variant="outline" className="bg-[#1f73b7]/5 text-[#1f73b7] border-[#1f73b7]/20">
        {count.toLocaleString("en-US")}
      </Badge>
    </div>
  );
}

function RowsPanel({
  title,
  rows,
  limit = 8
}: {
  title: string;
  rows: { id: string | number; title: string; subtitle: string; meta?: string; href?: string }[];
  limit?: number;
}) {
  return (
    <div className="bg-card p-6">
      <PanelHeader title={title} count={rows.length} />
      <div className="mt-3 grid gap-0">
        {rows.slice(0, limit).map((row) =>
          row.href ? (
            row.href.startsWith("/") ? (
              <Link
                className="block border-b border-border last:border-b-0 py-2 hover:bg-muted/30 no-underline -mx-6 px-6"
                href={row.href as Route}
                key={`${title}-${row.id}`}
              >
                <RowContent row={row} />
              </Link>
            ) : (
              <a
                className="block border-b border-border last:border-b-0 py-2 hover:bg-muted/30 -mx-6 px-6"
                href={row.href}
                key={`${title}-${row.id}`}
              >
                <RowContent row={row} />
              </a>
            )
          ) : (
            <article
              className="block border-b border-border last:border-b-0 py-2 hover:bg-muted/30 -mx-6 px-6"
              key={`${title}-${row.id}`}
            >
              <RowContent row={row} />
            </article>
          )
        )}
        {!rows.length ? <small className="text-muted-foreground py-2 block">No imported rows visible for this login.</small> : null}
      </div>
    </div>
  );
}

function RowContent({ row }: { row: { title: string; subtitle: string; meta?: string } }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <strong className="block text-sm text-foreground truncate">{row.title}</strong>
        <span className="text-xs text-muted-foreground truncate">{row.subtitle}</span>
      </div>
      {row.meta ? <small className="shrink-0 text-xs text-muted-foreground">{row.meta}</small> : null}
    </div>
  );
}

type WorkLogRow = {
  id: string | number;
  title: string;
  subtitle: string;
  meta?: string;
  status: number;
};

function WorkLogStaffPanel({ hours }: { hours: WorkLogRow[] }) {
  return (
    <div className="bg-card p-6">
      <PanelHeader title="Work logs" count={hours.length} />
      <div className="mt-3 grid gap-0">
        {hours.slice(0, 8).map((hour) => (
          <article
            key={`worklog-${hour.id}`}
            className="flex items-center justify-between border-b border-border last:border-b-0 py-2 -mx-6 px-6 hover:bg-muted/30"
          >
            <RowContent row={hour} />
            <WorkLogStaffActions workLogUuid={String(hour.id)} currentStatus={hour.status} />
          </article>
        ))}
        {!hours.length ? <small className="text-muted-foreground py-2 block">No work log records for this candidate.</small> : null}
      </div>
    </div>
  );
}

function buildReadiness(detail: CandidateDetailData) {
  const c = detail.candidate;
  const items = [
    { label: "Name", done: Boolean(c?.candidate_name), field: "Name (English)" },
    { label: "Email", done: Boolean(c?.candidate_email), field: "Email address" },
    { label: "Phone", done: Boolean(c?.candidate_phone), field: "Phone number" },
    { label: "Country", done: Boolean(c?.country_id), field: "Country / Nationality" },
    { label: "University", done: Boolean(c?.university_id), field: "University" },
    { label: "Objective", done: Boolean(c?.candidate_objective), field: "Objective / Headline" },
    { label: "Intro", done: Boolean(c?.candidate_intro), field: "Profile introduction" },
    { label: "Civil ID number", done: Boolean(c?.candidate_civil_id), field: "Civil ID number" },
    { label: "Civil ID photos", done: Boolean(c?.candidate_civil_photo_front || c?.candidate_civil_photo_back), field: "Civil ID photos (front/back)" },
    { label: "Profile photo", done: Boolean(c?.candidate_personal_photo), field: "Profile photo upload" },
    { label: "CV / Resume", done: Boolean(c?.candidate_resume), field: "CV / Resume upload" },
    { label: "Bank info", done: Boolean(c?.bank_id || c?.candidate_iban), field: "Bank name or IBAN" },
    { label: "Skills", done: detail.skills.length > 0, field: "At least one skill tag" },
    { label: "Education", done: detail.education.length > 0, field: "Education entries" },
    { label: "Experience", done: detail.experiences.length > 0, field: "Work experience entries" },
    { label: "Approved", done: Boolean(c && c.approved !== 0), field: "Staff approval" },
  ];
  const done = items.filter((item) => item.done).length;
  const score = Math.round((done / items.length) * 100);
  const summary =
    score >= 85 ? "Ready to present"
    : score >= 60 ? "Usable with cleanup — fill in the open fields below"
    : "Needs attention — complete the missing fields to improve your profile visibility";
  const missing = items.filter((item) => !item.done).map((item) => ({ label: item.field ?? item.label }));
  return { items, missing, score, summary };
}

function buildTimeline(detail: CandidateDetailData) {
  return [
    ...detail.suggestions.map((row) => ({ ...row, title: `Suggested · ${row.title}` })),
    ...detail.applications.map((row) => ({ ...row, title: `Applied · ${row.title}` })),
    ...detail.interviews.map((row) => ({ ...row, title: `Interview · ${row.title}` })),
    ...detail.invitations.map((row) => ({ ...row, title: `Invitation · ${row.title}` })),
    ...detail.histories.map((row) => ({ ...row, title: `Assignment · ${row.title}` })),
    ...detail.workHours.map((row) => ({ ...row, title: `Work log · ${row.title}` })),
    ...detail.notes.map((row) => ({ ...row, title: `Note · ${row.title}` }))
  ].slice(0, 16);
}

function legacyProfileActions(detail: CandidateDetailData): CandidateAction[] {
  const candidate = detail.candidate;
  if (!candidate) return [];
  return [
    toAction("Resume", candidate.candidate_resume),
    toAction("Profile URL", candidate.profile_url),
    ...detail.links.slice(0, 2).map((link) => toAction(link.title, link.href))
  ].filter((action): action is CandidateAction => Boolean(action));
}

function toAction(label: string, href: string | undefined | null) {
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("/") || href.startsWith("mailto:") || href.startsWith("tel:")) {
    return { label, href };
  }
  return null;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}
