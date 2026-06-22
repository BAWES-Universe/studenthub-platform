"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";

export async function getWebhookDetail(webhookId: number) {
  await requireRoleCapability("admin", "admin.system");

  const webhook = await prisma.webhook.findUnique({
    where: { webhook_id: webhookId },
  });

  return webhook;
}

export async function createWebhook(data: {
  event: string;
  endpoint: string;
  method?: string;
}) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.webhook.create({
    data: {
      event: data.event,
      endpoint: data.endpoint,
      method: data.method as any ?? "POST",
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  revalidatePath("/admin/webhook");
}

export async function deleteWebhook(webhookId: number) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.webhook.delete({
    where: { webhook_id: webhookId },
  });

  revalidatePath("/admin/webhook");
}
