import type { Route } from "next";
import type { Role } from "@/modules/auth/types";
import type { LucideIcon } from "lucide-react";
import {
  LayoutGrid, User, Mail, ClipboardList, CreditCard,
  Building2, Phone, Store, FileCheck, Search, Users,
  ArrowRightLeft, Calendar, FileText, Globe, GraduationCap, Layers, MessageSquareText, Settings
} from "lucide-react";

export type NavItem = {
  label: string;
  href: Route;
  icon: LucideIcon;
};

const SHARED_APP: NavItem = { label: "App", href: "/app", icon: LayoutGrid };

export function navForRole(role: Role): NavItem[] {
  if (role === "admin") {
    return [
      SHARED_APP,
      { label: "Overview", href: "/admin", icon: User },
      { label: "Candidates", href: "/admin/candidates", icon: Users },
      { label: "Companies", href: "/admin/companies", icon: Building2 },
      { label: "Countries", href: "/admin/country", icon: Globe },
      { label: "Requests", href: "/admin/requests", icon: FileCheck },
      { label: "Degrees", href: "/admin/degree", icon: GraduationCap },
      { label: "Universities", href: "/admin/university" as Route, icon: Building2 },
      { label: "Daily Standup", href: "/admin/daily-standup", icon: MessageSquareText },
      { label: "Transfers", href: "/admin/transfers", icon: ArrowRightLeft },
      { label: "Documents", href: "/admin/documents" as Route, icon: FileText },
      { label: "Settings", href: "/admin/settings" as Route, icon: Settings }
    ];
  }
  if (role === "staff") {
    return [
      SHARED_APP,
      { label: "Overview", href: "/staff", icon: User },
      { label: "My Requests", href: "/staff/requests", icon: FileCheck },
      { label: "Candidates", href: "/staff/candidates", icon: Users },
      { label: "Interviews", href: "/staff/interviews" as Route, icon: Calendar }
    ];
  }
  if (role === "candidate") {
    return [
      SHARED_APP,
      { label: "Overview", href: "/candidate", icon: User },
      { label: "Invitations", href: "/candidate/invitations", icon: Mail },
      { label: "Work Logs", href: "/candidate/work-logs", icon: ClipboardList },
      { label: "Payments", href: "/candidate/payments", icon: CreditCard }
    ];
  }
  if (role === "company") {
    return [
      SHARED_APP,
      { label: "Overview", href: "/company", icon: User },
      { label: "Requests", href: "/company/requests", icon: FileCheck },
      { label: "Companies", href: "/company/companies", icon: Building2 },
      { label: "Contacts", href: "/company/contacts" as Route, icon: Phone },
      { label: "Stores", href: "/company/stores" as Route, icon: Store }
    ];
  }
  return [
    SHARED_APP,
    { label: "Overview", href: "/inspector", icon: User },
    { label: "ID Requests", href: "/inspector/id-requests", icon: Search }
  ];
}
