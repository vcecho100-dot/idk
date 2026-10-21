import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  CircleAlert,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  KeyRound,
  Monitor,
  Palette,
  PlugZap,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/brand/Logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Badge, SectionLabel, Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage, getBackend } from "@/lib/backend";
import type {
  Accent,
  ConnectionTest,
  EnginePreset,
  ExportFormat,
  LocalServerKind,
  ProviderInfo,
  ProviderUsage,
  SystemInfo,
  UpdateInfo,
  ViewportQuality,
} from "@/lib/backend/types";
import { APP_VERSION, REPO_URL } from "@/lib/platform";
import { cn, formatRelative } from "@/lib/utils";
import { navigate, type SettingsSection } from "@/stores/route";
import { useLibrary } from "@/stores/library";
import { useJobs } from "@/stores/jobs";
import { useSettings } from "@/stores/settings";

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "general", label: "Appearance", icon: <Palette /> },
  { id: "providers", label: "Providers", icon: <PlugZap /> },
  { id: "viewport", label: "Viewport", icon: <Monitor /> },
  { id: "export", label: "Export & integrations", icon: <SlidersHorizontal /> },
  { id: "updates", label: "Updates", icon: <RefreshCw /> },
  { id: "privacy", label: "Privacy & data", icon: <Shield /> },
  { id: "about", label: "About", icon: <Info /> },
];

const desktop = () => getBackend().kind === "desktop";
const DESKTOP_ONLY = "Available in the Shift3D desktop app";

function fail(err: unknown) {
  const { title, description } = errorMessage(err);
  toast.error(title, { description });
}

/* --------------------------------- Layout --------------------------------- */

function Row({ title, description, children, disabledReason }: { title: ReactNode; description?: ReactNode; children: ReactNode; disabledReason?: string }) {
  const row = (
    <div className={cn("flex items-center justify-between gap-6 border-b border-divider py-3.5 last:border-b-0", disabledReason && "opacity-60")}>
      <div className="min-w-0">
        <div className="text-base text-fg">{title}</div>
        {description && <div className="mt-0.5 text-sm text-muted">{description}</div>}
      </div>
      <div className={cn("flex shrink-0 items-center gap-2", disabledReason && "pointer-events-none")}>{children}</div>
    </div>
  );
  return disabledReason ? (
    <Tooltip content={disabledReason}>
      <div tabIndex={0}>{row}</div>
    </Tooltip>
  ) : (
    row
  );
}

function Card({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-panel px-5 py-4">
      <div className="mb-1 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-md font-semibold text-fg">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------- Appearance ------------------------------- */

const ACCENTS: { id: Accent; label: string }[] = [
  { id: "aurora", label: "Aurora" },
  { id: "sunset", label: "Sunset" },
  { id: "lagoon", label: "Lagoon" },
  { id: "orchid", label: "Orchid" },
  { id: "ocean", label: "Ocean" },
  { id: "ember", label: "Ember" },
];

function AppearanceSection() {
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  return (
    <Card title="Appearance">
      <Row title="Theme">
        <Segmented<"dark" | "light">
          label="Theme"
          value={s.theme}
          onChange={(theme) => void update({ theme })}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
        />
      </Row>
      <Row title="Accent color" description="Used sparingly — primary actions, progress and focus.">
        <div className="flex gap-1.5" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((a) => (
            <Tooltip key={a.id} content={a.label}>
              <button
                type="button"
                role="radio"
                aria-checked={s.accent === a.id}
                aria-label={a.label}
                data-accent={a.id}
                onClick={() => void update({ accent: a.id })}
                className={cn(
                  "focus-gradient flex size-7 items-center justify-center rounded-full bg-accent-gradient ring-offset-2 ring-offset-[var(--panel)] transition-transform [--focus-radius:999px] hover:scale-110",
                  s.accent === a.id && "ring-2 ring-[var(--border-strong)]",
                )}
              >
                {s.accent === a.id && <Check className="size-3.5 text-on-accent" />}
              </button>
            </Tooltip>
          ))}
        </div>
      </Row>
      <Row title="Window translucency" description="Windows 11 Mica — your wallpaper tints the window." disabledReason={desktop() ? undefined : DESKTOP_ONLY}>
        <Switch label="Window translucency" checked={s.mica} onCheckedChange={(mica) => void update({ mica })} />
      </Row>
      <Row title="Reduce motion" description="Turns off animations and transitions. Shift3D also follows your Windows setting.">
        <Switch label="Reduce motion" checked={s.reducedMotion} onCheckedChange={(reducedMotion) => void update({ reducedMotion })} />
      </Row>
      <Row title="Notifications" description="Tell me when a generation finishes while Shift3D is in the background." disabledReason={desktop() ? undefined : DESKTOP_ONLY}>
        <Switch label="Notifications" checked={s.notifications} onCheckedChange={(notifications) => void update({ notifications })} />
      </Row>
    </Card>
  );
}

/* -------------------------------- Providers -------------------------------- */

function KeyEditor({ p, onChanged }: { p: ProviderInfo; onChanged: () => void }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await getBackend().setProviderKey(p.id, value.trim());
      setValue("");
      toast.success(`${p.name} key saved`, { description: "Stored in Windows Credential Manager." });
      onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await getBackend().clearProviderKey(p.id);
      toast.success(`${p.name} key removed`);
      onChanged();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && value.trim() && void save()}
        placeholder={p.configured ? "•••••••••••• saved — paste to replace" : p.id === "hfspace" ? "Optional free token (hf_…)" : "Paste your API key"}
        aria-label={`${p.name} API key`}
        autoComplete="off"
        leading={<KeyRound />}
        trailing={
          <button type="button" aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)} className="flex size-7 items-center justify-center text-subtle hover:text-fg [&_svg]:size-3.5">
            {show ? <EyeOff /> : <Eye />}
          </button>
        }
        className="flex-1"
      />
      <Button onClick={() => void save()} loading={busy} disabled={!value.trim()} disabledReason="Paste a key first">
        Save
      </Button>
      {p.configured && p.id !== "mock" && (
        <Button variant="ghost" onClick={() => void remove()}>
          Remove
        </Button>
      )}
    </div>
  );
}

function ProviderCard({ p, usage, gpu, onChanged }: { p: ProviderInfo; usage?: ProviderUsage; gpu: SystemInfo["gpus"][number] | undefined; onChanged: () => void }) {
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  const [test, setTest] = useState<ConnectionTest | { ok: false; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await getBackend().testProvider(p.id));
    } catch (err) {
      setTest({ ok: false, message: errorMessage(err).title });
    } finally {
      setTesting(false);
    }
  };
  const canTest = p.id === "mock" || (desktop() && (!p.requiresKey || p.configured));
  const isDefault = s.defaultProvider === p.id;
  const keyed = p.requiresKey || p.id === "hfspace";

  return (
    <section className={cn("rounded-panel border bg-panel px-5 py-4", isDefault ? "border-accent-border" : "border-border")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-md font-semibold text-fg">{p.name}</h3>
            {p.free && <Badge tone="success">Free</Badge>}
            {isDefault && <Badge tone="accent">Default</Badge>}
            {p.available ? <Badge tone="neutral">Ready</Badge> : <Badge tone="warning">Needs setup</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted">{p.description}</p>
          {!p.available && p.unavailableReason && <p className="mt-1 text-xs text-warning">{p.unavailableReason}</p>}
        </div>
        <div className="flex shrink-0 gap-1.5">
          {p.dashboardUrl && (
            <Button size="sm" variant="ghost" iconRight={<ExternalLink />} onClick={() => void getBackend().openExternal(p.dashboardUrl!).catch(fail)}>
              {p.requiresKey ? "Get a key" : "Website"}
            </Button>
          )}
          <Button
            size="sm"
            disabled={isDefault || !p.available}
            disabledReason={isDefault ? "Already the default" : (p.unavailableReason ?? undefined)}
            onClick={() => void update({ defaultProvider: p.id })}
          >
            Use by default
          </Button>
        </div>
      </div>

      {keyed && (
        <div className={cn("mt-3", !desktop() && "pointer-events-none opacity-60")} title={desktop() ? undefined : DESKTOP_ONLY}>
          <KeyEditor p={p} onChanged={onChanged} />
        </div>
      )}

      {p.id === "local" && (
        <div className="mt-3 space-y-3">
          {gpu && (
            <div className="flex items-start gap-2 rounded-control border border-border bg-field px-3 py-2 text-sm">
              <Cpu className="mt-0.5 size-4 shrink-0 text-muted" />
              <div>
                <span className="text-fg">{gpu.name}</span>
                {gpu.vramMb > 0 && <span className="text-muted"> · {(gpu.vramMb / 1024).toFixed(gpu.vramMb % 1024 ? 1 : 0)} GB VRAM</span>}
                <div className="text-xs text-muted">
                  {gpu.vramMb >= 15000
                    ? "Enough for full Hunyuan3D-2 with textures, or TRELLIS."
                    : gpu.vramMb >= 5500
                      ? "Good for Hunyuan3D-2mini shapes (6 GB). Shift3D textures them by projecting your image."
                      : gpu.vramMb > 0
                        ? "Under 6 GB — local generation will likely run out of memory. Use the free web option instead."
                        : "VRAM unknown."}
                </div>
              </div>
            </div>
          )}
          <div className={cn("grid grid-cols-[1fr_200px] gap-2", !desktop() && "pointer-events-none opacity-60")}>
            <div className="space-y-1.5">
              <Label htmlFor="local-url">Server address</Label>
              <Input
                id="local-url"
                defaultValue={s.localServerUrl}
                onBlur={(e) => e.target.value !== s.localServerUrl && void update({ localServerUrl: e.target.value.trim() })}
                placeholder="http://127.0.0.1:8081"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Server type</Label>
              <Select<LocalServerKind>
                ariaLabel="Server type"
                value={s.localServerKind}
                onChange={(localServerKind) => void update({ localServerKind })}
                options={[
                  { value: "hunyuan3d", label: "Hunyuan3D-2 API", description: "api_server.py — 6 GB friendly" },
                  { value: "hunyuan3d-gradio", label: "Hunyuan3D-2 Gradio", description: "gradio_app.py" },
                  { value: "trellis", label: "TRELLIS Gradio", description: "needs ~16 GB" },
                ]}
              />
            </div>
          </div>
          <Row title="Server paints textures" description="Only if you started api_server.py with --enable_tex (needs ~16 GB VRAM). Otherwise Shift3D projects your image." disabledReason={desktop() ? undefined : DESKTOP_ONLY}>
            <Switch label="Server paints textures" checked={s.localTexture} onCheckedChange={(localTexture) => void update({ localTexture })} />
          </Row>
          <Row title="Use free web generation when needed" description="If your server is offline, or for text prompts (local servers only take images), use the free Hugging Face Spaces." disabledReason={desktop() ? undefined : DESKTOP_ONLY}>
            <Switch label="Use free web generation when needed" checked={s.autoWebFallback} onCheckedChange={(autoWebFallback) => void update({ autoWebFallback })} />
          </Row>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-divider pt-3">
        <Button size="sm" icon={<PlugZap />} loading={testing} disabled={!canTest} disabledReason={!desktop() ? DESKTOP_ONLY : "Add a key first"} onClick={() => void runTest()}>
          Test connection
        </Button>
        {test && (
          <span className={cn("flex items-center gap-1.5 text-sm", test.ok ? "text-success" : "text-danger")}>
            {test.ok ? <Check className="size-4" /> : <CircleAlert className="size-4" />}
            {test.message}
            {"balance" in test && test.balance && <span className="text-muted">· {test.balance}</span>}
            {"latencyMs" in test && test.latencyMs ? <span className="tabular text-subtle">· {test.latencyMs} ms</span> : null}
          </span>
        )}
        <div className="flex-1" />
        <span className="tabular text-xs text-subtle">
          {usage && usage.jobs > 0
            ? `${usage.succeeded} done · ${usage.failed} failed${usage.creditsSpent ? ` · ${Math.round(usage.creditsSpent)} credits` : ""} · last ${formatRelative(usage.lastUsedAt ?? "")}`
            : "Not used yet"}
        </span>
      </div>
    </section>
  );
}

function ProvidersSection() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [usage, setUsage] = useState<ProviderUsage[]>([]);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const reload = () => {
    void getBackend().listProviders().then(setProviders).catch(fail);
    void getBackend().providerUsage().then(setUsage).catch(() => {});
  };
  useEffect(() => {
    reload();
    void getBackend().systemInfo().then(setSys).catch(() => {});
  }, []);
  const gpu = sys?.gpus[0];
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Keys are stored in Windows Credential Manager and never leave the Shift3D engine — not even to this screen.
        {!desktop() && " In the browser version only the offline demo is available."}
      </p>
      {!providers
        ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-36 rounded-panel" />)
        : providers.map((p) => <ProviderCard key={p.id} p={p} usage={usage.find((u) => u.provider === p.id)} gpu={p.id === "local" ? gpu : undefined} onChanged={reload} />)}
    </div>
  );
}

/* --------------------------------- Viewport -------------------------------- */

function ViewportSection() {
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  return (
    <Card title="Viewport">
      <Row title="Quality" description="Higher quality adds ambient occlusion and sharper rendering. Low is best for older or laptop GPUs.">
        <Segmented<ViewportQuality>
          label="Quality"
          value={s.viewportQuality}
          onChange={(viewportQuality) => void update({ viewportQuality })}
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "ultra", label: "Ultra" },
          ]}
        />
      </Row>
      <Row title="Frame-rate cap" description="Limits continuous animation (turntable, playback, effects) to save power.">
        <Segmented<string>
          label="Frame-rate cap"
          value={String(s.fpsCap)}
          onChange={(v) => void update({ fpsCap: Number(v) })}
          options={[
            { value: "30", label: "30" },
            { value: "60", label: "60" },
            { value: "120", label: "120" },
            { value: "0", label: "Off" },
          ]}
        />
      </Row>
    </Card>
  );
}

/* --------------------------------- Export --------------------------------- */

function ExportSection() {
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  const load = useSettings((x) => x.load);
  const pick = async (fn: () => Promise<string | null>) => {
    try {
      if (await fn()) await load();
    } catch (err) {
      fail(err);
    }
  };
  const d = desktop() ? undefined : DESKTOP_ONLY;
  return (
    <div className="space-y-3">
      <Card title="Defaults">
        <Row title="Export format">
          <Select<ExportFormat>
            ariaLabel="Default export format"
            value={s.defaultExportFormat}
            onChange={(defaultExportFormat) => void update({ defaultExportFormat })}
            className="w-[200px]"
            options={[
              { value: "glb", label: "GLB (recommended)" },
              { value: "gltf", label: "glTF + files" },
              { value: "obj", label: "OBJ + MTL" },
              { value: "stl", label: "STL" },
              { value: "usdz", label: "USDZ" },
            ]}
          />
        </Row>
        <Row title="Engine preset">
          <Select<EnginePreset>
            ariaLabel="Default engine preset"
            value={s.defaultEnginePreset}
            onChange={(defaultEnginePreset) => void update({ defaultEnginePreset })}
            className="w-[200px]"
            options={[
              { value: "none", label: "None" },
              { value: "godot", label: "Godot" },
              { value: "unity", label: "Unity" },
              { value: "unreal", label: "Unreal" },
              { value: "blender", label: "Blender" },
              { value: "print", label: "3D print" },
            ]}
          />
        </Row>
        <Row title="Export folder" description={s.outputDir || "Downloads"} disabledReason={d}>
          <Button icon={<FolderOpen />} onClick={() => void pick(() => getBackend().pickOutputDir())}>
            Change…
          </Button>
        </Row>
      </Card>
      <Card title="Integrations">
        <Row title="Godot project" description={s.godotProjectPath ?? "Not linked — models go to res://models/ once linked."} disabledReason={d}>
          {s.godotProjectPath && (
            <Button variant="ghost" onClick={() => void update({ godotProjectPath: null })}>
              Unlink
            </Button>
          )}
          <Button icon={<FolderOpen />} onClick={() => void pick(() => getBackend().pickGodotProject())}>
            {s.godotProjectPath ? "Change…" : "Choose…"}
          </Button>
        </Row>
        <Row title="Blender" description={s.blenderPath ?? "Not found yet."} disabledReason={d}>
          <Button
            variant="ghost"
            onClick={() =>
              void getBackend()
                .detectBlender()
                .then(async (p) => {
                  if (p) {
                    await load();
                    toast.success("Found Blender", { description: p });
                  } else toast.message("Blender wasn't found", { description: "Install it from blender.org or locate blender.exe." });
                })
                .catch(fail)
            }
          >
            Detect
          </Button>
          <Button icon={<FolderOpen />} onClick={() => void pick(() => getBackend().pickBlenderPath())}>
            Locate…
          </Button>
        </Row>
      </Card>
    </div>
  );
}

/* --------------------------------- Updates --------------------------------- */

function UpdatesSection() {
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const d = desktop() ? undefined : "The web version is always up to date";
  const check = async () => {
    setChecking(true);
    try {
      setInfo(await getBackend().checkForUpdates(s.updateChannel));
    } catch (err) {
      fail(err);
    } finally {
      setChecking(false);
    }
  };
  return (
    <Card title="Updates" description={`You're on Shift3D ${APP_VERSION}. Updates are signed and verified before they install.`}>
      <Row title="Check for updates" description={info ? (info.available ? `Version ${info.version} is available.` : "You're up to date.") : "Shift3D checks GitHub Releases."} disabledReason={d}>
        {info?.available && (
          <Button
            variant="primary"
            icon={<Download />}
            loading={installing}
            onClick={() => {
              setInstalling(true);
              void getBackend()
                .installUpdate()
                .catch(fail)
                .finally(() => setInstalling(false));
            }}
          >
            Install & restart
          </Button>
        )}
        <Button icon={<RefreshCw />} loading={checking} onClick={() => void check()}>
          Check now
        </Button>
      </Row>
      <Row title="Channel" description="Beta gets new features first." disabledReason={d}>
        <Segmented<"stable" | "beta">
          label="Update channel"
          value={s.updateChannel}
          onChange={(updateChannel) => void update({ updateChannel })}
          options={[
            { value: "stable", label: "Stable" },
            { value: "beta", label: "Beta" },
          ]}
        />
      </Row>
      <Row title="Check automatically" description="Once a day, quietly." disabledReason={d}>
        <Switch label="Check automatically" checked={s.autoCheckUpdates} onCheckedChange={(autoCheckUpdates) => void update({ autoCheckUpdates })} />
      </Row>
    </Card>
  );
}

/* --------------------------------- Privacy --------------------------------- */

function PrivacySection() {
  const [confirm, setConfirm] = useState(false);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  useEffect(() => void getBackend().systemInfo().then(setSys).catch(() => {}), []);
  const reset = async () => {
    try {
      await getBackend().resetAppData();
      await Promise.all([useSettings.getState().load(), useLibrary.getState().load(), useJobs.getState().load()]);
      toast.success("Shift3D was reset");
      navigate({ name: "home" });
    } catch (err) {
      fail(err);
    }
  };
  return (
    <div className="space-y-3">
      <Card title="No telemetry. Ever.">
        <ul className="mt-2 space-y-2 text-sm text-muted">
          <li className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-success" />
            Shift3D sends no analytics, crash reports or usage data — not even anonymously.
          </li>
          <li className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-success" />
            Prompts and images go only to the provider you choose. The offline demo and Local GPU never leave your computer.
          </li>
          <li className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-success" />
            API keys live in Windows Credential Manager, never in files or this window.
          </li>
        </ul>
      </Card>
      <Card title="Your data">
        <Row title="Models" description={sys?.libraryDir ?? "…"}>
          {desktop() && (
            <Button icon={<FolderOpen />} onClick={() => void getBackend().reveal({ kind: "path", path: sys?.libraryDir ?? "" }).catch(fail)}>
              Open folder
            </Button>
          )}
        </Row>
        <Row title="App data" description={sys?.dataDir ?? "…"}>
          <span />
        </Row>
        <Row title="Reset all app data" description="Clears settings, saved keys, the job history and the library index. Your model files in Documents\Shift3D stay where they are.">
          <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirm(true)}>
            Reset…
          </Button>
        </Row>
      </Card>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title="Reset Shift3D?" description="Settings, saved API keys, job history and the library index will be cleared. This can't be undone." className="w-[440px]">
          <DialogFooter className="border-t-0 pt-0">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                void reset();
              }}
            >
              Reset everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------------------------- About ---------------------------------- */

const CREDITS = [
  ["Tauri", "MIT / Apache-2.0"],
  ["React, React Three Fiber, drei", "MIT"],
  ["three.js", "MIT"],
  ["glTF-Transform, meshoptimizer, Draco", "MIT / Apache-2.0"],
  ["Radix UI, cmdk, Motion, Zustand, Zod, Sonner", "MIT"],
  ["Geist & Geist Mono", "SIL Open Font License 1.1"],
  ["lucide icons", "ISC"],
  ["Khronos glTF Sample Assets (Fox, Cesium Man, Milk Truck, Duck, Traffic Cone, Sheen Chair)", "CC0 / CC-BY 4.0 / SCEA"],
];

function AboutSection() {
  return (
    <Card title="About">
      <div className="flex items-center gap-4 py-3">
        <Logo size={40} wordmarkClassName="text-2xl" />
        <div className="text-sm text-muted">
          Version <span className="tabular text-fg">{APP_VERSION}</span> · Shift ideas into 3D.
        </div>
      </div>
      <SectionLabel className="mt-2">Open-source credits</SectionLabel>
      <ul className="mt-1 divide-y divide-divider text-sm">
        {CREDITS.map(([name, lic]) => (
          <li key={name} className="flex justify-between gap-4 py-2">
            <span className="text-fg">{name}</span>
            <span className="shrink-0 text-subtle">{lic}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button icon={<ExternalLink />} onClick={() => void getBackend().openExternal(REPO_URL).catch(fail)}>
          GitHub
        </Button>
        <Button variant="ghost" onClick={() => void getBackend().openExternal(`${REPO_URL}/blob/main/LICENSE`).catch(fail)}>
          MIT License
        </Button>
      </div>
    </Card>
  );
}

/* ---------------------------------- Screen ---------------------------------- */

export default function SettingsScreen({ section }: { section: SettingsSection }) {
  return (
    <div className="flex min-h-0 flex-1">
      <nav className="w-[220px] shrink-0 border-r border-divider p-3" aria-label="Settings sections">
        <h1 className="px-2 pb-3 pt-1 text-xl font-semibold tracking-tight text-fg">Settings</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => navigate({ name: "settings", section: s.id })}
            aria-current={section === s.id ? "page" : undefined}
            className={cn(
              "focus-gradient flex h-8 w-full items-center gap-2.5 rounded-control px-2 text-sm transition-soft [&_svg]:size-4",
              section === s.id ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 py-6">
          {section === "general" && <AppearanceSection />}
          {section === "providers" && <ProvidersSection />}
          {section === "viewport" && <ViewportSection />}
          {section === "export" && <ExportSection />}
          {section === "updates" && <UpdatesSection />}
          {section === "privacy" && <PrivacySection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
