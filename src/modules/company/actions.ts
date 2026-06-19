"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";
import { companyErrorResultSchema } from "./schemas";

const addContactSchema = z.object({
  companyId: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive("Company is required")),
  name: z.string().min(1, "Contact name is required").max(255),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  position: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  allowAccess: z.string().optional(),
});

export async function addCompanyContact(_prevState: { error: string }, formData: FormData) {
  await requireRoleCapability("company", "company.write.linked");

  const parsed = addContactSchema.safeParse({
    companyId: formData.get("companyId"),
    name: formData.get("name"),
    email: formData.get("email"),
    position: formData.get("position"),
    phone: formData.get("phone"),
    allowAccess: formData.get("allowAccess"),
  });

  if (!parsed.success) {
    const errResult = { error: parsed.error.issues[0]?.message ?? "Invalid input." };
    const errParsed = companyErrorResultSchema.safeParse(errResult);
    if (!errParsed.success) console.error("[modules/company] addCompanyContact output validation failed:", errParsed.error.issues);
    return errResult;
  }

  let contactUuid: string;
  if (parsed.data.email) {
    const existing = await prisma.contact.findUnique({
      where: { contact_email: parsed.data.email },
      select: { contact_uuid: true },
    });
    if (existing) {
      contactUuid = existing.contact_uuid;
    } else {
      contactUuid = crypto.randomUUID();
      await prisma.contact.create({
        data: {
          contact_uuid: contactUuid,
          contact_name: parsed.data.name,
          contact_email: parsed.data.email,
          contact_created_at: new Date(),
          contact_updated_at: new Date(),
        },
      });
    }
  } else {
    contactUuid = crypto.randomUUID();
    await prisma.contact.create({
      data: {
        contact_uuid: contactUuid,
        contact_name: parsed.data.name,
        contact_created_at: new Date(),
        contact_updated_at: new Date(),
      },
    });
  }

  await prisma.company_contact.create({
    data: {
      company_contact_uuid: crypto.randomUUID(),
      contact_uuid: contactUuid,
      company_id: parsed.data.companyId,
      contact_position: parsed.data.position || null,
      allow_access: parsed.data.allowAccess === "1",
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  revalidatePath("/company/contacts");
  const okResult = { error: "" };
  const okParsed = companyErrorResultSchema.safeParse(okResult);
  if (!okParsed.success) console.error("[modules/company] addCompanyContact output validation failed:", okParsed.error.issues);
  return okResult;
}

export async function removeCompanyContact(_prevState: { error: string }, formData: FormData) {
  await requireRoleCapability("company", "company.write.linked");
  const companyContactUuid = formData.get("companyContactUuid");

  if (typeof companyContactUuid !== "string" || !companyContactUuid.trim()) {
    const errResult = { error: "Invalid contact." };
    const errParsed = companyErrorResultSchema.safeParse(errResult);
    if (!errParsed.success) console.error("[modules/company] removeCompanyContact output validation failed:", errParsed.error.issues);
    return errResult;
  }

  await prisma.company_contact.delete({
    where: { company_contact_uuid: companyContactUuid },
  });

  revalidatePath("/company/contacts");
  const okResult = { error: "" };
  const okParsed = companyErrorResultSchema.safeParse(okResult);
  if (!okParsed.success) console.error("[modules/company] removeCompanyContact output validation failed:", okParsed.error.issues);
  return okResult;
}

const addStoreSchema = z.object({
  companyId: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive("Company is required")),
  storeName: z.string().min(1, "Store name is required").max(255),
  storeLocation: z.string().max(255).optional(),
  mallUuid: z.string().max(60).optional(),
  brandUuid: z.string().max(60).optional(),
});

export async function addCompanyStore(_prevState: { error: string }, formData: FormData) {
  await requireRoleCapability("company", "company.write.linked");

  const parsed = addStoreSchema.safeParse({
    companyId: formData.get("companyId"),
    storeName: formData.get("storeName"),
    storeLocation: formData.get("storeLocation"),
    mallUuid: formData.get("mallUuid"),
    brandUuid: formData.get("brandUuid"),
  });

  if (!parsed.success) {
    const errResult = { error: parsed.error.issues[0]?.message ?? "Invalid input." };
    const errParsed = companyErrorResultSchema.safeParse(errResult);
    if (!errParsed.success) console.error("[modules/company] addCompanyStore output validation failed:", errParsed.error.issues);
    return errResult;
  }

  await prisma.store.create({
    data: {
      company_id: parsed.data.companyId,
      store_name: parsed.data.storeName,
      store_location: parsed.data.storeLocation || "",
      mall_uuid: parsed.data.mallUuid || null,
      brand_uuid: parsed.data.brandUuid || null,
      store_created_at: new Date(),
      store_updated_at: new Date(),
    },
  });

  revalidatePath("/company/stores");
  const okResult = { error: "" };
  const okParsed = companyErrorResultSchema.safeParse(okResult);
  if (!okParsed.success) console.error("[modules/company] addCompanyStore output validation failed:", okParsed.error.issues);
  return okResult;
}

export async function removeCompanyStore(_prevState: { error: string }, formData: FormData) {
  await requireRoleCapability("company", "company.write.linked");
  const storeIdRaw = formData.get("storeId");
  const storeId = Number(storeIdRaw);

  if (!Number.isInteger(storeId) || storeId <= 0) {
    const errResult = { error: "Invalid store." };
    const errParsed = companyErrorResultSchema.safeParse(errResult);
    if (!errParsed.success) console.error("[modules/company] removeCompanyStore output validation failed:", errParsed.error.issues);
    return errResult;
  }

  await prisma.store.update({
    where: { store_id: storeId },
    data: { deleted: 1, store_updated_at: new Date() },
  });

  revalidatePath("/company/stores");
  const okResult = { error: "" };
  const okParsed = companyErrorResultSchema.safeParse(okResult);
  if (!okParsed.success) console.error("[modules/company] removeCompanyStore output validation failed:", okParsed.error.issues);
  return okResult;
}
