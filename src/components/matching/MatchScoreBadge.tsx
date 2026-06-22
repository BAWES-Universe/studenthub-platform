import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// MatchScoreBadge — color-coded match percentage indicator
// ---------------------------------------------------------------------------
// Shows a numeric score with a visual bar and color that reflects quality:
//   75+     → gold  (strong)
//   50–74   → green (moderate)
//   25–49   → blue  (low)
//    0–24   → gray  (weak)
//   null    → gray  (not scored)
// ---------------------------------------------------------------------------

type Props = {
  score: number | null;
  /** Optional label prefix (default "Match") */
  label?: string;
  /** Show detail bar below the score (default true) */
  showBar?: boolean;
};

const SCORE_COLORS: Record<string, { text: string; bg: string; bar: string }> = {
  strong: { text: "text-yellow-600", bg: "bg-yellow-100", bar: "#eab308" },
  moderate: { text: "text-green-600", bg: "bg-green-100", bar: "#16a34a" },
  low: { text: "text-blue-600", bg: "bg-blue-100", bar: "#2563eb" },
  weak: { text: "text-muted-foreground", bg: "bg-transparent", bar: "#9ca3af" },
};

function scoreConfig(score: number | null) {
  if (score === null) return { ...SCORE_COLORS.weak, label: "Not scored" };
  if (score >= 75) return { ...SCORE_COLORS.strong, label: "Strong match" };
  if (score >= 50) return { ...SCORE_COLORS.moderate, label: "Moderate" };
  if (score >= 25) return { ...SCORE_COLORS.low, label: "Low" };
  return { ...SCORE_COLORS.weak, label: "Weak" };
}

export default function MatchScoreBadge({
  score,
  label = "Match",
  showBar = true,
}: Props) {
  const config = scoreConfig(score);

  return (
    <Badge
      variant="outline"
      className={`inline-flex items-center gap-2 px-2.5 py-1 text-xs font-semibold rounded-full ${config.bg} ${config.text} border-transparent`}
      title={`${label}: ${score ?? "N/A"} — ${config.label}`}
      data-testid="match-score-badge"
    >
      {/* Score number */}
      <span className={`min-w-[28px] text-right ${config.text}`}>
        {score !== null ? `${score}%` : "—"}
      </span>

      {/* Progress bar */}
      {showBar && score !== null && (
        <svg width="40" height="6" viewBox="0 0 40 6" aria-hidden="true">
          <rect x="0" y="0" width="40" height="6" rx="3" fill="#e5e7eb" />
          <rect
            x="0"
            y="0"
            width={Math.min(Math.max((score / 100) * 40, 2), 40)}
            height="6"
            rx="3"
            fill={config.bar}
          />
        </svg>
      )}

      {/* Status label */}
      {score !== null && (
        <span className="text-muted-foreground font-normal">
          {config.label}
        </span>
      )}
    </Badge>
  );
}
