"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateDegree, deleteDegree } from "../actions";

interface DegreeGroup {
  degree_group_uuid: string;
  degree_group_name_en: string;
}

interface DegreeDetail {
  degree_uuid: string;
  degree_name_en: string;
  degree_name_ar: string | null;
  degree_sort_order: number | null;
  degree_group_uuid: string | null;
  degree_created_at: Date | null;
  degree_updated_at: Date | null;
  degree_group: DegreeGroup | null;
}

export function DegreeDetailForm({
  degree,
  groups,
}: {
  degree: DegreeDetail;
  groups: DegreeGroup[];
}) {
  const [nameEn, setNameEn] = useState(degree.degree_name_en);
  const [nameAr, setNameAr] = useState(degree.degree_name_ar ?? "");
  const [sortOrder, setSortOrder] = useState(String(degree.degree_sort_order ?? 0));
  const [groupUuid, setGroupUuid] = useState(degree.degree_group_uuid ?? "");

  const updateAction = async (_prevState: unknown, formData: FormData) => {
    formData.set("degree_name_en", nameEn);
    formData.set("degree_name_ar", nameAr || "");
    formData.set("degree_sort_order", sortOrder);
    formData.set("degree_group_uuid", groupUuid || "");

    await updateDegree(degree.degree_uuid, {
      degree_name_en: nameEn,
      degree_name_ar: nameAr || undefined,
      degree_sort_order: Number(sortOrder) || 0,
      degree_group_uuid: groupUuid || null,
    });
    return { success: true };
  };

  const [state, formAction, pending] = useActionState(updateAction, null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Edit Degree</CardTitle>
          <CardDescription>
            Update the degree name, sort order, and group assignment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="degree_name_en">Name (English)</Label>
                <Input
                  id="degree_name_en"
                  name="degree_name_en"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="degree_name_ar">Name (Arabic)</Label>
                <Input
                  id="degree_name_ar"
                  name="degree_name_ar"
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="degree_sort_order">Sort Order</Label>
                <Input
                  id="degree_sort_order"
                  name="degree_sort_order"
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="degree_group_uuid">Degree Group</Label>
                <Select
                  value={groupUuid}
                  onValueChange={(val) => setGroupUuid(val)}
                >
                  <SelectTrigger id="degree_group_uuid" className="w-full">
                    <SelectValue placeholder="— None —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— None —</SelectItem>
                    {groups.map((group) => (
                      <SelectItem
                        key={group.degree_group_uuid}
                        value={group.degree_group_uuid}
                      >
                        {group.degree_group_name_en}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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

      <Card className="border-[var(--sh-error)]/20">
        <CardHeader>
          <CardTitle className="text-[var(--sh-error)]">Danger Zone</CardTitle>
          <CardDescription>
            Deleting this degree will also remove it from all candidate education
            records. This action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={async () => {
              await deleteDegree(degree.degree_uuid);
            }}
          >
            <Button type="submit" variant="destructive">
              Delete Degree
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
