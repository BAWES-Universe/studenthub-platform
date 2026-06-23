"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";

export type SettingRow = {
  id: string;
  setting_uuid: string;
  code: string;
  key: string;
  value: string | null;
  serialized: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
};

export async function getSettingsList(): Promise<SettingRow[]> {
  await requireRoleCapability("admin", "admin.system");

  const settings = await prisma.setting.findMany({
    orderBy: [{ code: "asc" }, { key: "asc" }],
    select: {
      setting_uuid: true,
      code: true,
      key: true,
      value: true,
      serialized: true,
      created_at: true,
      updated_at: true
    }
  });

  return settings.map((s) => ({ ...s, id: s.setting_uuid }));
}

export async function getSettingDetail(settingUuid: string) {
  await requireRoleCapability("admin", "admin.system");

  const setting = await prisma.setting.findUnique({
    where: { setting_uuid: settingUuid }
  });

  return setting;
}

export async function updateSetting(
  settingUuid: string,
  data: { value: string }
) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.setting.update({
    where: { setting_uuid: settingUuid },
    data: {
      value: data.value,
      updated_at: new Date()
    }
  });

  revalidatePath("/admin/settings");
}
