import Link from "next/link";
import type { NavItem } from "./navigation";
import { Card } from "@/components/ui/card";

export function FeatureGrid({ items }: { items: NavItem[] }) {
  return (
    <section
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 pt-5"
      aria-label="Workspace features"
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="no-underline"
        >
          <Card className="min-h-[112px] flex flex-col justify-between p-4 border-t-4 border-t-blue-zendesk shadow-[0_10px_36px_rgba(16,24,40,0.04)] transition-all duration-200 hover:border-[#9fb9db] hover:shadow-[0_18px_54px_rgba(16,24,40,0.09)] hover:-translate-y-0.5">
            <span className="text-lg font-bold text-foreground">{item.label}</span>
            <strong className="text-blue-zendesk text-sm">Open</strong>
          </Card>
        </Link>
      ))}
    </section>
  );
}
