"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sectionNameSchema = z
  .string()
  .min(1, "Section name is required")
  .max(255, "Section name must be 255 characters or less");

const permissionUuidSchema = z
  .string()
  .min(1, "Permission UUID is required")
  .max(60);

const createSectionSchema = z.object({
  sectionName: sectionNameSchema,
});

const updateSectionSchema = z.object({
  permissionUuid: permissionUuidSchema,
  sectionName: sectionNameSchema,
});

const deleteSectionSchema = z.object({
  permissionUuid: permissionUuidSchema,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionSectionResult = {
  permissionUuid: string;
  sectionName: string | null;
  createdAt: Date;
};

export type ActionError = { error: string };

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listPermissionSections(): Promise<
  PermissionSectionResult[] | ActionError
> {
  await requireRoleCapability("admin", "admin.system");

  try {
    const sections = await prisma.permission_section.findMany({
      orderBy: { section_name: "asc" },
      select: {
        permission_uuid: true,
        section_name: true,
        created_at: true,
      },
    });

    return sections.map((s: { permission_uuid: string; section_name: string | null; created_at: Date }) => ({
      permissionUuid: s.permission_uuid,
      sectionName: s.section_name,
      createdAt: s.created_at,
    }));
  } catch (err) {
    console.error(
      "[modules/admin/permission-sections] listPermissionSections failed:",
      err,
    );
    return { error: "Failed to list permission sections." };
  }
}

// ---------------------------------------------------------------------------
// Get (single)
// ---------------------------------------------------------------------------

export async function getPermissionSection(
  permissionUuid: string,
): Promise<PermissionSectionResult | ActionError> {
  await requireRoleCapability("admin", "admin.system");

  const parsed = permissionUuidSchema.safeParse(permissionUuid);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid UUID." };
  }

  try {
    const section = await prisma.permission_section.findUnique({
      where: { permission_uuid: parsed.data },
      select: {
        permission_uuid: true,
        section_name: true,
        created_at: true,
      },
    });

    if (!section) {
      return { error: "Permission section not found." };
    }

    return {
      permissionUuid: section.permission_uuid,
      sectionName: section.section_name,
      createdAt: section.created_at,
    };
  } catch (err) {
    console.error(
      "[modules/admin/permission-sections] getPermissionSection failed:",
      err,
    );
    return { error: "Failed to get permission section." };
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPermissionSection(
  _prevState: ActionError,
  formData: FormData,
): Promise<PermissionSectionResult | ActionError> {
  await requireRoleCapability("admin", "admin.system");

  const parsed = createSectionSchema.safeParse({
    sectionName: formData.get("sectionName"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const uuid = crypto.randomUUID();
    const now = new Date();

    await prisma.permission_section.create({
      data: {
        permission_uuid: uuid,
        section_name: parsed.data.sectionName,
        created_at: now,
      },
    });

    revalidatePath("/admin/settings/permission-sections");

    return {
      permissionUuid: uuid,
      sectionName: parsed.data.sectionName,
      createdAt: now,
    };
  } catch (err) {
    console.error(
      "[modules/admin/permission-sections] createPermissionSection failed:",
      err,
    );
    return { error: "Failed to create permission section." };
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updatePermissionSection(
  _prevState: ActionError,
  formData: FormData,
): Promise<PermissionSectionResult | ActionError> {
  await requireRoleCapability("admin", "admin.system");

  const parsed = updateSectionSchema.safeParse({
    permissionUuid: formData.get("permissionUuid"),
    sectionName: formData.get("sectionName"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const existing = await prisma.permission_section.findUnique({
      where: { permission_uuid: parsed.data.permissionUuid },
      select: { permission_uuid: true },
    });

    if (!existing) {
      return { error: "Permission section not found." };
    }

    const updated = await prisma.permission_section.update({
      where: { permission_uuid: parsed.data.permissionUuid },
      data: { section_name: parsed.data.sectionName },
      select: {
        permission_uuid: true,
        section_name: true,
        created_at: true,
      },
    });

    revalidatePath("/admin/settings/permission-sections");

    return {
      permissionUuid: updated.permission_uuid,
      sectionName: updated.section_name,
      createdAt: updated.created_at,
    };
  } catch (err) {
    console.error(
      "[modules/admin/permission-sections] updatePermissionSection failed:",
      err,
    );
    return { error: "Failed to update permission section." };
  }
}
