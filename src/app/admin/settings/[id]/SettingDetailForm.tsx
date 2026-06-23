"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { updateSetting } from "../actions";

interface SettingDetail {
  setting_uuid: string;
  code: string;
  key: string;
  value: string | null;
  serialized: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export function SettingDetailForm({
  setting,
}: {
  setting: SettingDetail;
}) {
  const [value, setValue] = useState(setting.value ?? "");

  const updateAction = async (_prevState: unknown, formData: FormData) => {
    formData.set("value", value);
    await updateSetting(setting.setting_uuid, { value });
    return { success: true };
  };

  const [state, formAction, pending] = useActionState(updateAction, null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Edit Setting</CardTitle>
          <CardDescription>
            Update the value for <strong>{setting.code} — {setting.key}</strong>.
            {setting.serialized && (
              <span className="block mt-1 text-amber-600 text-xs">
                ⚠ This value is serialized (JSON). Edit with care.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Code</Label>
                <Input value={setting.code} disabled />
              </div>
              <div className="space-y-2">
                <Label>Key</Label>
                <Input value={setting.key} disabled />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="value">Value</Label>
              {setting.serialized ? (
                <textarea
                  id="value"
                  name="value"
                  value={value}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setValue(e.target.value)}
                  rows={8}
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                />
              ) : (
                <Input
                  id="value"
                  name="value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Save Changes"}
              </Button>
              {state?.success && (
                <span className="text-sm text-[#2e7d32] font-medium">
                  Saved successfully
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Separator />
    </div>
  );
}
