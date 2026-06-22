1|import { Badge } from "@/components/ui/badge";
2|
3|// ---------------------------------------------------------------------------
4|// MatchScoreBadge — color-coded match percentage indicator
5|// ---------------------------------------------------------------------------
6|// Shows a numeric score with a visual bar and color that reflects quality:
7|//   75+     → gold  (strong)
8|//   50–74   → green (moderate)
9|//   25–49   → blue  (low)
10|//    0–24   → gray  (weak)
11|//   null    → gray  (not scored)
12|// ---------------------------------------------------------------------------
13|
14|type Props = {
15|  score: number | null;
16|  /** Optional label prefix (default "Match") */
17|  label?: string;
18|  /** Show detail bar below the score (default true) */
19|  showBar?: boolean;
20|};
21|
22|<<<<<<< Updated upstream
23|const SCORE_COLORS: Record<"strong" | "moderate" | "low" | "weak", { text: string; bg: string; bar: string }> = {
24|=======
25|const SCORE_COLORS: Record<string, { text: string; bg: string; bar: string }> = {
26|>>>>>>> Stashed changes
27|  strong: { text: "text-yellow-600", bg: "bg-yellow-100", bar: "#eab308" },
28|  moderate: { text: "text-green-600", bg: "bg-green-100", bar: "#16a34a" },
29|  low: { text: "text-blue-600", bg: "bg-blue-100", bar: "#2563eb" },
30|  weak: { text: "text-muted-foreground", bg: "bg-transparent", bar: "#9ca3af" },
31|};
32|
33|function scoreConfig(score: number | null) {
34|  if (score === null) return { ...SCORE_COLORS.weak, label: "Not scored" };
35|  if (score >= 75) return { ...SCORE_COLORS.strong, label: "Strong match" };
36|  if (score >= 50) return { ...SCORE_COLORS.moderate, label: "Moderate" };
37|  if (score >= 25) return { ...SCORE_COLORS.low, label: "Low" };
38|  return { ...SCORE_COLORS.weak, label: "Weak" };
39|}
40|
41|export default function MatchScoreBadge({
42|  score,
43|  label = "Match",
44|  showBar = true,
45|}: Props) {
46|  const config = scoreConfig(score);
47|
48|  return (
49|    <Badge
50|      variant="outline"
51|      className={`inline-flex items-center gap-2 px-2.5 py-1 text-xs font-semibold rounded-full ${config.bg} ${config.text} border-transparent`}
52|      title={`${label}: ${score ?? "N/A"} — ${config.label}`}
53|      data-testid="match-score-badge"
54|    >
55|      {/* Score number */}
56|      <span className={`min-w-[28px] text-right ${config.text}`}>
57|        {score !== null ? `${score}%` : "—"}
58|      </span>
59|
60|      {/* Progress bar */}
61|      {showBar && score !== null && (
62|        <svg width="40" height="6" viewBox="0 0 40 6" aria-hidden="true">
63|          <rect x="0" y="0" width="40" height="6" rx="3" fill="#e5e7eb" />
64|          <rect
65|            x="0"
66|            y="0"
67|            width={Math.min(Math.max((score / 100) * 40, 2), 40)}
68|            height="6"
69|            rx="3"
70|            fill={config.bar}
71|          />
72|        </svg>
73|      )}
74|
75|      {/* Status label */}
76|      {score !== null && (
77|        <span className="text-muted-foreground font-normal">
78|          {config.label}
79|        </span>
80|      )}
81|    </Badge>
82|  );
83|}
84|