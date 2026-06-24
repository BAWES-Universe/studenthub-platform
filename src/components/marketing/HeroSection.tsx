"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  GraduationCap,
  Building2,
  Search,
  CheckCircle2,
  Sparkles,
  Star,
} from "lucide-react";

// ── Staff-matched platform hero ────────────────────────────────

const SH_BLUE = "#1f73b7";
const SH_CORAL = "#eb6651";

const heroContent = {
  eyebrow: "Staff-matched student placements",
  headline: "Connecting students with the right employers",
  subhead:
    "The platform where students build careers and employers discover vetted talent. Our staff recruiters match students with the right employers — no algorithms.",
  studentCta: "Create your free profile",
  studentCtaHref: "/signup?role=candidate",
  employerCta: "Hire students",
  employerCtaHref: "/signup?role=company",
  proof: "9,500+ placements · 500+ employers · 4.8★ platform rating",
  studentBenefits: [
    "Profile visible to employers across Kuwait",
    "Staff-matched role suggestions",
    "One-tap timesheets and payments",
  ],
  employerBenefits: [
    "Staff-matched candidate suggestions",
    "Real-time timesheet approvals",
    "Consolidated monthly invoicing",
  ],
};

// ── Props ──────────────────────────────────────────────────────

export interface HeroSectionProps {
  onCtaClick?: () => void;
}

// ── Component ──────────────────────────────────────────────────

export default function HeroSection({ onCtaClick }: HeroSectionProps) {
  const content = heroContent;

  return (
    <section
      className="relative overflow-hidden rounded-2xl min-h-[min(700px,calc(100svh_-_90px))] grid grid-cols-1 lg:grid-cols-[1fr_440px] items-center gap-0 bg-card border border-border shadow-sm"
      aria-label="StudentHub — connecting students with the right employers"
    >
      {/* Subtle grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.02] pointer-events-none"
        aria-hidden="true"
        style={{
          backgroundImage:
            "radial-gradient(circle, currentColor 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          color: "var(--ink)",
        }}
      />

      {/* Dual ambient glows */}
      <div
        className="absolute -top-32 -left-32 size-96 rounded-full opacity-[0.06] pointer-events-none"
        aria-hidden="true"
        style={{
          background: `radial-gradient(circle, ${SH_BLUE}, transparent 70%)`,
        }}
      />
      <div
        className="absolute -bottom-32 -right-32 size-80 rounded-full opacity-[0.04] pointer-events-none"
        aria-hidden="true"
        style={{
          background: `radial-gradient(circle, ${SH_CORAL}, transparent 70%)`,
        }}
      />

      {/* ── Left Column: Copy ─────────────────────────────── */}
      <div className="relative z-[2] p-[clamp(28px,5vw,60px)] max-lg:pb-0">
        {/* Eyebrow badge */}
        <div
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold tracking-wide mb-5"
          style={{
            color: SH_BLUE,
            backgroundColor: `${SH_BLUE}15`,
          }}
        >
          <Sparkles className="size-3" />
          {content.eyebrow}
        </div>

        {/* Headline — tighter tracking for premium feel */}
        <h1 className="text-[clamp(32px,5vw,56px)] font-bold leading-[1.05] tracking-[-0.03em] mb-4 text-foreground">
          {content.headline}
        </h1>

        {/* Subhead */}
        <p className="text-[clamp(15px,1.6vw,17px)] leading-relaxed max-w-[540px] mb-6 text-muted-foreground">
          {content.subhead}
        </p>

        {/* Two CTAs */}
        <div className="flex flex-wrap items-center gap-3 max-sm:flex-col max-sm:items-stretch mb-5">
          {onCtaClick ? (
            <button
              onClick={onCtaClick}
              className="inline-flex items-center gap-1.5 min-h-[42px] px-5 rounded-xl text-sm font-bold text-white transition-all duration-200 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 shadow-md"
              style={{
                backgroundColor: SH_BLUE,
                boxShadow: `0 4px 14px ${SH_BLUE}40`,
              }}
            >
              <GraduationCap className="size-4" />
              {content.studentCta}{" "}
              <ArrowUpRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </button>
          ) : (
            <Link
              href={{ pathname: "/signup", query: { role: "candidate" } }}
              className="inline-flex items-center gap-1.5 min-h-[42px] px-5 rounded-xl text-sm font-bold text-white transition-all duration-200 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 shadow-md group"
              style={{
                backgroundColor: SH_BLUE,
                boxShadow: `0 4px 14px ${SH_BLUE}40`,
              }}
            >
              <GraduationCap className="size-4" />
              {content.studentCta}{" "}
              <ArrowUpRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
          )}
          <Link
            href={{ pathname: "/signup", query: { role: "company" } }}
            className="inline-flex items-center gap-1.5 min-h-[42px] px-5 rounded-xl text-sm font-bold text-white transition-all duration-200 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 shadow-md group"
            style={{
              backgroundColor: SH_CORAL,
              boxShadow: `0 4px 14px ${SH_CORAL}50`,
            }}
          >
            <Building2 className="size-4" />
            {content.employerCta}{" "}
            <ArrowUpRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center gap-1 min-h-[42px] px-5 rounded-xl text-sm font-semibold text-muted-foreground border border-border bg-transparent transition-all duration-200 hover:bg-muted/20 hover:text-foreground"
          >
            Sign in
          </Link>
        </div>

        {/* Social proof */}
        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium mb-5 bg-secondary text-muted-foreground">
          <Sparkles className="size-3 shrink-0" style={{ color: SH_CORAL }} />
          {content.proof}
        </div>

        {/* Benefits rows */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
          <div>
            <span
              className="text-[10px] font-bold uppercase tracking-wider mb-1.5 block"
              style={{ color: SH_BLUE }}
            >
              For students
            </span>
            {content.studentBenefits.map((b) => (
              <div key={b} className="flex items-center gap-1.5 py-0.5">
                <CheckCircle2 className="size-3 shrink-0 text-green-600 dark:text-green-400" />
                <span className="text-xs text-muted-foreground">
                  {b}
                </span>
              </div>
            ))}
          </div>
          <div>
            <span
              className="text-[10px] font-bold uppercase tracking-wider mb-1.5 block"
              style={{ color: SH_CORAL }}
            >
              For employers
            </span>
            {content.employerBenefits.map((b) => (
              <div key={b} className="flex items-center gap-1.5 py-0.5">
                <CheckCircle2 className="size-3 shrink-0 text-green-600 dark:text-green-400" />
                <span className="text-xs text-muted-foreground">
                  {b}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right Column: Premium Mockup ──────────────────── */}
      <div className="relative z-[2] flex items-center justify-center p-[clamp(20px,4vw,48px)] max-lg:pt-6 max-lg:pb-10 max-lg:min-h-[340px]">
        <div className="w-full max-w-[420px] rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          {/* Mockup header */}
          <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-border bg-muted/10">
            <div className="size-2.5 rounded-full bg-red-500" />
            <div className="size-2.5 rounded-full bg-amber-500" />
            <div className="size-2.5 rounded-full bg-green-500" />
            <span className="ml-2 text-[11px] font-medium text-muted-foreground">
              StudentHub — Staff-matched roles
            </span>
          </div>

          {/* Mockup body */}
          <div className="p-3 grid gap-2.5 bg-card">
            {/* Search bar */}
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{
                backgroundColor: `${SH_BLUE}08`,
                color: "var(--muted)",
                border: "1px solid var(--border)",
              }}
            >
              <Search className="size-3.5 shrink-0" />
              Search open roles, companies, locations...
              <span
                className="ml-auto text-[10px] px-1.5 py-0.5 rounded font-mono bg-card border border-border"
              >
                ⌘K
              </span>
            </div>

            {/* Result card */}
            <div
              className="rounded-xl p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
              style={{
                background: `linear-gradient(135deg, ${SH_BLUE}10, ${SH_BLUE}04)`,
                border: `1px solid ${SH_BLUE}20`,
              }}
            >
              {/* Match tag */}
              <div className="flex items-center justify-between mb-2">
                <span
                  className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: SH_BLUE }}
                >
                  Matched roles
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full text-green-600 dark:text-green-400" style={{ backgroundColor: `#24835b12` }}>
                  <CheckCircle2 className="size-2.5" />
                  Profile ready
                </span>
              </div>

              <strong className="block text-[clamp(32px,5vw,48px)] leading-[0.9] mt-1 font-black tracking-tight text-foreground">
                care assistant
              </strong>
              <span className="text-xs block mt-1 text-muted-foreground">
                12 matching roles · Kuwait City · KWD 3-5/hr
              </span>

              <div className="flex gap-2 mt-3">
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full"
                  style={{
                    color: SH_BLUE,
                    backgroundColor: `${SH_BLUE}12`,
                  }}
                >
                  <CheckCircle2 className="size-2.5" />
                  3 saved roles
                </span>
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full"
                  style={{
                    color: SH_CORAL,
                    backgroundColor: `${SH_CORAL}12`,
                  }}
                >
                  <Star className="size-2.5" />
                  Top match
                </span>
              </div>
            </div>

            {/* Side-by-side stats cards */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "Profile", value: "92%" },
                { label: "Applications", value: "4" },
                { label: "Payment", value: "420 KWD" },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-xl p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  style={{
                    backgroundColor: `${SH_BLUE}06`,
                    border: "1px solid var(--border)",
                  }}
                >
                  <span className="text-[9px] font-bold uppercase tracking-wider block text-muted-foreground">
                    {item.label}
                  </span>
                  <strong className="text-sm block mt-0.5 text-foreground">
                    {item.value}
                  </strong>
                </div>
              ))}
            </div>

            {/* Employer tab note */}
            <div
              className="flex items-center gap-2 p-3 rounded-xl text-xs"
              style={{
                background: `linear-gradient(135deg, ${SH_CORAL}0A, ${SH_CORAL}04)`,
                border: `1px solid ${SH_CORAL}15`,
                color: SH_CORAL,
              }}
            >
              <Building2 className="size-3.5 shrink-0" />
              <span className="font-medium">Employer view:</span>
              <span className="text-muted-foreground">
                Post jobs, review candidates, approve timesheets
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
