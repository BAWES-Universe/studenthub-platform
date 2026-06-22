import { notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { getDiscountCategory } from "@/modules/admin/discount-category/actions";

export const dynamic = "force-dynamic";

export default async function AdminDiscountCategoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;
  const categoryId = Number(id);

  if (Number.isNaN(categoryId)) {
    notFound();
  }

  const category = await getDiscountCategory(categoryId);

  if (!category) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Discount Categories"
      title={`Discount Category — ${category.name_en ?? category.name_ar ?? "Unnamed"}`}
      metrics={[
        {
          label: "Name (English)",
          value: category.name_en ?? "—",
          note: "English name",
        },
        {
          label: "Name (Arabic)",
          value: category.name_ar ?? "—",
          note: "Arabic name",
        },
      ]}
    >
      <FactPanel
        title="Category Details"
        facts={[
          { label: "ID", value: String(category.category_id) },
          { label: "Name (English)", value: category.name_en ?? "—" },
          { label: "Name (Arabic)", value: category.name_ar ?? "—" },
          { label: "Image", value: category.image ?? "—" },
          { label: "Discounts", value: String(category.discount_count) },
        ]}
      />

      <section className="flex gap-2 p-4">
        <Link href={"/admin/discount-category" as Route}>
          <Button variant="outline">Back to Categories</Button>
        </Link>
      </section>
    </WorkspaceShell>
  );
}
