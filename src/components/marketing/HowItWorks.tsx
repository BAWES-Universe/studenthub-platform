"use client";

import { UserRound, Search, Briefcase } from "lucide-react";

// ── Step definitions ──────────────────────────────────────────

interface Step {
  icon: typeof UserRound;
  title: string;
  body: string;
  number: number;
  tag: string;
}

const steps: Step[] = [
  {
    icon: UserRound,
    number: 1,
    title: "Create your profile",
    tag: "3 minutes · No CV needed",
    body: "Tell us about your skills, experience, and preferences. One profile makes you visible to every employer on the platform — no need to sign up for multiple agencies.",
  },
  {
    icon: Search,
    number: 2,
    title: "Get matched",
    tag: "Staff-powered matching",
    body: "Our staff recruiters match you with relevant openings across employers. Get alerted the moment a role fits your profile, and apply in one click.",
  },
  {
    icon: Briefcase,
    number: 3,
    title: "Get hired",
    tag: "Fast placement",
    body: "One-click apply, real-time tracking, and direct communication with employers. Timesheets, payments, and compliance — all on one platform.",
  },
];

// ── Props ──────────────────────────────────────────────────────

export interface HowItWorksProps {
  className?: string;
}

// ── Component ──────────────────────────────────────────────────

const cardAnimationDelay = (i: number): React.CSSProperties => ({
  animationDelay: `${i * 120}ms`,
});

export default function HowItWorks({ className }: HowItWorksProps) {
  return (
    <section
      className={`scroll-mt-20 ${className ?? ""}`}
      aria-label="How it works"
    >
      <div className="text-center mb-8 md:mb-10">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold tracking-wide text-[#1f73b7] bg-[#1f73b7]/10">How it works</span>
        <div className="mt-3" />
        <h2 className="text-[clamp(24px,3.5vw,36px)] font-bold leading-[1.15] tracking-[-0.02em] text-foreground mt-3">
          From profile to placement in three steps.
        </h2>
        <p className="text-sm leading-relaxed max-w-[600px] mx-auto text-muted-foreground mt-2">
          Whether you&apos;re a student looking for work or an employer hiring
          talent, our staff recruiters match students with the right employers
          — all on one platform.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-[960px] mx-auto">
        {steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <div
              key={step.title}
              className="relative flex flex-col items-center text-center p-6 rounded-xl bg-card border border-border shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
              style={cardAnimationDelay(i)}
            >
              {/* Step number */}
              <div className="size-9 rounded-full flex items-center justify-center text-xs font-black mb-4 bg-[#1f73b7]/10 text-[#1f73b7]">
                {step.number}
              </div>

              {/* Icon */}
              <div className="size-12 rounded-xl flex items-center justify-center mb-3 bg-[#1f73b7]/5 text-[#1f73b7]">
                <Icon className="size-6" aria-hidden="true" />
              </div>

              {/* Tag */}
              <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full mb-3 bg-secondary text-muted-foreground">
                {step.tag}
              </span>

              <strong className="block text-base mb-2 tracking-tight text-foreground">
                {step.title}
              </strong>
              <p className="text-xs leading-relaxed m-0 max-w-[280px] text-muted-foreground">
                {step.body}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
