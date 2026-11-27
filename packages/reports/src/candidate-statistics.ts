/**
 * A person's own statistics (legacy candidate app `StatisticController::actionList` and
 * `Candidate::getAccountStatistic`, `BAWES-Universe/studenthub` @ 55119d3): hours worked, money
 * paid, bonus after commission, earnings (paid plus bonus) and upcoming interviews, at
 * `/profile/statistics`. Read live from the pay lane's transfer lines and the recruit lane's
 * interviews; nothing is stored.
 *
 * Changes from legacy, by the rule that legacy prod is the benchmark and best practice wins:
 * - Legacy counted money on transfers whose company invoice was paid, as whole hours times the
 *   hourly rate (minutes and seconds dropped) plus bonus. Here money is what was paid out to the
 *   person: the lines the pay lane marks paid on transfers being distributed or complete, the same
 *   lines the person's `/pay` history lists, at each line's exact candidate total. Earnings is that
 *   total, bonus is the bonus after commission inside it, and paid is the rest.
 * - Legacy added every currency together. Here money is per currency.
 * - Legacy summed hours on every transfer row. Here hours are summed over the person's lines on
 *   transfers that are not draft (still being edited), cancelled or deleted.
 * - The bonus is read only from an hourly line, the only pay model whose total the pay lane adds a
 *   bonus to. Hours and bonus are read from a line's calculation only when it is the pay lane's generated
 *   calculation (`CANDIDATE_STATISTICS_CALCULATION_VERSION`) and its result still matches the line's
 *   stored candidate total. A line added or edited by hand counts fully as paid, with no hours and
 *   no bonus, since nothing on it says how its total splits.
 * - Upcoming interviews are the person's scheduled interviews after now for a request that is not
 *   filled or closed (legacy: not delivered, finished or cancelled).
 */
export const CANDIDATE_STATISTICS_CALCULATION_VERSION = "studenthub.payroll.f2-preview.v1";

/** The candidate's side of one transfer line, as the store reads it. */
export interface CandidatePayLine {
  readonly currency: string;
  /** Exact decimal text, three places. */
  readonly candidateTotal: string;
  /** Marked paid on a transfer being distributed or complete. */
  readonly paidOut: boolean;
  /** Only the calculation fields this report reads; anything else is never selected. */
  readonly calculation: {
    readonly version: unknown; readonly hours: unknown; readonly minutes: unknown; readonly seconds: unknown;
    readonly payModel: unknown; readonly bonus: unknown; readonly resultKind: unknown; readonly resultCandidateTotal: unknown; readonly bonusCommission: unknown;
  } | null;
}
export interface CandidateStatisticsStore {
  /** The person's lines on transfers that are not draft, cancelled or deleted, and their upcoming interviews, from one snapshot. */
  read(personId: string, now: Date): Promise<{ readonly lines: readonly CandidatePayLine[]; readonly upcomingInterviews: number }>;
}
export interface CandidateMoney { readonly currency: string; readonly paid: string; readonly bonus: string; readonly earnings: string }
export interface CandidateStatistics {
  readonly worked: { readonly hours: string; readonly minutes: number; readonly seconds: number };
  readonly money: readonly CandidateMoney[];
  readonly upcomingInterviews: number;
}

const DECIMAL = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,3})?$/;
const fils = (v: unknown): bigint | null => {
  if (typeof v !== "string") return null;
  const m = DECIMAL.exec(v); if (!m) return null;
  return BigInt(m[1]!) * 1000n + BigInt((m[2] ?? ".").slice(1).padEnd(3, "0"));
};
const format = (n: bigint) => `${n / 1000n}.${String(n % 1000n).padStart(3, "0")}`;
const part = (v: unknown, max: number): number | null => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max ? v as number : null;

/** Worked seconds and bonus after commission (in fils) from a generated calculation that still matches its line; null otherwise. */
export function lineParts(line: CandidatePayLine): { readonly seconds: bigint; readonly bonus: bigint } | null {
  const c = line.calculation, total = fils(line.candidateTotal);
  if (!c || total === null || c.version !== CANDIDATE_STATISTICS_CALCULATION_VERSION || c.resultKind !== "calculated" || fils(c.resultCandidateTotal) !== total) return null;
  const hours = typeof c.hours === "string" && /^[0-9]{1,9}$/.test(c.hours) ? BigInt(c.hours) : null;
  const minutes = part(c.minutes, 59), seconds = part(c.seconds, 59), bonus = fils(c.bonus), commission = fils(c.bonusCommission);
  if (hours === null || minutes === null || seconds === null || bonus === null || commission === null) return null;
  // The pay lane adds a bonus only to an hourly line (`calculatePayLine`); a salary or fixed line's total holds none.
  const net = c.payModel === "hourly" ? bonus - commission : 0n;
  if (net < 0n || net > total) return null;
  return { seconds: hours * 3600n + BigInt(minutes * 60 + seconds), bonus: net };
}

/** The person's figures from the store's lines; money is ordered by currency code. */
export function candidateStatistics(lines: readonly CandidatePayLine[], upcomingInterviews: number): CandidateStatistics {
  let seconds = 0n;
  const money = new Map<string, { paid: bigint; bonus: bigint }>();
  for (const line of lines) {
    const total = fils(line.candidateTotal);
    if (total === null) throw new RangeError("invalid candidate total");
    const parts = lineParts(line);
    if (parts) seconds += parts.seconds;
    if (!line.paidOut) continue;
    const m = money.get(line.currency) ?? { paid: 0n, bonus: 0n };
    const bonus = parts?.bonus ?? 0n;
    m.paid += total - bonus; m.bonus += bonus;
    money.set(line.currency, m);
  }
  return {
    worked: { hours: String(seconds / 3600n), minutes: Number(seconds % 3600n / 60n), seconds: Number(seconds % 60n) },
    money: [...money].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([currency, m]) => ({ currency, paid: format(m.paid), bonus: format(m.bonus), earnings: format(m.paid + m.bonus) })),
    upcomingInterviews,
  };
}

export class CandidateStatisticsService {
  constructor(private readonly store: CandidateStatisticsStore, private readonly now: () => Date = () => new Date()) {}
  /** The signed-in person's own figures; there is no way to ask for someone else's. */
  async own(personId: string): Promise<CandidateStatistics> {
    const { lines, upcomingInterviews } = await this.store.read(personId, this.now());
    return candidateStatistics(lines, upcomingInterviews);
  }
}
