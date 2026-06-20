"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";

export async function getDegreeDetail(degreeUuid: string) {
  await requireRoleCapability("admin", "admin.system");

  const degree = await prisma.degree.findUnique({
    where: { degree_uuid: degreeUuid },
    select: {
      degree_uuid: true,
      degree_name_en: true,
      degree_name_ar: true,
      degree_sort_order: true,
      degree_group_uuid: true,
      degree_created_at: true,
      degree_updated_at: true,
      degree_group: {
        select: { degree_group_uuid: true, degree_group_name_en: true }
      }
    }
  });

  return degree;
}

export async function getDegreeGroupOptions(): Promise<{ degree_group_uuid: string; degree_group_name_en: string }[]> {
  await requireRoleCapability("admin", "admin.system");

  const groups = await prisma.degree_group.findMany({
    orderBy: { degree_group_sort_order: "asc" },
    select: {
      degree_group_uuid: true,
      degree_group_name_en: true
    }
  });

  return groups;
}

export async function updateDegree(
  degreeUuid: string,
  data: {
    degree_name_en: string;
    degree_name_ar?: string;
    degree_sort_order?: number;
    degree_group_uuid?: string | null;
  }
) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.degree.update({
    where: { degree_uuid: degreeUuid },
    data: {
      degree_name_en: data.degree_name_en,
      degree_name_ar: data.degree_name_ar ?? null,
      degree_sort_order: data.degree_sort_order ?? 0,
      degree_group_uuid: data.degree_group_uuid ?? null,
      degree_updated_at: new Date()
    }
  });

  revalidatePath("/admin/degree");
}

export async function createDegree(data: {
  degree_name_en: string;
  degree_name_ar?: string;
  degree_sort_order?: number;
  degree_group_uuid?: string | null;
}) {
  await requireRoleCapability("admin", "admin.system");

  const uuid = crypto.randomUUID();

  await prisma.degree.create({
    data: {
      degree_uuid: uuid,
      degree_name_en: data.degree_name_en,
      degree_name_ar: data.degree_name_ar ?? null,
      degree_sort_order: data.degree_sort_order ?? 0,
      degree_group_uuid: data.degree_group_uuid ?? null,
      degree_created_at: new Date(),
      degree_updated_at: new Date()
    }
  });

  revalidatePath("/admin/degree");
  return { uuid };
}

export async function deleteDegree(degreeUuid: string) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.degree.delete({
    where: { degree_uuid: degreeUuid }
  });

  revalidatePath("/admin/degree");
}
