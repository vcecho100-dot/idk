import { useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import {
  ArrowRight,
  Armchair,
  Car,
  Castle,
  FolderOpen,
  ImagePlus,
  PawPrint,
  PersonStanding,
  Sparkles,
  Sword,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { EmptyState, SectionLabel } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { CostEstimate } from "@/features/create/CostEstimate";
import { submitGenerate } from "@/features/create/generate";
import { ProjectThumb } from "@/features/library/ProjectThumb";
import { errorMessage, getBackend } from "@/lib/backend";
import type { Style } from "@/lib/backend/types";
import { enhancePrompt, SUGGESTIONS, TEMPLATES, type Template } from "@/lib/prompt";
import { STYLE_LABEL } from "@/lib/providers";
import { cn, formatRelative } from "@/lib/utils";
import { PROMPT_MAX, useCreate } from "@/stores/create";
import { useLibrary } from "@/stores/library";
import { navigate } from "@/stores/route";

const TEMPLATE_ICON: Record<Template["id"], typeof Sword> = {
  character: PersonStanding,
  prop: Armchair,
  weapon: Sword,
  building: Castle,
  creature: PawPrint,
  vehicle: Car,
};

function PromptBox() {
  const prompt = useCreate((s) => s.prompt);
  const style = useCreate((s) => s.style);
  const variants = useCreate((s) => s.variants);
  const submitting = useCreate((s) => s.submitting);
  const set = useCreate((s) => s.set);
  const ref = useRef<HTMLTextAreaElement>(null);
  const blocker = prompt.trim() ? null : "Describe what you want to make";

  useEffect(() => {
    useCreate.getState().set({ mode: "text" });
    ref.current?.focus();
  }, []);

  const go = () => void submitGenerate();

  return (
    <div className="group relative">
      <div className="pointer-events-none absolute -inset-px rounded-[14px] bg-accent-gradient opacity-0 blur-[14px] transition-opacity duration-300 group-focus-within:opacity-25" />
      <div className="relative rounded-[14px] border border-border bg-panel shadow-soft-md transition-soft group-focus-within:border-accent-border">
        <textarea
          ref={ref}
          value={prompt}
          maxLength={PROMPT_MAX}
          onChange={(e) => set({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              go();
            }
          }}
          rows={3}
          placeholder="A stylized treasure chest with gold trim and glowing gems…"
          aria-label="Describe your model"
          className="block w-full resize-none bg-transparent px-5 pb-2 pt-4 text-lg leading-7 text-fg outline-none placeholder:text-subtle"
        />
        <div className="flex items-center gap-2 px-3 pb-3">
          <Tooltip content="Start from an image instead">
            <Button
              variant="ghost"
              size="sm"
              icon={<ImagePlus />}
              onClick={() => {
                set({ mode: "image" });
                navigate({ name: "studio" });
              }}
            >
              Image
            </Button>
          </Tooltip>
          <Select<Style>
            ariaLabel="Style"
            size="sm"
            value={style}
            onChange={(v) => set({ style: v })}
            className="w-[124px] border-transparent bg-transparent hover:bg-hover"
            options={(Object.keys(STYLE_LABEL) as Style[]).map((s) => ({ value: s, label: STYLE_LABEL[s] }))}
          />
          <Segmented<"1" | "4">
            label="Variants"
            size="sm"
            value={String(variants) as "1" | "4"}
            onChange={(v) => set({ variants: v === "4" ? 4 : 1 })}
            options={[
              { value: "1", label: "1 model" },
              { value: "4", label: "4 variants" },
            ]}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<WandSparkles />}
            disabled={!prompt.trim()}
            disabledReason="Type an idea first"
            onClick={() => set({ prompt: enhancePrompt(prompt, style).slice(0, PROMPT_MAX) })}
            tooltip="Rewrite your idea into a detailed, generator-friendly prompt"
          >
            Enhance
          </Button>
          <div className="flex-1" />
          <span className={cn("tabular text-2xs", prompt.length > PROMPT_MAX * 0.9 ? "text-warning" : "text-subtle")}>
            {prompt.length}/{PROMPT_MAX}
          </span>
          <CostEstimate className="max-w-[180px]" />
          <Button
            variant="primary"
            size="md"
            loading={submitting}
            disabled={Boolean(blocker)}
            disabledReason={blocker}
            onClick={go}
            iconRight={!submitting ? <Kbd keys="Ctrl+Enter" tone="inverse" className="ml-1 [&_kbd]:border-0 [&_kbd]:bg-[rgb(255_255_255/0.18)] [&_kbd]:text-on-accent" /> : undefined}
            icon={<Sparkles />}
          >
            Generate
          </Button>
        </div>
      </div>
    </div>
  );
}

function Suggestions() {
  const set = useCreate((s) => s.set);
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      {SUGGESTIONS.slice(0, 5).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => set({ prompt: s })}
          className="focus-gradient h-7 rounded-full border border-border bg-field px-3 text-sm text-muted transition-soft hover:border-border-strong hover:bg-field-hover hover:text-fg"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function Templates() {
  const set = useCreate((s) => s.set);
  return (
    <section>
      <SectionLabel>Start from a template</SectionLabel>
      <div className="mt-2 grid grid-cols-6 gap-2">
        {TEMPLATES.map((t, i) => {
          const Icon = TEMPLATE_ICON[t.id];
          return (
            <motion.button
              key={t.id}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.04 * i, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => {
                set({ prompt: t.prompt, style: t.style, mode: "text" });
                document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Describe your model']")?.focus();
              }}
              className="focus-gradient group flex flex-col items-start gap-3 rounded-panel border border-border bg-panel p-3 text-left transition-soft hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft-md"
            >
              <span className="flex size-9 items-center justify-center rounded-control bg-accent-softer text-muted transition-soft group-hover:text-fg [&_svg]:size-[18px]">
                <Icon />
              </span>
              <span>
                <span className="block text-base font-medium text-fg">{t.label}</span>
                <span className="block text-xs text-subtle">{STYLE_LABEL[t.style]}</span>
              </span>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}

function RecentProjects() {
  const projects = useLibrary((s) => s.projects);
  const recent = useMemo(() => projects.slice(0, 8), [projects]);

  const openFile = async () => {
    try {
      const id = await getBackend().importModel("pick");
      if (id) navigate({ name: "studio", projectId: id });
    } catch (err) {
      const { title, description } = errorMessage(err);
      toast.error(title, { description });
    }
  };

  return (
    <section>
      <SectionLabel
        action={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" icon={<FolderOpen />} onClick={() => void openFile()}>
              Open file
            </Button>
            {projects.length > 0 && (
              <Button variant="ghost" size="xs" iconRight={<ArrowRight />} onClick={() => navigate({ name: "library" })}>
                View all
              </Button>
            )}
          </div>
        }
      >
        Recent projects
      </SectionLabel>
      {recent.length === 0 ? (
        <div className="mt-2 rounded-panel border border-dashed border-border">
          <EmptyState
            icon={<Sparkles />}
            title="Your models will appear here"
            description="Describe something above and press Generate — or drop a .glb anywhere to open it."
          />
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-4 gap-3">
          {recent.map((p, i) => (
            <motion.button
              key={p.id}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.03 * i, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => navigate({ name: "studio", projectId: p.id })}
              className="focus-gradient group overflow-hidden rounded-panel border border-border bg-panel text-left transition-soft hover:border-border-strong hover:shadow-soft-md"
            >
              <ProjectThumb versionId={p.thumbnailVersionId} cacheKey={p.updatedAt} alt={p.name} className="aspect-[4/3] transition-transform duration-300 group-hover:scale-[1.02]" />
              <div className="border-t border-divider px-3 py-2">
                <div className="truncate text-sm font-medium text-fg">{p.name}</div>
                <div className="text-xs text-subtle">{formatRelative(p.updatedAt)}</div>
              </div>
            </motion.button>
          ))}
        </div>
      )}
    </section>
  );
}

export function HomeScreen() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-8 pb-16 pt-[9vh]">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-5"
        >
          <div className="text-center">
            <h1 className="text-4xl font-semibold tracking-[-0.03em] text-fg">What do you want to make?</h1>
            <p className="mt-2 text-md text-muted">Describe it, and Shift3D turns it into a textured, game-ready 3D model.</p>
          </div>
          <PromptBox />
          <Suggestions />
        </motion.div>
        <Templates />
        <RecentProjects />
      </div>
    </div>
  );
}
