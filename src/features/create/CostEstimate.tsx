import { useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { getBackend } from "@/lib/backend";
import type { CostEstimate as Estimate, JobKind, ProviderId } from "@/lib/backend/types";
import { cn } from "@/lib/utils";
import { useCreate } from "@/stores/create";
import { useSettings } from "@/stores/settings";
import { buildRequest } from "./generate";

/** "~30 credits on Tripo" — fetched from the engine, debounced as options change. */
export function CostEstimate({ kind = "generate", provider: providerProp, className }: { kind?: JobKind; provider?: ProviderId; className?: string }) {
  const create = useCreate();
  const defaultProvider = useSettings((s) => s.settings.defaultProvider);
  const provider = providerProp ?? create.provider ?? defaultProvider;
  const [estimate, setEstimate] = useState<Estimate | null>(null);

  const key = `${provider}|${kind}|${create.mode}|${create.quality}|${create.variants}|${create.pbr}|${create.style}`;
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      getBackend()
        .estimateCost(provider, kind, buildRequest())
        .then((e) => !cancelled && setEstimate(e))
        .catch(() => !cancelled && setEstimate(null));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures every input that changes the price
  }, [key]);

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs text-subtle", className)} aria-live="polite">
      <Coins className="size-3.5 shrink-0" />
      <span className="truncate">{estimate ? estimate.label : "Estimating…"}</span>
    </span>
  );
}
