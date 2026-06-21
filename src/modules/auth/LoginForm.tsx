"use client";

import { useActionState } from "react";
import { LogIn } from "lucide-react";
import { chooseAccountAction, loginAction } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LoginAccountChoice } from "./types";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, {});
  const accounts = state.accounts ?? [];

  return (
    <div className="grid gap-[14px]">
      <form action={action} className="grid gap-[18px] p-[30px]">
        <div className="grid gap-[7px] pb-2">
          <span className="text-blue-zendesk text-xs font-black uppercase">Secure sign in</span>
          <strong className="text-[28px] leading-[1.1]">Continue to StudentHub</strong>
          <p className="text-muted-foreground leading-relaxed m-0">
            Use your existing production credentials. StudentHub will detect the right account and permissions after
            your password is verified.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="login-email">Email</Label>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={state.email ?? ""}
            placeholder="name@studenthub.app"
            required
            className="min-h-[46px]"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="login-password">Password</Label>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            required
            className="min-h-[46px]"
          />
        </div>

        {state.error ? <p className="text-destructive font-bold m-0">{state.error}</p> : null}

        <Button type="submit" disabled={pending} size="lg" className="min-h-[52px]">
          <LogIn className="size-4" />
          {pending ? "Checking credentials..." : "Sign in"}
        </Button>
      </form>

      {accounts.length ? <VerifiedAccountChooser accounts={accounts} /> : null}
    </div>
  );
}

function VerifiedAccountChooser({ accounts }: { accounts: LoginAccountChoice[] }) {
  return (
    <section className="grid gap-[14px] p-[30px] pt-0 border-t border-border" aria-label="Verified StudentHub accounts">
      <div className="grid gap-[7px]">
        <span className="text-blue-zendesk text-xs font-black uppercase">Verified accounts</span>
        <strong className="text-[28px] leading-[1.1]">Choose where to continue</strong>
        <p className="text-muted-foreground leading-relaxed m-0">Your password matched more than one active account. Only verified accounts are shown here.</p>
      </div>
      {accounts.map((account) => (
        <form action={chooseAccountAction} key={account.accountKey}>
          <input name="accountKey" type="hidden" value={account.accountKey} />
          <Button
            type="submit"
            variant="outline"
            className="w-full min-h-[62px] justify-start h-auto p-3 gap-3 text-left"
          >
            <span className="grid gap-1 min-w-0">
              <strong className="text-sm">{account.name}</strong>
              <small className="text-muted-foreground text-xs font-normal">{account.email}</small>
            </span>
          </Button>
        </form>
      ))}
    </section>
  );
}
