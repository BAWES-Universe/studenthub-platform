"use client";

import { useActionState, useState } from "react";
import type { ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { updateSetting, deleteSetting } from "../actions";

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
  const [code, setCode] = useState(setting.code);
  const [key, setKey] = useState(setting.key);
  const [value, setValue] = useState(setting.value ?? "");
  const [serialized, setSerialized] = useState(setting.serialized ?? false);

  const updateAction = async (_prevState: unknown, formData: FormData) => {
    formData.set("code", code);
    formData.set("key", key);
    formData.set("value", value);
    formData.set("serialized", serialized ? "true" : "");

    await updateSetting(setting.setting_uuid, {
      code,
      key,
      value: value || null,
      serialized,
    });
    return { success: true };
  };

  const [state, formAction, pending] = useActionState(updateAction, null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Edit Setting</CardTitle>
          <CardDescription>
            Update the setting code, key, and value.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="code">Code</Label>
                <Input
                  id="code"
                  name="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="key">Key</Label>
                <Input
                  id="key"
                  name="key"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="value">Value</Label>
              <Textarea
                id="value"
                name="value"
                value={value}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setValue(e.target.value)}
                rows={6}
                className="font-mono text-sm"
              />
            </div>

            <div className="flex items-center gap-3">
              <Switch
                id="serialized"
                checked={serialized}
                onCheckedChange={(val: boolean) => setSerialized(val)}
              />
              <Label htmlFor="serialized">Serialized (JSON/encoded)</Label>
              {serialized && (
                <Badge variant="warning">JSON</Badge>
              )}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Save Changes"}
              </Button>
              {state?.success && (
                <span className="text-sm text-green-700 font-medium">
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
            Deleting this setting will permanently remove it. This action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={async () => {
              await deleteSetting(setting.setting_uuid);
            }}
          >
            <Button type="submit" variant="destructive">
              Delete Setting
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
