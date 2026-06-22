import { DataTableSkeleton } from "@/modules/workspace/Skeletons";

export default function AdminStoriesLoading() {
  return (
    <div className="shell shellEmbedded">
      <section className="workspaceStage">
        <section className="topbar">
          <div>
            <div className="h-3 w-24 mb-2 rounded bg-white/5 animate-pulse" />
            <div className="h-7 w-48 rounded bg-white/5 animate-pulse" />
          </div>
        </section>
        <DataTableSkeleton rows={6} />
      </section>
    </div>
  );
}