import { useEffect } from "react";
import { toast } from "sonner";
import { errorMessage, getBackend } from "@/lib/backend";
import { useCreate } from "@/stores/create";
import { useLibrary } from "@/stores/library";
import { navigate, useRoute } from "@/stores/route";

/** Files dropped anywhere: images become the reference, models and .shift3d projects open in the studio. */
export function useFileDrop(): void {
  useEffect(
    () =>
      getBackend().onDrop((items) => {
        for (const r of items.rejected) toast.error(`Can't open ${r.name}`, { description: r.reason });
        const img = items.images[0];
        if (img) {
          useCreate.getState().set({ mode: "image", image: img });
          if (useRoute.getState().route.name !== "studio") navigate({ name: "studio" });
        }
        const open = async (fn: () => Promise<string | null>) => {
          try {
            const id = await fn();
            if (id) {
              await useLibrary.getState().load();
              navigate({ name: "studio", projectId: id });
            }
          } catch (err) {
            const { title, description } = errorMessage(err);
            toast.error(title, { description });
          }
        };
        void (async () => {
          for (const m of items.models) await open(() => getBackend().importModel({ token: m.token }));
          for (const p of items.projects) await open(() => getBackend().openProjectFile({ token: p.token }));
        })();
      }),
    [],
  );
}
