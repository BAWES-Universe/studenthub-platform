import Link from "next/link";
import { logoutAction } from "@/modules/auth/actions";
import { requireSession } from "@/modules/auth/session";
import { roles, type Role } from "@/modules/auth/types";
import { getUnifiedHub, parseHubScope } from "@/modules/hub/data";
import { HubShortcuts, type HubCommand } from "@/modules/hub/HubShortcuts";
import { ThemeToggle } from "@/modules/theme/ThemeToggle";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function HubPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; scope?: string; record?: string; required?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const scope = parseHubScope(params.scope);
  const requiredRole = parseRequiredRole(params.required);
  const data = await getUnifiedHub(session, { query: params.q, scope, record: params.record });
  const hubContext = hubContextHref(data.query, data.scope);
  const commands = buildCommands(data);
  const guide = buildRoleGuide(session.role, data);

  return (
    <main className="flex min-h-svh bg-background">
      {/* Sidebar rail — replaces commandRail + commandRailNav */}
      <aside className="hidden lg:flex w-[220px] shrink-0 flex-col border-r border-border bg-card">
        <Link
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "flex items-center gap-2.5 px-4 py-3 no-underline rounded-none border-b border-border justify-start"
          )}
          href="/app"
          aria-label="StudentHub command home"
        >
          <span className="w-7 h-7 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-black">
            SH
          </span>
          <strong className="text-sm text-foreground">StudentHub</strong>
        </Link>

        <nav className="flex flex-col gap-0.5 p-2" aria-label="Workspace navigation">
          {data.navigation.map((item) => (
            <Link
              className={cn(
                buttonVariants({ variant: "ghost" }),
                "justify-start gap-0.5 no-underline",
                (item.href === hubContext || item.href === "/app") && "bg-[#1f73b7]/10 text-[#1f73b7] hover:bg-[#1f73b7]/15"
              )}
              href={item.href}
              key={item.href}
              title={`${item.label}: ${item.description}`}
            >
              <strong className="text-sm">{item.label}</strong>
              <small className="text-xs text-muted-foreground">{item.description}</small>
            </Link>
          ))}
        </nav>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border p-2">
          <ThemeToggle />
          <form action={logoutAction}>
            <Button variant="ghost" size="sm" type="submit">
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      {/* Mobile nav bar — replaces commandRailFooter mobil */}
      <div className="lg:hidden">
        {/* Content handled by HubContent client component */}
      </div>

      {/* Main content — replaces commandDesk */}
      <HubContentClient
        data={data as any}
        guide={guide as any}
        commands={commands}
        session={session}
        requiredRole={requiredRole}
      />
    </main>
  );
}

// Client-side HubContent import
import { HubContent } from "@/modules/hub/HubContent";

function HubContentClient(props: Parameters<typeof HubContent>[0]) {
  return <HubContent {...props} />;
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

function parseRequiredRole(value: string | string[] | undefined): Role | null {
  const role = Array.isArray(value) ? value[0] : value;
  return role && roles.includes(role as Role) ? (role as Role) : null;
}

type HubData = Awaited<ReturnType<typeof getUnifiedHub>>;

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

function buildRoleGuide(role: Role, data: HubData): RoleGuide {
  const queueValue = (label: string) => data.queues.find((queue) => queue.label.toLowerCase().includes(label))?.value ?? 0;
  const needsReview = queueValue("review");
  const incomplete = queueValue("incomplete");
  const requests = queueValue("request");
  const idReview = queueValue("id");
  const activeCandidates = data.system.find((item) => item.label === "Active candidates")?.value ?? 0;
  const transfers = data.system.find((item) => item.label === "Transfers")?.value ?? 0;

  const guides: Record<Role, RoleGuide> = {
    admin: {
      title: "Run StudentHub from clear workflows, not scattered tables.",
      description:
        "Pick the job you are trying to finish: approve candidates, operate hiring demand, clear employer accounts, or reconcile money. Search is still here, but it is no longer the whole product.",
      guardrail:
        "Admin sees system-wide records. Candidate, staff, and company accounts should still enter through their own credentials, not through an admin identity switcher.",
      primary: { label: "Start with candidate approvals", href: "/admin/candidates" },
      journeys: [
        {
          kicker: `${needsReview.toLocaleString("en-US")} waiting`,
          title: "Candidate readiness",
          description: "Move a person from signup into a usable, job-ready profile.",
          steps: ["Review profile and documents", "Fix missing readiness data", "Approve or return for completion"],
          href: "/admin/candidates",
          action: "Open candidate queue"
        },
        {
          kicker: `${requests.toLocaleString("en-US")} requests`,
          title: "Hiring pipeline",
          description: "Go from employer demand to a shortlist that staff can act on.",
          steps: ["Open the request", "Review matched candidates", "Send shortlist and CV pack"],
          href: "/admin/requests",
          action: "Open requests"
        },
        {
          kicker: `${transfers.toLocaleString("en-US")} transfers`,
          title: "Finance and payouts",
          description: "Track time, candidate pay, employer charges, and invoice-ready transfer records.",
          steps: ["Review transfer batch", "Check candidate payouts", "Prepare employer invoice PDF"],
          href: "/admin/transfers",
          action: "Open finance"
        },
        {
          kicker: `${idReview.toLocaleString("en-US")} ID batches`,
          title: "Compliance",
          description: "Keep identity and civil ID review separate from day-to-day placement work.",
          steps: ["Review pending ID batches", "Resolve document status", "Return clean candidates to the pipeline"],
          href: "/app?scope=compliance",
          action: "Open compliance"
        }
      ]
    },
    staff: {
      title: "Work your placements from request to shortlist to candidate follow-up.",
      description:
        "This workspace should feel like a daily operating desk: assigned demand first, candidate readiness second, then communication and CV/PDF actions from the record.",
      guardrail: "Staff only sees assigned requests and candidates connected to their staff account.",
      primary: { label: "Open my requests", href: "/staff/requests" },
      journeys: [
        {
          kicker: "Demand",
          title: "Fill a position",
          description: "Start with the employer request, then work candidates against that specific need.",
          steps: ["Open assigned request", "Review matching candidates", "Send employer shortlist"],
          href: "/staff/requests",
          action: "Open request desk"
        },
        {
          kicker: `${incomplete.toLocaleString("en-US")} incomplete`,
          title: "Prepare candidates",
          description: "Make profiles usable before they are sent to employers.",
          steps: ["Find incomplete profile", "Check work history and notes", "Export/share CV when ready"],
          href: "/staff/candidates?filter=incomplete",
          action: "Open candidate desk"
        },
        {
          kicker: "Follow-up",
          title: "Candidate communication",
          description: "Use the candidate record as the action surface for calls, email, notes, and placement history.",
          steps: ["Open candidate", "Review notes and assignments", "Contact or update status"],
          href: "/staff/candidates",
          action: "Find candidates"
        }
      ]
    },
    candidate: {
      title: "Build your profile, get matched, track work, and understand pay.",
      description:
        "A candidate should not land in an admin database. The path is profile readiness, invitations, work logs, then payment visibility.",
      guardrail: "Candidate login only exposes the signed-in candidate profile, invitations, and work history.",
      primary: { label: "Continue my profile", href: "/candidate" },
      journeys: [
        {
          kicker: "Profile",
          title: "Become job-ready",
          description: "Finish the details employers and staff need before sending you to a role.",
          steps: ["Check personal profile", "Complete missing fields", "Confirm documents"],
          href: "/candidate",
          action: "Open my profile"
        },
        {
          kicker: "Jobs",
          title: "Review invitations",
          description: "See the roles and requests sent to your account.",
          steps: ["Open invitation", "Review company and role", "Respond or follow up"],
          href: "/candidate/invitations",
          action: "Open invitations"
        },
        {
          kicker: "Work",
          title: "Track hours and pay",
          description: "Check imported shifts, timer records, and work history connected to payment.",
          steps: ["Open work logs", "Review shift history", "Confirm payment context"],
          href: "/candidate/work-logs",
          action: "Open work logs"
        }
      ]
    },
    company: {
      title: "Request staff, review candidates, and keep hiring paperwork together.",
      description:
        "Company users should start from hiring demand, not from a mixed database. Requests become the home for shortlists, CVs, status, and invoice context.",
      guardrail: "Company login only exposes linked companies and requests for that company contact.",
      primary: { label: "Open hiring requests", href: "/company/requests" },
      journeys: [
        {
          kicker: "Hiring",
          title: "Request candidates",
          description: "Create and manage demand by company, position, seats, and status.",
          steps: ["Open request", "Review proposed candidates", "Confirm next step with staff"],
          href: "/company/requests",
          action: "Open requests"
        },
        {
          kicker: "Account",
          title: "Company profile",
          description: "Keep employer identity, contacts, stores, and hiring access clean.",
          steps: ["Review company details", "Check linked locations", "Confirm hiring approval"],
          href: "/company/companies",
          action: "Open company profile"
        }
      ]
    },
    inspector: {
      title: "Clear identity review without mixing it into placement work.",
      description: "Inspector accounts should move through civil ID batches, candidate lists, and document status quickly.",
      guardrail: "Inspector login only exposes ID review queues.",
      primary: { label: "Open ID requests", href: "/inspector/id-requests" },
      journeys: [
        {
          kicker: `${idReview.toLocaleString("en-US")} pending`,
          title: "Civil ID review",
          description: "Work each imported batch from candidate list to resolved document status.",
          steps: ["Open pending batch", "Review candidates", "Mark review outcome"],
          href: "/inspector/id-requests",
          action: "Open ID queue"
        }
      ]
    }
  };

  if (role === "admin" && activeCandidates) {
    guides.admin.journeys[0] = {
      ...guides.admin.journeys[0],
      description: `${activeCandidates.toLocaleString("en-US")} active candidates exist, but the useful path starts by clearing what blocks placement.`
    };
  }

  return guides[role];
}

function buildCommands(data: Awaited<ReturnType<typeof getUnifiedHub>>): HubCommand[] {
  const commands: HubCommand[] = [];

  for (const item of data.navigation) {
    const shortcut = item.href === "/app" ? "G H" : item.label.toLowerCase().includes("request") ? "G R" : item.label.toLowerCase().includes("candidate") || item.label.toLowerCase().includes("company") ? "G C" : undefined;
    commands.push({
      id: `nav-${item.href}`,
      title: item.label,
      subtitle: item.description,
      section: "Navigation",
      href: item.href,
      shortcut
    });
  }

  for (const scope of data.scopes) {
    const params = new URLSearchParams();
    params.set("scope", scope.value);
    if (data.query) params.set("q", data.query);
    commands.push({
      id: `scope-${scope.value}`,
      title: `Search ${scope.label}`,
      subtitle: scope.label,
      section: "Search scopes",
      href: `/app?${params.toString()}`,
      shortcut: scope.value === "all" ? "S A" : undefined
    });
  }

  for (const queue of data.queues) {
    if (queue.href) {
      commands.push({
        id: `queue-${queue.label}`,
        title: queue.label,
        subtitle: `${queue.value.toLocaleString("en-US")} ${queue.note}`,
        section: "Live queues",
        href: queue.href
      });
    }
  }

  for (const result of data.results) {
    commands.push({
      id: `result-${result.id}`,
      title: result.title,
      subtitle: result.meta,
      section: "Recent results",
      href: hubRecordHref(data.query, data.scope, result.id)
    });
  }

  return commands;
}
