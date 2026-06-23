"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { updateDegreeGroup, deleteDegreeGroup } from "@/modules/admin/degree-group/actions";
import type { DegreeGroupListItem } from "@/modules/admin/degree-group/schemas";

type Props = {
  group: DegreeGroupListItem;
};

export function DegreeGroupDetailForm({ group }: Props) {
  const router = useRouter();
  const [nameEn, setNameEn] = useState(group.degree_group_name_en);
  const [nameAr, setNameAr] = useState(group.degree_group_name_ar ?? "");
  const [sortOrder, setSortOrder] = useState(String(group.degree_group_sort_order ?? 0));
  const [skipMajor, setSkipMajor] = useState(String(group.skip_major ?? 0));

  const updateAction = async (_prevState: unknown, formData: FormData) => {
    formData.set("degree_group_name_en", nameEn);
    formData.set("degree_group_name_ar", nameAr || "");
    formData.set("degree_group_sort_order", sortOrder);
    formData.set("skip_major", skipMajor);

    await updateDegreeGroup({
      degreeGroupUuid: group.degree_group_uuid,
      degree_group_name_en: nameEn,
      degree_group_name_ar: nameAr || undefined,
      degree_group_sort_order: Number(sortOrder) || undefined,
      skip_major: Number(skipMajor) || undefined,
    });
    return { success: true };
  };

  const [state, formAction, pending] = useActionState(updateAction, null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Edit Degree Group</CardTitle>
          <CardDescription>
            Update the degree group name, sort order, and skip-major flag.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="degree_group_name_en">Name (English)</Label>
                <Input
                  id="degree_group_name_en"
                  name="degree_group_name_en"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="degree_group_name_ar">Name (Arabic)</Label>
                <Input
                  id="degree_group_name_ar"
                  name="degree_group_name_ar"
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="degree_group_sort_order">Sort Order</Label>
                <Input
                  id="degree_group_sort_order"
                  name="degree_group_sort_order"
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="skip_major">Skip Major</Label>
                <Input
                  id="skip_major"
                  name="skip_major"
                  type="number"
                  value={skipMajor}
                  onChange={(e) => setSkipMajor(e.target.value)}
                  placeholder="0 or 1"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Save Changes"}
              </Button>
              {state?.success && (
                <span className="text-sm text-[var(--sh-success)] font-medium">
                  Saved successfully
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Separator />

      <Card className="border-destructive/20">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>
            Deleting this degree group will unlink all degrees in this group.
            This action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={async () => {
              await deleteDegreeGroup(group.degree_group_uuid);
              router.push("/admin/degree-group");
              router.refresh();
            }}
          >
            <Button type="submit" variant="destructive">
              Delete Degree Group
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
