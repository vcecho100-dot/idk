import { toast } from "sonner";
import { errorMessage, getBackend } from "@/lib/backend";
import { viewer } from "./bridge";

export async function takeScreenshot(name: string): Promise<void> {
  const v = viewer();
  if (!v) return;
  try {
    const blob = await v.screenshot();
    const res = await getBackend().saveMedia({ suggestedName: `${name} screenshot`, kind: "png", bytes: new Uint8Array(await blob.arrayBuffer()) });
    if (res) toast.success("Screenshot saved", { description: res.path });
  } catch (err) {
    const { title, description } = errorMessage(err);
    toast.error(title, { description });
  }
}
