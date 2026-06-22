"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";
import {
  settingDetailSchema,
  settingCreateResultSchema,
} from "@/modules/admin/setting/schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[admin/setting] ${source} output failed:`, error);
}

export async function getSettingDetail(settingUuid: string) {
  await requireRoleCapability("admin", "admin.system");

  const setting = await prisma.setting.findUnique({
    where: { setting_uuid: settingUuid },
    select: {
      setting_uuid: true,
      code: true,
      key: true,
      value: true,
      serialized: true,
      created_at: true,
      updated_at: true,
    }
  });

  if (!setting) return null;

  const result = settingDetailSchema.safeParse(setting);
  if (!result.success) {
    await logOutputError("getSettingDetail", result.error);
    return null;
  }

  return result.data;
}

export async function updateSetting(
  settingUuid: string,
  data: {
    code: string;
    key: string;
    value?: string | null;
    serialized?: boolean;
  }
) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.setting.update({
    where: { setting_uuid: settingUuid },
    data: {
      code: data.code,
      key: data.key,
      value: data.value ?? null,
      serialized: data.serialized ?? false,
      updated_at: new Date(),
    }
  });

  revalidatePath("/admin/setting");
}

export async function createSetting(data: {
  code: string;
  key: string;
  value?: string | null;
  serialized?: boolean;
}) {
  await requireRoleCapability("admin", "admin.system");

  const uuid = crypto.randomUUID();

  await prisma.setting.create({
    data: {
      setting_uuid: uuid,
      code: data.code,
      key: data.key,
      value: data.value ?? null,
      serialized: data.serialized ?? false,
      created_at: new Date(),
      updated_at: new Date(),
    }
  });

  revalidatePath("/admin/setting");

  const result = settingCreateResultSchema.safeParse({ uuid });
  if (!result.success) {
    await logOutputError("createSetting", result.error);
    return { uuid };
  }

  return result.data;
}

export async function deleteSetting(settingUuid: string) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.setting.delete({
    where: { setting_uuid: settingUuid }
  });

  revalidatePath("/admin/setting");
}
