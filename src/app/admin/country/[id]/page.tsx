import { notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { getCountry } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminCountryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;
  const countryId = Number(id);

  if (Number.isNaN(countryId)) {
    notFound();
  }

  const country = await getCountry(countryId);

  if (!country) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Countries"
      title={`Country — ${country.country_name_en ?? country.country_name_ar ?? "Unnamed"}`}
      metrics={[
        {
          label: "Name (English)",
          value: country.country_name_en ?? "—",
          note: "English name",
        },
        {
          label: "Name (Arabic)",
          value: country.country_name_ar ?? "—",
          note: "Arabic name",
        },
      ]}
    >
      <FactPanel
        title="Country Details"
        facts={[
          { label: "ID", value: String(country.country_id) },
          { label: "Name (English)", value: country.country_name_en ?? "—" },
          { label: "Name (Arabic)", value: country.country_name_ar ?? "—" },
          { label: "Nationality (English)", value: country.country_nationality_name_en ?? "—" },
          { label: "Nationality (Arabic)", value: country.country_nationality_name_ar ?? "—" },
          { label: "ISO", value: country.iso ?? "—" },
          { label: "Emoji", value: country.emoji ?? "—" },
          { label: "Phone Code", value: country.country_code != null ? `+${country.country_code}` : "—" },
          { label: "Currency", value: country.currency_code ?? "—" },
          { label: "Google Map Data", value: country.country_from_google_map ? "Yes" : "No" },
        ]}
      />

      <section className="flex gap-2 p-4">
        <Link href={"/admin/country" as Route}>
          <Button variant="outline">Back to Countries</Button>
        </Link>
      </section>
    </WorkspaceShell>
  );
}
