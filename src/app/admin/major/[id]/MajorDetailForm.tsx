"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { updateMajor, deleteMajor } from "@/modules/admin/major/actions";
import type { MajorListItem } from "@/modules/admin/major/schemas";

type Props = {
  major: MajorListItem;
};

export function MajorDetailForm({ major }: Props) {
  const router = useRouter();
  const [nameEn, setNameEn] = useState(major.major_name_en);
  const [nameAr, setNameAr] = useState(major.major_name_ar ?? "");
  const [dataSource, setDataSource] = useState(String(major.data_source ?? ""));

  const updateAction = async (_prevState: unknown, formData: FormData) => {
    formData.set("major_name_en", nameEn);
    formData.set("major_name_ar", nameAr || "");
    formData.set("data_source", dataSource);

    await updateMajor({
      majorUuid: major.major_uuid,
      major_name_en: nameEn,
      major_name_ar: nameAr || undefined,
      data_source: dataSource ? Number(dataSource) : undefined,
    });
    return { success: true };
  };

  const [state, formAction, pending] = useActionState(updateAction, null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Edit Major</CardTitle>
          <CardDescription>
            Update the major name and data source.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="major_name_en">Name (English)</Label>
                <Input
                  id="major_name_en"
                  name="major_name_en"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="major_name_ar">Name (Arabic)</Label>
                <Input
                  id="major_name_ar"
                  name="major_name_ar"
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="data_source">Data Source</Label>
                <Input
                  id="data_source"
                  name="data_source"
                  type="number"
                  value={dataSource}
                  onChange={(e) => setDataSource(e.target.value)}
                  placeholder="0 or 1"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Save Changes"}
              </Button>
              {state?.success && (
                <span className="text-sm text-green-600 font-medium">
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
            Deleting this major will remove it from all candidate education
            records. This action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={async () => {
              await deleteMajor(major.major_uuid);
              router.push("/admin/major");
              router.refresh();
            }}
          >
            <Button type="submit" variant="destructive">
              Delete Major
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
