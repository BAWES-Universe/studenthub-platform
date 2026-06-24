"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Users, Building2, Briefcase, Star } from "lucide-react";

// ── Stat definitions ───────────────────────────────────────────

const SH_BLUE = "#1f73b7";
const SH_CORAL = "#eb6651";

interface StatItem {
  value: string;
  label: string;
  suffix: string;
  numericValue: number;
  icon: typeof Users;
  accent?: "info" | "amber";
}

const stats: StatItem[] = [
  {
    value: "9,500",
    label: "Placements",
    suffix: "+",
    numericValue: 9500,
    icon: Briefcase,
    accent: "info",
  },
  {
    value: "500",
    label: "Employers",
    suffix: "+",
    numericValue: 500,
    icon: Building2,
    accent: "info",
  },
  {
    value: "53,000",
    label: "Candidates",
    suffix: "+",
    numericValue: 53000,
    icon: Users,
    accent: "info",
  },
  {
    value: "4.8",
    label: "Platform rating",
    suffix: "",
    numericValue: 48,
    icon: Star,
    accent: "amber",
  },
];

// ── Animated counter hook ──────────────────────────────────────

function useCountUp(target: number, duration: number, started: boolean) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!started) return;
    let startTime: number | null = null;
    let animationId: number;

    const step = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * target));
      if (progress < 1) {
        animationId = requestAnimationFrame(step);
      }
    };

    animationId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animationId);
  }, [target, duration, started]);

  return count;
}

// ── Individual animated stat ───────────────────────────────────

function AnimatedStat({ stat, visible }: { stat: StatItem; visible: boolean }) {
  const count = useCountUp(stat.numericValue, 1800, visible);
  const Icon = stat.icon;

  const displayValue = (raw: number) => {
    if (stat.accent === "amber") {
      const whole = Math.floor(raw / 10);
      const decimal = raw % 10;
      return `${whole}.${decimal}`;
    }
    return raw.toLocaleString();
  };

  const accentColor = stat.accent === "amber" ? SH_CORAL : SH_BLUE;

  return (
    <div className="flex flex-col items-center gap-2 group">
      {/* Icon */}
      <div
        className="size-10 rounded-xl flex items-center justify-center transition-all duration-300 group-hover:scale-110"
        style={{
          backgroundColor: `${accentColor}12`,
          color: accentColor,
        }}
      >
        <Icon className="size-5" aria-hidden="true" />
      </div>

      {/* Counter */}
      <div
          className="text-[clamp(28px,3.5vw,44px)] font-black tracking-tight leading-none"
          style={{ opacity: visible ? 1 : 0, transition: "opacity 300ms ease" }}
      >
        <span style={{ color: accentColor }}>
          {visible ? `${displayValue(count)}${stat.suffix}` : "—"}
        </span>
      </div>

      {/* Label */}
      <div
        className="text-xs font-medium text-center leading-tight"
        style={{ color: "var(--muted)" }}
      >
        {stat.label}
      </div>
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────

export interface StatsSectionProps {
  className?: string;
}

// ── Component ──────────────────────────────────────────────────

export default function StatsSection({ className }: StatsSectionProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className={cn("scroll-mt-20", className)}
      aria-label="Platform statistics"
    >
      <div
        className="relative rounded-xl p-[clamp(24px,4vw,48px)] overflow-hidden bg-card border border-border shadow-sm"
      >
        {/* Subtle ambient glow */}
        <div
          className="absolute -top-24 -right-24 size-64 rounded-full opacity-[0.04] pointer-events-none"
          style={{
            background: `radial-gradient(circle, ${SH_BLUE}, transparent 70%)`,
          }}
          aria-hidden="true"
        />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-6 relative z-[1]">
          {stats.map((stat, i) => (
            <div
              key={stat.label}
              style={{
                animation: `shCardIn 500ms cubic-bezier(0.16, 1, 0.3, 1) both`,
                animationDelay: `${i * 120}ms`,
              }}
            >
              <AnimatedStat stat={stat} visible={visible} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
