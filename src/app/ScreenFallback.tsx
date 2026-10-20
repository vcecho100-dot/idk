import { Skeleton } from "@/components/ui/misc";

/** Shown for a frame or two while a lazily loaded screen arrives — same layout, no jump. */
export function ScreenFallback() {
  return (
    <div className="flex flex-1 gap-2 p-2" aria-busy>
      <Skeleton className="w-[300px] rounded-panel" />
      <Skeleton className="flex-1 rounded-panel" />
    </div>
  );
}
