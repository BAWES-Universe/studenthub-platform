"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Route } from "next";

import type { SessionUser } from "@/modules/auth/types";
import type { DiscountCategoryListItem } from "@/modules/admin/discount-category/schemas";
import { createDiscountCategory, deleteDiscountCategory } from "@/modules/admin/discount-category/actions";

type Props = {
  session: SessionUser;
  records: DiscountCategoryListItem[];
};

export function AdminDiscountCategoryTable({ session, records }: Props) {
  const router = useRouter();

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Discount Categories — manage discount category records."
      metrics={[
        { label: "Categories", value: records.length, note: "Active categories" },
      ]}
    >
      <section className="mb-6">
        <Card className="p-5">
          <h3 className="text-sm font-semibold mb-3 text-foreground">Add a category</h3>
          <CreateDiscountCategoryForm onSuccess={() => router.refresh()} />
        </Card>
      </section>

      <DataTable
        title="Discount Categories"
        description="List of all discount category records."
        rows={records.map((r) => ({ ...r, id: String(r.category_id) }))}
        rowHref={(row) => `/admin/discount-category/${row.category_id}` as Route}
        columns={[
          {
            key: "name_en",
            label: "Name (English)",
            render: (row) => (
              <span className="text-sm font-medium text-foreground">
                {row.name_en ?? "—"}
              </span>
            ),
          },
          {
            key: "name_ar",
            label: "Name (Arabic)",
            render: (row) => (
              <span className="text-sm text-muted-foreground" dir="rtl">
                {row.name_ar ?? "—"}
              </span>
            ),
          },
          {
            key: "discount_count",
            label: "Discounts",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.discount_count}
              </span>
            ),
          },
          {
            key: "image",
            label: "Image",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.image ? "Yes" : "—"}
              </span>
            ),
          },
          {
            key: "actions",
            label: "",
            render: (row) => (
              <DeleteCategoryButton
                categoryId={row.category_id}
                categoryName={row.name_en || row.name_ar || "Unnamed"}
                onDelete={async () => {
                  await deleteDiscountCategory(row.category_id);
                  router.refresh();
                }}
              />
            ),
          },
        ]}
      />
    </WorkspaceShell>
  );
}

function DeleteCategoryButton({
  categoryId,
  categoryName,
  onDelete,
}: {
  categoryId: number;
  categoryName: string;
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete discount category</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{categoryName}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-sm text-destructive font-medium">{error}</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={async (e) => {
              e.preventDefault();
              setLoading(true);
              setError(null);
              try {
                await onDelete();
                setOpen(false);
              } catch {
                setError("Failed to delete category");
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CreateDiscountCategoryForm({ onSuccess }: { onSuccess: () => void }) {
  const [state, action, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      const name_en = formData.get("name_en") as string;
      const name_ar = formData.get("name_ar") as string;
      const image = formData.get("image") as string;

      try {
        await createDiscountCategory({
          name_en,
          name_ar: name_ar || "",
          image: image || "",
        });
        onSuccess();
        return { error: undefined };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Failed to create category" };
      }
    },
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={action}
      className="grid grid-cols-2 md:grid-cols-3 gap-3 items-end"
      onSubmit={() => setTimeout(() => { formRef.current?.reset(); }, 100)}
    >
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name (English)</label>
        <Input name="name_en" maxLength={255} placeholder="e.g. Student Discount" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name (Arabic)</label>
        <Input name="name_ar" maxLength={255} placeholder="مثال: خصم طلاب" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Image URL</label>
        <Input name="image" maxLength={255} placeholder="e.g. /images/discount.png" />
      </div>
      <Button
        type="submit"
        disabled={pending}
        className="col-span-2 md:col-span-3 justify-self-start"
      >
        {pending ? "Adding..." : "Add Category"}
      </Button>
      {state?.error ? (
        <p className="text-xs w-full text-destructive col-span-full">{state.error}</p>
      ) : null}
    </form>
  );
}
