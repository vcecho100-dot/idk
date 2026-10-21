import { useEffect, useState } from "react";
import { Bone, Download, Heart, Paintbrush, RotateCcw, Sparkle, Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { EmptyState, SectionLabel } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CostEstimate } from "@/features/create/CostEstimate";
import { renameProject, toggleFavorite } from "@/features/library/actions";
import { errorMessage, getBackend } from "@/lib/backend";
import type { AnimationPreset, JobKind, ProviderId, Style, Version } from "@/lib/backend/types";
import { PROVIDER_LABEL, STYLE_LABEL } from "@/lib/providers";
import { formatBytes, formatCount, formatRelative } from "@/lib/utils";
import { useJobs } from "@/stores/jobs";
import { providerById, useProviders } from "@/stores/providers";
import { useSettings } from "@/stores/settings";
import { hasEdits, selectedVersion, useStudio } from "@/stores/studio";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-subtle">{k}</span>
      <span className="tabular truncate text-right text-fg">{v}</span>
    </div>
  );
}

function InfoTab({ version }: { version: Version }) {
  const detail = useStudio((s) => s.detail)!;
  const p = detail.project;
  const [name, setName] = useState(p.name);
  const stats = version.stats;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="pname">Name</Label>
        <div className="flex gap-1">
          <Input
            id="pname"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== p.name && void renameProject(p, name.trim())}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <IconButton label={p.favorite ? "Remove from favorites" : "Add to favorites"} active={p.favorite} onClick={() => void toggleFavorite(p)}>
            {p.favorite ? <Heart className="fill-current" /> : <Heart />}
          </IconButton>
        </div>
      </div>
      {p.prompt && (
        <div className="space-y-1">
          <SectionLabel>Prompt</SectionLabel>
          <p className="rounded-control bg-field px-2.5 py-2 text-sm text-muted">{p.prompt}</p>
        </div>
      )}
      <div>
        <SectionLabel>Version</SectionLabel>
        <Row k="Label" v={version.label} />
        <Row k="Created" v={formatRelative(version.createdAt)} />
        <Row k="Provider" v={version.provider ? PROVIDER_LABEL[version.provider] : "Local"} />
        {p.style && <Row k="Style" v={STYLE_LABEL[p.style]} />}
        <Row k="File size" v={formatBytes(version.fileSize)} />
      </div>
      {stats && (
        <div>
          <SectionLabel>Geometry</SectionLabel>
          <Row k="Triangles" v={formatCount(stats.triangles)} />
          <Row k="Vertices" v={formatCount(stats.vertices)} />
          <Row k="Materials" v={String(stats.materials)} />
          <Row k="Textures" v={stats.textures ? `${stats.textures} · ${stats.maxTextureSize}px` : "none"} />
          <Row k="Rigged" v={stats.hasSkin ? "Yes" : "No"} />
          {stats.animations.length > 0 && <Row k="Animations" v={stats.animations.join(", ")} />}
        </div>
      )}
    </div>
  );
}

async function runJob(kind: JobKind, fn: () => Promise<string>): Promise<void> {
  try {
    await fn();
    void useJobs.getState().load();
    toast.success(kind === "refine" ? "Refining…" : kind === "retexture" ? "Retexturing…" : "Rigging…", { description: "A new version appears in the timeline when it's done." });
  } catch (err) {
    const { title, description } = errorMessage(err);
    toast.error(title, { description });
  }
}

function ToolsTab({ version }: { version: Version }) {
  const providers = useProviders((s) => s.list);
  const load = useProviders((s) => s.load);
  const defaultProvider = useSettings((s) => s.settings.defaultProvider);
  const [provider, setProvider] = useState<ProviderId>(version.provider ?? defaultProvider);
  const [texPrompt, setTexPrompt] = useState("");
  const [texStyle, setTexStyle] = useState<Style>("stylized");
  const [pbr, setPbr] = useState(true);
  const [anim, setAnim] = useState<AnimationPreset>("idle");
  const [busy, setBusy] = useState<JobKind | null>(null);
  useEffect(() => {
    void load();
  }, [load]);
  const info = providerById(providers, provider);
  const caps = info?.capabilities;
  const why = (cap: boolean | undefined, what: string) => (!info?.available ? (info?.unavailableReason ?? "Provider unavailable") : !cap ? `${info.name} can't ${what}` : null);
  const req = { projectId: version.projectId, versionId: version.id, provider };
  const go = async (kind: JobKind, fn: () => Promise<string>) => {
    setBusy(kind);
    await runJob(kind, fn);
    setBusy(null);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <SectionLabel>Provider</SectionLabel>
        <Select<ProviderId> ariaLabel="Provider" size="sm" value={provider} onChange={setProvider} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
      </div>

      <section className="space-y-2">
        <SectionLabel>Refine</SectionLabel>
        <p className="text-xs text-muted">Regenerates this model at high detail with full textures.</p>
        <CostEstimate kind="refine" provider={provider} />
        <Button className="w-full" icon={<Sparkle />} loading={busy === "refine"} disabled={Boolean(why(caps?.refine, "refine"))} disabledReason={why(caps?.refine, "refine")} onClick={() => void go("refine", () => getBackend().refine(req))}>
          Refine
        </Button>
      </section>

      <section className="space-y-2">
        <SectionLabel>Retexture</SectionLabel>
        <Textarea rows={2} value={texPrompt} onChange={(e) => setTexPrompt(e.target.value)} placeholder="Rusty iron with moss in the cracks…" aria-label="Texture prompt" />
        <Select<Style> ariaLabel="Texture style" size="sm" value={texStyle} onChange={setTexStyle} options={(Object.keys(STYLE_LABEL) as Style[]).map((s) => ({ value: s, label: STYLE_LABEL[s] }))} />
        <div className="flex items-center justify-between">
          <Label>PBR maps</Label>
          <Switch checked={pbr} onCheckedChange={setPbr} label="PBR maps" />
        </div>
        <CostEstimate kind="retexture" provider={provider} />
        <Button
          className="w-full"
          icon={<Paintbrush />}
          loading={busy === "retexture"}
          disabled={Boolean(why(caps?.retexture, "retexture")) || !texPrompt.trim()}
          disabledReason={why(caps?.retexture, "retexture") ?? (!texPrompt.trim() ? "Describe the new texture" : null)}
          onClick={() => void go("retexture", () => getBackend().retexture({ ...req, prompt: texPrompt.trim(), style: texStyle, pbr }))}
        >
          Retexture
        </Button>
      </section>

      <section className="space-y-2">
        <SectionLabel>Rig & animate</SectionLabel>
        <Segmented<AnimationPreset>
          label="Animation"
          size="sm"
          className="w-full [&>*]:flex-1"
          value={anim}
          onChange={setAnim}
          options={[
            { value: "idle", label: "Idle" },
            { value: "walk", label: "Walk" },
            { value: "run", label: "Run" },
          ]}
        />
        <CostEstimate kind="rig" provider={provider} />
        <Button className="w-full" icon={<Bone />} loading={busy === "rig"} disabled={Boolean(why(caps?.rig, "rig models"))} disabledReason={why(caps?.rig, "rig models")} onClick={() => void go("rig", () => getBackend().rig({ ...req, animation: anim }))}>
          Auto-rig
        </Button>
      </section>
    </div>
  );
}

function MaterialsTab() {
  const edits = useStudio((s) => s.edits);
  const setEdits = useStudio((s) => s.setEdits);
  const resetEdits = useStudio((s) => s.resetEdits);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">Live, non-destructive adjustments. Undo with Ctrl+Z.</p>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="tint">Tint</Label>
        <input id="tint" type="color" value={edits.tint} onChange={(e) => setEdits({ tint: e.target.value, tintAmount: edits.tintAmount || 0.5 })} className="h-7 w-12 cursor-pointer rounded-control border border-border bg-field" />
      </div>
      <Slider label="Tint strength" value={edits.tintAmount} onChange={(v) => setEdits({ tintAmount: v })} format={(v) => `${Math.round(v * 100)}%`} />
      <Slider label="Roughness" value={edits.roughness ?? 0.5} onChange={(v) => setEdits({ roughness: v })} format={(v) => (edits.roughness === null ? "Original" : v.toFixed(2))} />
      <Slider label="Metalness" value={edits.metalness ?? 0} onChange={(v) => setEdits({ metalness: v })} format={(v) => (edits.metalness === null ? "Original" : v.toFixed(2))} />
      <Slider label="Glow" value={edits.emissive} max={3} onChange={(v) => setEdits({ emissive: v })} format={(v) => v.toFixed(1)} />
      <Button className="w-full" variant="outline" icon={<RotateCcw />} disabled={!hasEdits(edits)} disabledReason="Nothing changed" onClick={resetEdits}>
        Reset materials
      </Button>
    </div>
  );
}

function ExportTab({ version }: { version: Version }) {
  const name = useStudio((s) => s.detail?.project.name ?? "model");
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await getBackend().readModel(version.id));
      const safe = name.replace(/[^\w\- ]+/g, "").trim() || "model";
      const res = await getBackend().exportFiles({ suggestedName: `${safe}.glb`, format: "glb", files: [{ name: `${safe}.glb`, bytes }] });
      if (res) toast.success("Exported", { description: res.path });
    } catch (err) {
      const { title, description } = errorMessage(err);
      toast.error(title, { description });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Binary glTF works in Godot, Unity, Unreal, Blender and on the web.</p>
      <Button variant="primary" className="w-full" icon={<Download />} loading={busy} onClick={() => void download()}>
        Download GLB · {formatBytes(version.fileSize)}
      </Button>
    </div>
  );
}

export function ModelPanel() {
  const s = useStudio();
  const version = selectedVersion(s);
  const [tab, setTab] = useState("info");
  if (!version || !s.detail) {
    return <EmptyState className="flex-1" icon={<Star />} title="No model selected" description="Your model's details, tools and export options show up here." />;
  }
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex-1" variant="underline">
      <TabsList className="px-3 pt-2">
        <TabsTrigger value="info">Info</TabsTrigger>
        <TabsTrigger value="tools">Tools</TabsTrigger>
        <TabsTrigger value="materials">Materials</TabsTrigger>
        <TabsTrigger value="export">Export</TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <TabsContent value="info">
          <InfoTab key={`${s.detail.project.id}:${s.detail.project.name}`} version={version} />
        </TabsContent>
        <TabsContent value="tools">
          <ToolsTab key={version.id} version={version} />
        </TabsContent>
        <TabsContent value="materials">
          <MaterialsTab />
        </TabsContent>
        <TabsContent value="export">
          <ExportTab version={version} />
        </TabsContent>
      </div>
    </Tabs>
  );
}
