"use client";

import { useActionState } from "react";
import { removeCompanyStore } from "@/modules/company/actions";

export function RemoveStoreButton({ storeId, storeName }: { storeId: number; storeName: string }) {
  const [, action, pending] = useActionState(removeCompanyStore, { error: "" });

  return (
    <form action={action} className="inline">
      <input type="hidden" name="storeId" value={storeId} />
      <button
        type="submit"
        className="linkDanger"
        disabled={pending}
        onClick={(e) => {
          if (!confirm(`Remove store "${storeName}"?`)) e.preventDefault();
        }}
      >
        {pending ? "Removing..." : "Remove"}
      </button>
    </form>
  );
}
