import { getDashboardData } from "@/modules/dashboard/data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export async function Dashboard() {
  const dashboard = await getDashboardData();

  return (
    <>
      {/* ── KPI Metrics ─────────────────────────────── */}
      <section
        className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3"
        aria-label="StudentHub health metrics"
      >
        {dashboard.metrics.map((metric) => (
          <Card key={metric.label}>
            <CardContent className="p-4">
              <span className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                {metric.label}
              </span>
              <strong className="block text-[38px] leading-[1] my-3 font-bold text-foreground">
                {metric.value.toLocaleString("en-US")}
              </strong>
              <p className="text-muted-foreground/70 text-sm mb-0">{metric.note}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ── Migration Strategy / Status Mix ─────────── */}
      <section className="grid grid-cols-[1fr_minmax(240px,300px)] gap-3">
        <Card>
          <CardContent className="p-4 grid gap-2.5">
            <p className="text-blue-600 text-xs font-bold uppercase tracking-normal mb-0">
              Migration Strategy
            </p>
            <h2 className="text-xl font-bold text-foreground leading-snug mb-0">
              Build from the real data model, one clean workflow at a time.
            </h2>
            <p className="text-muted-foreground text-sm mb-0">
              This workspace is reading the local production clone when enabled. Each old portal
              becomes a role-aware surface inside one product.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle className="text-sm font-bold text-foreground">Status Mix</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {dashboard.statusMix.map((status) => (
                <div
                  className="flex items-center justify-between px-4 py-3"
                  key={status.label}
                >
                  <span className="text-sm text-muted-foreground">{status.label}</span>
                  <Badge variant="secondary">{status.value}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Next Slices ─────────────────────────────── */}
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="text-sm font-bold text-foreground">Next Slices</CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <ol className="grid gap-2 list-decimal list-inside text-sm text-muted-foreground">
            <li>Candidate list/detail/edit</li>
            <li>Company and request pipeline</li>
            <li>Work logs and approvals</li>
            <li>Transfer and payroll review</li>
          </ol>
        </CardContent>
      </Card>

      {/* ── Recent Data Lists ───────────────────────── */}
      <section className="grid grid-cols-2 gap-3">
        <DashboardCardList title="Recent Candidates" items={dashboard.recentCandidates} />
        <DashboardCardList title="Recent Companies" items={dashboard.recentCompanies} />
        <DashboardCardList title="Recent Requests" items={dashboard.recentRequests} />
        <DashboardCardList title="Recent Transfers" items={dashboard.recentTransfers} />
      </section>
    </>
  );
}

type DataListItem = {
  id: number | string;
  title: string;
  subtitle: string;
  meta: string;
  amount?: string;
  date?: string;
  count?: number;
};

function DashboardCardList({ title, items }: { title: string; items: DataListItem[] }) {
  return (
    <Card className="min-h-[360px]">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border">
        <h2 className="text-base font-bold text-foreground m-0">{title}</h2>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.length ? (
        <div className="divide-y divide-border">
          {items.map((item) => (
            <article
              key={item.id}
              className="min-h-[72px] grid grid-cols-[1fr_minmax(126px,auto)] gap-4 px-4 py-3.5"
            >
              <div className="min-w-0 grid gap-1.5 content-center">
                <strong className="text-sm text-foreground">{item.title}</strong>
                <span className="text-xs text-muted-foreground">{item.subtitle}</span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <span className="text-xs text-muted-foreground">{item.meta}</span>
                {item.amount ? (
                  <strong className="text-sm text-foreground">{item.amount}</strong>
                ) : null}
                {item.count !== undefined ? (
                  <Badge variant="secondary" className="text-xs">
                    {item.count} seats
                  </Badge>
                ) : null}
                {item.date ? (
                  <small className="text-[11px] text-muted-foreground">{item.date}</small>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="grid gap-1.5 p-4 text-muted-foreground">
          <strong className="text-foreground text-sm">No records found</strong>
          <span className="text-xs">
            This view is connected to the prod clone, but this account has no matching rows yet.
          </span>
        </div>
      )}
    </Card>
  );
}
