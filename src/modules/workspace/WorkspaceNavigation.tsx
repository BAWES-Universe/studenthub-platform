"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NavItem } from "./navigation";

export function WorkspaceNavigation({ items, role }: { items: NavItem[]; role: string }) {
  const pathname = usePathname();
  return (
    <nav className="w-full grid content-start gap-1" aria-label={`${role} workspace navigation`}>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              buttonVariants({ variant: "ghost" }),
              "w-full justify-start gap-3 px-3 no-underline text-sm font-semibold",
              active
                ? "bg-[#1f73b7]/10 text-[#1f73b7] font-bold"
                : "text-muted-foreground hover:text-foreground",
            )}
            href={item.href}
            key={item.href}
            title={item.label}
          >
            <Icon size={16} strokeWidth={2.5} aria-hidden="true" />
            <strong>{item.label}</strong>
          </Link>
        );
      })}
    </nav>
  );
}

export function WorkspaceMobileNavigation({ items, role }: { items: NavItem[]; role: string }) {
  const pathname = usePathname();
  return (
    <nav className="mobileTabBar" aria-label={`${role} mobile navigation`}>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-lg no-underline",
              "min-h-[56px] max-w-[96px] text-[11px] font-semibold transition-colors",
              active
                ? "bg-[#1f73b7]/10 text-[#1f73b7] font-bold"
                : "text-muted-foreground hover:text-foreground",
            )}
            href={item.href}
            key={item.href}
          >
            <Icon size={20} strokeWidth={active ? 2.5 : 2} aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function isActive(pathname: string, href: string) {
  if (href === "/app") return pathname === href || pathname === "/hub";
  return pathname === href || pathname.startsWith(`${href}/`);
}
