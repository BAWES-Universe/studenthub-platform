"use client";

import { useActionState } from "react";
import { removeCompanyContact } from "@/modules/company/actions";

export function RemoveContactButton({ companyContactUuid, contactName }: { companyContactUuid: string; contactName: string }) {
  const [, action, pending] = useActionState(removeCompanyContact, { error: "" });

  return (
    <form action={action} className="inline">
      <input type="hidden" name="companyContactUuid" value={companyContactUuid} />
      <button
        type="submit"
        className="linkDanger"
        disabled={pending}
        onClick={(e) => {
          if (!confirm(`Remove ${contactName} from this company?`)) e.preventDefault();
        }}
      >
        {pending ? "Removing..." : "Remove"}
      </button>
    </form>
  );
}
