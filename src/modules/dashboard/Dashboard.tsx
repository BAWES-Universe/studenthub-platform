import { getDashboardData } from "@/modules/dashboard/data";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export async function Dashboard() {
  const dashboard = await getDashboardData();

  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-4 gap-2.5" aria-label="StudentHub health metrics">
        {dashboard.metrics.map((metric) => (
          <Card key={metric.label}>
            <CardContent className="grid content-start gap-1 p-3.5">
              <span className="text-[11px] font-extrabold uppercase text-muted-foreground">{metric.label}</span>
              <strong className="text-2xl font-black">{metric.value.toLocaleString("en-US")}</strong>
              <p className="text-xs text-muted-foreground m-0">{metric.note}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4">
        <Card>
          <CardContent className="grid gap-3 p-4">
            <div>
              <p className="text-[11px] font-extrabold uppercase text-muted-foreground mb-1">Migration Strategy</p>
              <h2 className="text-lg font-bold m-0">Build from the real data model, one clean workflow at a time.</h2>
              <p className="text-sm text-muted-foreground leading-relaxed mt-2">
                This workspace is reading the local production clone when enabled. Each old portal becomes a
                role-aware surface inside one product.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {dashboard.statusMix.map((status) => (
                <div className="flex items-center justify-between border border-border rounded-md px-3 py-2" key={status.label}>
                  <span className="text-xs text-muted-foreground">{status.label}</span>
                  <strong className="text-sm font-bold">{status.value}</strong>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="md:w-56">
          <CardContent className="grid gap-2 p-4">
            <h2 className="text-sm font-bold m-0">Next Slices</h2>
            <ol className="m-0 pl-4 text-sm text-muted-foreground space-y-1">
              <li>Candidate list/detail/edit</li>
              <li>Company and request pipeline</li>
              <li>Work logs and approvals</li>
              <li>Transfer and payroll review</li>
            </ol>
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2.5">
        <DataList title="Recent Candidates" items={dashboard.recentCandidates} />
        <DataList title="Recent Companies" items={dashboard.recentCompanies} />
        <DataList title="Recent Requests" items={dashboard.recentRequests} />
        <DataList title="Recent Transfers" items={dashboard.recentTransfers} />
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

function DataList({ title, items }: { title: string; items: DataListItem[] }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between p-3.5 pb-0">
        <h2 className="text-sm font-bold m-0">{title}</h2>
        <span className="text-xs text-muted-foreground font-mono">{items.length}</span>
      </CardHeader>
      <CardContent className="p-3.5">
        <div className="grid gap-1.5">
          {items.map((item) => (
            <article className="grid grid-cols-[1fr_auto] items-start gap-2 py-1.5 border-b border-border last:border-b-0" key={item.id}>
              <div className="grid gap-0.5 min-w-0">
                <strong className="text-sm truncate">{item.title}</strong>
                <span className="text-xs text-muted-foreground truncate">{item.subtitle}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                <span>{item.meta}</span>
                {item.amount ? <strong className="text-xs font-bold">{item.amount}</strong> : null}
                {item.count !== undefined ? <strong className="text-xs font-bold">{item.count} seats</strong> : null}
                {item.date ? <small className="text-[10px]">{item.date}</small> : null}
              </div>
            </article>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
