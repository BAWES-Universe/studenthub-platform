"use client";

import { useEffect } from "react";

/**
 * Global error boundary — catches errors thrown in the root layout itself.
 *
 * Next.js App Router distinguishes two error boundaries at the root:
 *  - error.tsx       — catches errors in the root layout's children
 *  - global-error.tsx — catches errors in the root LAYOUT (e.g. ThemeScript,
 *                        TooltipProvider, Toaster). Because it replaces the
 *                        entire <html> document, it must include its own
 *                        <html> and <body> tags.
 *
 * This component is self-contained — no external imports from the app's
 * component library since the layout context that provides them is what
 * crashed. Uses Tailwind utility classes only.
 */

export default function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Global error boundary caught:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="m-0">
        <div
          className="fixed inset-0 grid place-items-center overflow-hidden"
          style={{ background: "#0b0d11", color: "#e8eaed", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}
        >
          {/* Decorative gradient blobs */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(59, 130, 246, 0.15), transparent), radial-gradient(ellipse 50% 40% at 80% 100%, rgba(139, 92, 246, 0.1), transparent)",
            }}
            aria-hidden="true"
          />

          <div className="relative z-10 text-center p-8 max-w-[480px]">
            <h1
              className="text-6xl font-black leading-none m-0 mb-2"
              style={{
                background: "linear-gradient(135deg, #60a5fa, #a78bfa)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              500
            </h1>
            <h2 className="text-xl font-bold m-0 mb-3" style={{ color: "#f1f5f9" }}>
              Something went wrong
            </h2>
            <p className="text-sm m-0 mb-4 leading-relaxed break-words" style={{ color: "#94a3b8" }}>
              {error.message || "An unexpected error occurred."}
            </p>
            {error.digest ? (
              <p className="text-xs mb-6" style={{ color: "#64748b" }}>
                Reference:{" "}
                <code
                  className="px-1.5 py-0.5 rounded text-xs"
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                  }}
                >
                  {error.digest}
                </code>
              </p>
            ) : null}

            <div className="flex gap-3 justify-center flex-wrap">
              <button
                onClick={reset}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer border-none no-underline transition-all duration-150"
                style={{ background: "#2563eb", color: "#fff" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#1d4ed8")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#2563eb")}
              >
                Try again
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer no-underline transition-all duration-150"
                style={{
                  background: "rgba(255,255,255,0.08)",
                  color: "#e2e8f0",
                  border: "1px solid rgba(255,255,255,0.1)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
              >
                Go home
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
