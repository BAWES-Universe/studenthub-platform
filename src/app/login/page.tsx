import Link from "next/link";
import { redirect } from "next/navigation";
import { UserRound, Search, Building2, Shield, ClipboardCheck } from "lucide-react";
import { getSession } from "@/modules/auth/session";
import { LoginForm } from "@/modules/auth/LoginForm";
import { ThemeToggle } from "@/modules/theme/ThemeToggle";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
        className="col-span-full sticky top-3 z-20 min-h-[62px] flex items-center justify-between gap-3.5 border border-border/80 rounded-lg bg-card/92 p-2 shadow-[0_18px_50px_rgba(16,24,40,0.08)] max-sm:static max-sm:flex-col max-sm:items-stretch"
        aria-label="StudentHub login navigation"
      >
        <Link
          className="inline-flex items-center gap-2.5 text-foreground px-2 no-underline"
          href="/"
        >
          <span className="size-9 inline-flex items-center justify-center rounded-lg bg-foreground text-card font-black">
            SH
          </span>
          <strong>StudentHub</strong>
        </Link>
        <ThemeToggle />
      </nav>

      {/* Intro */}
      <Card className="overflow-hidden border-border bg-gradient-to-br from-blue-50/50 dark:from-blue-950/10 to-card">
        <CardContent className="p-[clamp(22px,4vw,48px)]">
          <p className="text-blue-600 dark:text-blue-400 text-[11px] font-black uppercase">One StudentHub login</p>
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
                <Badge
                  key={item}
                  variant="outline"
                  className="text-blue-600 dark:text-blue-400 text-[11px] font-black uppercase px-3 py-1.5"
                >
                  {item}
                </Badge>
              )
            )}
          </div>
          <Link href="/" className="inline-block mt-4 text-sm no-underline text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400">
            Back to landing
          </Link>
        </CardContent>
      </Card>

      {/* Login panel */}
      <Card
        className="self-start border-[#c5cfdd] dark:border-border shadow-[0_30px_90px_rgba(16,24,40,0.16)]"
        aria-label="StudentHub sign in"
      >
        {params.error === "expired" ? (
          <p className="text-destructive font-bold m-0 p-4 pb-0">That verified account choice expired. Sign in again to continue.</p>
        ) : null}
        {params.error === "account" ? (
          <p className="text-destructive font-bold m-0 p-4 pb-0">Choose a verified account to continue.</p>
        ) : null}
        <LoginForm />
      </Card>

      {/* Role notes - spans full width */}
      <section className="col-span-full grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5" aria-label="Account detection notes">
        {roleNotes.map(({ icon: Icon, label, detail }) => (
          <Card key={label}>
            <CardContent className="grid gap-1.5 p-3.5">
              <Icon className="size-4 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
              <span className="text-muted-foreground text-xs font-extrabold uppercase">{label}</span>
              <strong className="text-sm text-foreground">{detail}</strong>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
