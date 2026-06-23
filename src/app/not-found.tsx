import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-center p-8">
      <h1 className="text-2xl font-bold text-foreground">Page not found</h1>
      <p className="text-[15px] text-muted-foreground max-w-[400px]">The page you are looking for does not exist or has been moved.</p>
      <Button asChild variant="secondary">
        <Link href="/">Go home</Link>
      </Button>
    </div>
  );
}
