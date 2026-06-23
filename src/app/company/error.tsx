"use client";

import Link from "next/link";
import { RefreshCw, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function CompanyErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] p-8 text-center bg-background">
      <Card className="max-w-[420px] w-full">
        <CardContent className="flex flex-col items-center gap-5 py-10">
          <h1 className="text-5xl font-black leading-none m-0 bg-gradient-to-br from-[#eb6651] to-[#f59e0b] bg-clip-text text-transparent">
            500
          </h1>
          <div className="w-12 h-[3px] rounded-sm bg-[#eb6651]" aria-hidden="true" />
          <h2 className="text-xl font-bold m-0 text-foreground">
            Company system error
          </h2>
          <p className="text-[15px] text-muted-foreground leading-relaxed m-0">
            {error.message || "An unexpected error occurred in the company workspace."}
          </p>
          {error.digest ? (
            <p className="text-xs text-muted-foreground/60">
              Error ID: <code className="bg-muted px-1.5 py-0.5 rounded text-[11px]">{error.digest}</code>
            </p>
          ) : null}
          <div className="flex gap-3 mt-2 flex-wrap justify-center">
            <Button onClick={reset}>
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/company">
                <Building2 className="h-4 w-4" />
                Company dashboard
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
