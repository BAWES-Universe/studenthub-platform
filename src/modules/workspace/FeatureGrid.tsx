import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import type { NavItem } from "./navigation";

export function FeatureGrid({ items }: { items: NavItem[] }) {
  return (
    <section
      className="grid grid-cols-4 gap-3 pt-5 max-lg:grid-cols-2 max-sm:grid-cols-1"
      aria-label="Workspace features"
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Card
            key={item.href}
            className="relative min-h-[112px] border-t-4 border-t-[#1f73b7] transition-all duration-160 hover:shadow-lg hover:-translate-y-0.5"
          >
            <CardContent className="p-4 h-full grid content-between gap-2">
              <div className="flex items-center gap-3">
                {Icon && <Icon size={20} className="text-[#1f73b7]" aria-hidden="true" />}
                <span className="text-lg font-bold text-foreground">{item.label}</span>
              </div>
              <Button variant="ghost" size="sm" className="justify-start px-0 text-[#1f73b7] font-semibold text-xs hover:text-[#1f73b7]/80" asChild>
                <Link href={item.href}>
                  Open
                  <ArrowRight size={14} className="ml-1" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}
