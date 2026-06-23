"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { updatePermissionSection } from "@/modules/admin/permission-sections/actions";
import type { PermissionSectionResult, ActionError } from "@/modules/admin/permission-sections/actions";

type Props = {
  section: PermissionSectionResult;
};

export function PermissionSectionForm({ section }: Props) {
  const router = useRouter();

  const [state, formAction, pending] = useActionState(
    async (_prevState: ActionError, formData: FormData) => {
      formData.set("permissionUuid", section.permissionUuid);
      const result = await updatePermissionSection(_prevState, formData);
      if (result && !("error" in result)) {
        router.push("/admin/settings/permission-sections");
      }
      return result as ActionError;
    },
    { error: "" },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Permission Section</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sectionName">Section Name</Label>
            <Input
              id="sectionName"
              name="sectionName"
              defaultValue={section.sectionName ?? ""}
              placeholder="Enter section name"
              required
            />
          </div>

          {state?.error && (
            <p className="text-sm text-destructive">{state.error}</p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push("/admin/settings/permission-sections")}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
