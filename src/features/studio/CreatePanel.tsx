import { useEffect, useState } from "react";
import { ChevronDown, ImagePlus, Sparkles, Type, Images, WandSparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { SectionLabel } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CostEstimate } from "@/features/create/CostEstimate";
import { generateBlocker, submitGenerate } from "@/features/create/generate";
import { StyleArt } from "@/features/create/StyleArt";
import { errorMessage, getBackend } from "@/lib/backend";
import type { InputMode, ProviderId, Quality, StagedImage, Style, ViewSlot } from "@/lib/backend/types";
import { enhancePrompt, SUGGESTIONS } from "@/lib/prompt";
import { STYLE_LABEL } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { PROMPT_MAX, useCreate } from "@/stores/create";
import { useProviders } from "@/stores/providers";
import { useSettings } from "@/stores/settings";

const ACCEPT = "image/png,image/jpeg,image/webp";

async function stageFile(file: File): Promise<StagedImage | null> {
  if (!ACCEPT.split(",").includes(file.type)) {
    toast.error(`${file.name} isn't a PNG, JPEG or WebP image`);
    return null;
  }
  try {
    return await getBackend().stageImageBytes(file.name, new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    const { title, description } = errorMessage(err);
    toast.error(title, { description });
    return null;
  }
}

async function pickOne(): Promise<StagedImage | null> {
  try {
    return (await getBackend().pickImages(false))[0] ?? null;
  } catch (err) {
    const { title, description } = errorMessage(err);
    toast.error(title, { description });
    return null;
  }
}

function ImageSlot({ image, label, onChange, large }: { image: StagedImage | null; label: string; onChange: (img: StagedImage | null) => void; large?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) void stageFile(file).then((img) => img && onChange(img));
      }}
      className={cn(
        "group relative flex flex-col items-center justify-center overflow-hidden rounded-panel border border-dashed transition-soft",
        large ? "aspect-[4/3]" : "aspect-square",
        over ? "border-accent-border bg-accent-softer" : "border-border bg-field hover:border-border-strong",
      )}
    >
      {image ? (
        <>
          <img src={image.url} alt={label} className="absolute inset-0 size-full object-contain" />
          <div className="absolute right-1.5 top-1.5 opacity-0 transition-soft group-hover:opacity-100">
            <IconButton label="Remove image" size="icon-xs" variant="secondary" onClick={() => onChange(null)}>
              <X />
            </IconButton>
          </div>
          <span className="surface-floating absolute bottom-1.5 left-1.5 rounded-control px-1.5 py-0.5 text-2xs text-fg">{label}</span>
        </>
      ) : (
        <button type="button" onClick={() => void pickOne().then((img) => img && onChange(img))} className="focus-gradient flex size-full flex-col items-center justify-center gap-1.5 text-muted hover:text-fg">
          <ImagePlus className={large ? "size-6" : "size-4"} />
          <span className="text-xs">{large ? "Drop an image or click to browse" : label}</span>
          {large && <span className="text-2xs text-subtle">PNG, JPEG or WebP</span>}
        </button>
      )}
    </div>
  );
}

function StyleCards() {
  const style = useCreate((s) => s.style);
  const set = useCreate((s) => s.set);
  return (
    <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Style">
      {(Object.keys(STYLE_LABEL) as Style[]).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={style === s}
          onClick={() => set({ style: s })}
          className={cn(
            "focus-gradient flex flex-col items-center gap-1 rounded-control border p-1.5 transition-soft",
            style === s ? "border-accent-border bg-accent-softer text-fg" : "border-border bg-field text-muted hover:border-border-strong hover:text-fg",
          )}
        >
          <span className="h-8 w-11">
            <StyleArt style={s} />
          </span>
          <span className="text-2xs">{STYLE_LABEL[s]}</span>
        </button>
      ))}
    </div>
  );
}

function ProviderSelect() {
  const providers = useProviders((s) => s.list);
  const load = useProviders((s) => s.load);
  const provider = useCreate((s) => s.provider);
  const set = useCreate((s) => s.set);
  const defaultProvider = useSettings((s) => s.settings.defaultProvider);
  useEffect(() => {
    void load();
  }, [load]);
  if (!providers.length) return null;
  const value = provider ?? defaultProvider;
  return (
    <Select<ProviderId>
      ariaLabel="Provider"
      size="sm"
      value={value}
      onChange={(v) => set({ provider: v })}
      options={providers.map((p) => ({ value: p.id, label: p.available ? p.name : `${p.name} (unavailable)` }))}
    />
  );
}

export function CreatePanel() {
  const c = useCreate();
  const [advanced, setAdvanced] = useState(false);
  const blocker = generateBlocker();

  // Every generation starts its own project; Refine, Retexture and Rig add versions to the open one.
  const go = () => void submitGenerate();

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          go();
        }
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <Tabs value={c.mode} onValueChange={(v) => c.set({ mode: v as InputMode })} className="shrink-0">
          <TabsList className="w-full [&>*]:flex-1">
            <TabsTrigger value="text" icon={<Type />}>
              Text
            </TabsTrigger>
            <TabsTrigger value="image" icon={<ImagePlus />}>
              Image
            </TabsTrigger>
            <TabsTrigger value="multiview" icon={<Images />}>
              Multi-view
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {c.mode === "image" && <ImageSlot large image={c.image} label="Reference" onChange={(img) => c.set({ image: img })} />}
        {c.mode === "multiview" && (
          <div className="grid grid-cols-3 gap-1.5">
            {(["front", "side", "back"] as ViewSlot[]).map((v) => (
              <ImageSlot key={v} image={c.views[v]} label={v[0]!.toUpperCase() + v.slice(1)} onChange={(img) => c.setView(v, img)} />
            ))}
          </div>
        )}

        <div className="space-y-1.5">
          <SectionLabel
            action={
              <Button
                variant="ghost"
                size="xs"
                icon={<WandSparkles />}
                disabled={!c.prompt.trim()}
                disabledReason="Type an idea first"
                onClick={() => c.set({ prompt: enhancePrompt(c.prompt, c.style).slice(0, PROMPT_MAX) })}
              >
                Enhance
              </Button>
            }
          >
            {c.mode === "text" ? "Prompt" : "Prompt (optional)"}
          </SectionLabel>
          <Textarea
            value={c.prompt}
            maxLength={PROMPT_MAX}
            rows={4}
            onChange={(e) => c.set({ prompt: e.target.value })}
            placeholder="A weathered bronze knight helmet with a red plume…"
            aria-label="Prompt"
          />
          {!c.prompt && c.mode === "text" && (
            <div className="flex flex-wrap gap-1">
              {SUGGESTIONS.slice(0, 4).map((s) => (
                <button key={s} type="button" onClick={() => c.set({ prompt: s })} className="focus-gradient max-w-full truncate rounded-full border border-border bg-field px-2 py-0.5 text-2xs text-muted transition-soft hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <SectionLabel>Style</SectionLabel>
          <StyleCards />
        </div>

        <div className="space-y-1.5">
          <SectionLabel>Quality</SectionLabel>
          <Segmented<Quality>
            label="Quality"
            size="sm"
            className="w-full [&>*]:flex-1"
            value={c.quality}
            onChange={(v) => c.set({ quality: v })}
            options={[
              { value: "draft", label: "Draft", tooltip: "Fast, untextured preview" },
              { value: "standard", label: "Standard" },
              { value: "high", label: "High", tooltip: "More detail, slower and costlier" },
            ]}
          />
        </div>

        <div className="space-y-1.5">
          <SectionLabel>Variants</SectionLabel>
          <Segmented<"1" | "4">
            label="Variants"
            size="sm"
            className="w-full [&>*]:flex-1"
            value={String(c.variants) as "1" | "4"}
            onChange={(v) => c.set({ variants: v === "4" ? 4 : 1 })}
            options={[
              { value: "1", label: "1 model" },
              { value: "4", label: "4 variants" },
            ]}
          />
        </div>

        <div className="space-y-1.5">
          <SectionLabel>Provider</SectionLabel>
          <ProviderSelect />
        </div>

        <div>
          <button type="button" onClick={() => setAdvanced((a) => !a)} className="focus-gradient flex w-full items-center justify-between rounded-control py-1 text-sm text-muted hover:text-fg" aria-expanded={advanced}>
            Advanced
            <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} />
          </button>
          {advanced && (
            <div className="mt-2 space-y-3">
              <div className="flex items-center justify-between">
                <Label>PBR materials</Label>
                <Switch checked={c.pbr} onCheckedChange={(v) => c.set({ pbr: v })} label="PBR materials" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="neg">Negative prompt</Label>
                <Input id="neg" value={c.negativePrompt} onChange={(e) => c.set({ negativePrompt: e.target.value })} placeholder="blurry, extra limbs…" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="faces">Face limit</Label>
                  <Input
                    id="faces"
                    inputMode="numeric"
                    value={c.faceLimit ?? ""}
                    placeholder="Auto"
                    onChange={(e) => {
                      const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                      c.set({ faceLimit: Number.isFinite(n) ? Math.min(n, 500_000) : null });
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="seed">Seed</Label>
                  <Input
                    id="seed"
                    inputMode="numeric"
                    value={c.seed ?? ""}
                    placeholder="Random"
                    onChange={(e) => {
                      const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                      c.set({ seed: Number.isFinite(n) ? n : null });
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 border-t border-divider p-3">
        <CostEstimate />
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          loading={c.submitting}
          disabled={Boolean(blocker)}
          disabledReason={blocker}
          onClick={go}
          icon={<Sparkles />}
          iconRight={!c.submitting ? <Kbd keys="Ctrl+Enter" tone="inverse" className="ml-1 [&_kbd]:border-0 [&_kbd]:bg-[rgb(255_255_255/0.18)] [&_kbd]:text-on-accent" /> : undefined}
        >
          Generate
        </Button>
      </div>
    </div>
  );
}
