"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";

export async function updateWebhook(
  webhookId: number,
  data: {
    event: string;
    endpoint: string;
    method?: string;
  }
) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.webhook.update({
    where: { webhook_id: webhookId },
    data: {
      event: data.event,
      endpoint: data.endpoint,
      method: data.method as any ?? "POST",
      updated_at: new Date(),
    },
  });

  revalidatePath("/admin/webhook");
}
