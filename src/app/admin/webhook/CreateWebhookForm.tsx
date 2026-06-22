"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createWebhook } from "./actions";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function CreateWebhookForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [method, setMethod] = useState("POST");

  const [state, action, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      const event = formData.get("event") as string;
      const endpoint = formData.get("endpoint") as string;

      try {
        await createWebhook({ event, endpoint, method });
        router.refresh();
        formRef.current?.reset();
        setMethod("POST");
        return { error: undefined };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Failed to create webhook" };
      }
    },
    null,
  );

  return (
    <form
      ref={formRef}
      action={action}
      className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end"
    >
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Event</label>
        <Input name="event" maxLength={50} placeholder="e.g. candidate.created" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Endpoint URL</label>
        <Input name="endpoint" maxLength={255} placeholder="https://example.com/hook" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Method</label>
        <input type="hidden" name="method" value={method} />
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger>
            <SelectValue placeholder="Method" />
          </SelectTrigger>
          <SelectContent>
            {HTTP_METHODS.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="submit"
        disabled={pending}
        className="self-end"
      >
        {pending ? "Adding..." : "Add Webhook"}
      </Button>
      {state?.error ? (
        <p className="text-xs w-full text-destructive col-span-full">{state.error}</p>
      ) : null}
    </form>
  );
}
