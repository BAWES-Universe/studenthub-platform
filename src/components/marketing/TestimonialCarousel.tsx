"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, Star } from "lucide-react";
import { cn } from "@/lib/utils";

const SH_BLUE = "#1f73b7";
const SH_CORAL = "#eb6651";

// ── Types ────────────────────────────────────────────────

export interface Testimonial {
  quote: string;
  name: string;
  title: string;
  company: string;
  avatar: string;
  rating: number;
}

export type TestimonialPersona = "candidate" | "company";

// ── Persona-tuned testimonials ───────────────────────────

const candidateTestimonials: Testimonial[] = [
  {
    quote:
      "StudentHub matched me with a role I wouldn't have found anywhere else. My profile was visible to 60+ employers within 24 hours — and I had three interview requests by the end of the week.",
    name: "Aisha M.",
    title: "Care Assistant",
    company: "Placed via StudentHub",
    avatar: "AM",
    rating: 5,
  },
  {
    quote:
      "The timesheet and payment system is seamless. I log my hours on my phone, my manager approves in seconds, and the money hits my account on payday.",
    name: "James K.",
    title: "Support Worker",
    company: "Placed via StudentHub",
    avatar: "JK",
    rating: 5,
  },
  {
    quote:
      "I went from registering to shortlisted in 6 hours. The application tracking showed me exactly where I stood at every step — no black hole applications here.",
    name: "Priya R.",
    title: "Senior Care Assistant",
    company: "Placed via StudentHub",
    avatar: "PR",
    rating: 5,
  },
  {
    quote:
      "StudentHub saved me hours every week. Instead of visiting 5 different agency websites, I have one profile that all employers can see.",
    name: "Daniel O.",
    title: "Healthcare Worker",
    company: "Placed via StudentHub",
    avatar: "DO",
    rating: 4,
  },
];

const companyTestimonials: Testimonial[] = [
  {
    quote:
      "Posting openings on StudentHub gets us matched candidates within 48 hours, not weeks. The timesheet approval workflow alone saved our HR team 10 hours a week.",
    name: "Noura A.",
    title: "HR Manager",
    company: "Kuwait City Medical Group",
    avatar: "NA",
    rating: 5,
  },
  {
    quote:
      "We get consolidated invoices per branch instead of chasing paper across 12 locations. The difference in month-end close is night and day.",
    name: "Fahad M.",
    title: "Finance Director",
    company: "Premier Healthcare KW",
    avatar: "FM",
    rating: 5,
  },
  {
    quote:
      "Staff-matched candidates are surprisingly accurate. We hired three staff members in the first week — all matched by our recruiters, all still with us 6 months on.",
    name: "Layla A.",
    title: "Operations Director",
    company: "BrightCare Kuwait",
    avatar: "LA",
    rating: 5,
  },
  {
    quote:
      "Compliance tracking used to be a spreadsheet nightmare. Now I get auto-notifications when certifications are about to expire — no more last-minute surprises.",
    name: "Bader R.",
    title: "Compliance Officer",
    company: "Al-Mana Group",
    avatar: "BR",
    rating: 4,
  },
];

/** Shuffle array using Fisher-Yates */
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Mixed testimonials — employer + candidate perspectives together */
const mixedTestimonials: Testimonial[] = shuffleArray([
  ...candidateTestimonials,
  ...companyTestimonials,
]);

const personaTestimonials: Record<TestimonialPersona, Testimonial[]> = {
  candidate: mixedTestimonials,
  company: companyTestimonials,
};

// ── Props ────────────────────────────────────────────────

export interface TestimonialCarouselProps {
  persona?: TestimonialPersona;
  testimonials?: Testimonial[];
  autoRotateInterval?: number;
  className?: string;
}

// ── Component ────────────────────────────────────────────

export default function TestimonialCarousel({
  persona = "candidate",
  testimonials: customTestimonials,
  autoRotateInterval = 5000,
  className,
}: TestimonialCarouselProps) {
  const items = customTestimonials ?? personaTestimonials[persona];
  const [active, setActive] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const next = useCallback(() => {
    setActive((prev) => (prev + 1) % items.length);
  }, [items.length]);

  const prev = useCallback(() => {
    setActive((prev) => (prev - 1 + items.length) % items.length);
  }, [items.length]);

  // Auto-rotate
  useEffect(() => {
    if (isPaused || items.length <= 1) return;
    const id = setInterval(next, autoRotateInterval);
    return () => clearInterval(id);
  }, [isPaused, next, autoRotateInterval, items.length]);

  if (items.length === 0) return null;

  const t = items[active];

  return (
    <section
      className={cn("scroll-mt-20", className)}
      aria-label="Customer testimonials"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="text-center mb-8 md:mb-10">
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold tracking-wide mb-5"
          style={{ background: `linear-gradient(135deg, ${SH_BLUE}12, ${SH_BLUE}06)` }}
        >
          {persona === "company"
            ? "Trusted by leading employers"
            : "Trusted by candidates and employers"}
        </span>
        <h2 className="text-[clamp(24px,3.5vw,36px)] font-bold leading-[1.15] tracking-[-0.02em] text-foreground mt-3">
          {persona === "company"
            ? "Employers that found their team."
            : "Real stories from real placements."}
        </h2>
      </div>

      <div className="relative mx-auto max-w-[720px]">
        {/* Navigation arrows */}
        <button
          onClick={prev}
          className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-3 z-10 size-9 rounded-full flex items-center justify-center transition-all duration-200 hover:scale-110 max-sm:hidden bg-card border border-border shadow-sm text-muted-foreground hover:text-foreground"
          aria-label="Previous testimonial"
        >
          <ChevronLeft className="size-4" />
        </button>

        <button
          onClick={next}
          className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-3 z-10 size-9 rounded-full flex items-center justify-center transition-all duration-200 hover:scale-110 max-sm:hidden bg-card border border-border shadow-sm text-muted-foreground hover:text-foreground"
          aria-label="Next testimonial"
        >
          <ChevronRight className="size-4" />
        </button>

        {/* Testimonial card — solid */}
        <div
          key={active}
          className="relative rounded-xl p-8 md:p-10 text-center overflow-hidden bg-card border border-border shadow-sm"
          style={{
            animation: "shLandingFadeIn 400ms ease",
          }}
        >
          {/* Decorative quote mark */}
          <div
            className="text-[72px] leading-none font-serif text-muted-foreground/20 absolute top-4 left-6 select-none"
            aria-hidden="true"
          >
            &ldquo;
          </div>

          <blockquote className="text-[clamp(16px,1.8vw,20px)] leading-relaxed mb-6 font-medium relative z-[1] text-foreground">
            &ldquo;{t.quote}&rdquo;
          </blockquote>

          {/* Star rating */}
          <div
            className="flex items-center justify-center gap-1 mb-4"
            aria-label={`${t.rating} out of 5 stars`}
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className="size-4"
                style={{
                  color: i < t.rating ? SH_CORAL : "var(--border)",
                  fill: i < t.rating ? SH_CORAL : "transparent",
                }}
              />
            ))}
          </div>

          {/* Author */}
          <div className="flex items-center justify-center gap-3">
            <div
              className="size-9 rounded-full flex items-center justify-center text-xs font-bold text-white"
              style={{ backgroundColor: SH_BLUE }}
            >
              {t.avatar}
            </div>
            <div className="text-left">
              <strong className="block text-sm text-foreground">
                {t.name}
              </strong>
              <span className="text-xs text-muted-foreground">
                {t.title} — {t.company}
              </span>
            </div>
          </div>
        </div>

        {/* Dots */}
        <div className="flex items-center justify-center gap-2 mt-4">
          {items.map((_, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className="rounded-full transition-all duration-300"
              style={{
                height: 8,
                backgroundColor:
                  i === active ? SH_BLUE : "var(--border)",
                width: i === active ? 24 : 8,
              }}
              aria-label={`Go to testimonial ${i + 1}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
