import Link from "next/link";
import { redirect } from "next/navigation";
import { UserRound, Search, Building2, Shield, ClipboardCheck } from "lucide-react";
import { getSession } from "@/modules/auth/session";
import { LoginForm } from "@/modules/auth/LoginForm";
import { ThemeToggle } from "@/modules/theme/ThemeToggle";

export const dynamic = "force-dynamic";

const roleNotes = [
  { icon: UserRound, label: "Students", detail: "Profile, jobs, hours, pay" },
  { icon: Search, label: "Staff", detail: "Requests, candidates, CVs, time" },
  { icon: Building2, label: "Companies", detail: "Requests, candidates, invoices" },
  { icon: Shield, label: "Admin", detail: "Finance, approvals, migration" },
  { icon: ClipboardCheck, label: "Inspectors", detail: "ID review, document queues" }
];

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/app");
  const params = await searchParams;

  return (
    <main className="min-h-svh w-[min(1160px,calc(100%_-_28px))] mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(400px,500px)] content-start items-start gap-4 pt-[18px] pb-[42px] max-sm:w-[min(calc(100%_-_20px),720px)]">
      {/* Nav - spans full width */}
      <nav
        className="col-span-full sticky top-3 z-20 min-h-[62px] flex items-center justify-between gap-3.5 border border-[color-mix(in_srgb,var(--border)_84%,transparent)] rounded-lg bg-[color-mix(in_srgb,var(--card)_92%,transparent)] p-2 shadow-[0_18px_50px_rgba(16,24,40,0.08)] max-sm:static max-sm:flex-col max-sm:items-stretch"
        aria-label="StudentHub login navigation"
      >
        <Link
          className="inline-flex items-center gap-2.5 text-foreground px-2 no-underline"
          href="/"
        >
          <span className="size-9 inline-flex items-center justify-center rounded-lg bg-card text-white font-black">
            SH
          </span>
          <strong>StudentHub</strong>
        </Link>
        <ThemeToggle />
      </nav>

      {/* Intro */}
      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[linear-gradient(135deg,color-mix(in_srgb,#1f73b7_9%,transparent),transparent_48%),var(--card)] p-[clamp(22px,4vw,48px)]">
        <div>
          <p className="text-[#1f73b7] text-[11px] font-black uppercase">One StudentHub login</p>
          <h1 className="mt-0 max-w-[760px] text-[clamp(44px,6.4vw,92px)] leading-[0.94] max-sm:text-[40px]">
            Sign in once. We&rsquo;ll open the right workspace.
          </h1>
          <p className="text-muted-foreground max-w-[620px] leading-relaxed">
            No more guessing whether you are entering as admin, staff, candidate, company, or inspector. Your production
            credentials decide what you can see and do.
          </p>
          <div className="flex flex-wrap gap-2 mt-[18px]">
            {["Production-compatible credentials", "Server-side account detection", "Capability-scoped workspaces"].map(
              (item) => (
                <span
                  key={item}
                  className="min-h-8 inline-flex items-center border border-[var(--border)] rounded-full bg-[color-mix(in_srgb,var(--card)_88%,transparent)] px-3 text-[#1f73b7] text-[11px] font-black uppercase"
                >
                  {item}
                </span>
              )
            )}
          </div>
        </div>
        <Link href="/" className="inline-block mt-4 text-sm no-underline text-muted-foreground hover:text-[#1f73b7]">
          Back to landing
        </Link>
      </section>

      {/* Login panel */}
      <section
        className="self-start border border-border rounded-lg bg-card shadow-[0_30px_90px_rgba(16,24,40,0.16)] dark:border-[var(--border)]"
        aria-label="StudentHub sign in"
      >
        {params.error === "expired" ? (
          <p className="text-destructive font-bold m-0 p-4 pb-0">That verified account choice expired. Sign in again to continue.</p>
        ) : null}
        {params.error === "account" ? (
          <p className="text-destructive font-bold m-0 p-4 pb-0">Choose a verified account to continue.</p>
        ) : null}
        <LoginForm />
      </section>

      {/* Role notes - spans full width */}
      <section className="col-span-full grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5" aria-label="Account detection notes">
        {roleNotes.map(({ icon: Icon, label, detail }) => (
          <article
            key={label}
            className="grid gap-1.5 border-border rounded-lg bg-card p-3.5"
          >
            <Icon className="size-4 text-[#1f73b7] shrink-0" aria-hidden="true" />
            <span className="text-muted-foreground text-xs font-extrabold uppercase">{label}</span>
            <strong className="text-sm">{detail}</strong>
          </article>
        ))}
      </section>
    </main>
  );
}
