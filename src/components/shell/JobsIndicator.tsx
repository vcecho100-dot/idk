import { useId, useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleAlert, Layers, RotateCcw, Square, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { EmptyState, Progress } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage, getBackend } from "@/lib/backend";
import type { Job } from "@/lib/backend/types";
import { cn, formatDuration } from "@/lib/utils";
import { isActive, sortJobs, useJobs } from "@/stores/jobs";
import { useUi } from "@/stores/ui";
import { navigate } from "@/stores/route";
import { PROVIDER_LABEL } from "@/lib/providers";

function ProgressRing({ value, size = 18 }: { value: number; size?: number }) {
  const id = useId();
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--accent-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--accent-to)" }} />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="2" style={{ stroke: "var(--panel-active)" }} />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke={`url(#${id})`}
        strokeDasharray={c}
        initial={false}
        animate={{ strokeDashoffset: c * (1 - Math.max(0.04, value)) }}
        transition={{ type: "spring", stiffness: 120, damping: 24 }}
      />
    </svg>
  );
}

function elapsed(job: Job): string {
  const start = job.startedAt ? new Date(job.startedAt).getTime() : new Date(job.createdAt).getTime();
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  return formatDuration(end - start);
}

function JobRow({ job }: { job: Job }) {
  const active = isActive(job);
  const upsert = useJobs((s) => s.upsert);
  const remove = useJobs((s) => s.remove);
  const setJobsOpen = useUi((s) => s.setJobs);

  const run = async (fn: () => Promise<void>, optimistic?: Partial<Job>) => {
    const prev = job;
    if (optimistic) upsert({ ...job, ...optimistic });
    try {
      await fn();
    } catch (err) {
      upsert(prev);
      const { title, description } = errorMessage(err);
      toast.error(title, { description });
    }
  };

  const open = () => {
    if (job.status !== "succeeded") return;
    setJobsOpen(false);
    navigate({ name: "studio", projectId: job.projectId });
  };

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="group rounded-control border border-transparent px-2.5 py-2 hover:border-border hover:bg-hover"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
          {active && <ProgressRing value={job.progress} />}
          {job.status === "succeeded" && <Check className="size-4 text-success" />}
          {job.status === "failed" && <CircleAlert className="size-4 text-danger" />}
          {job.status === "canceled" && <Square className="size-3.5 text-subtle" />}
        </div>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={open} disabled={job.status !== "succeeded"}>
          <div className="truncate text-sm font-medium text-fg">{job.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-subtle">
            <span className="capitalize">{job.kind}</span>
            <span aria-hidden>·</span>
            <span>{PROVIDER_LABEL[job.provider]}</span>
            <span aria-hidden>·</span>
            <span className={cn(job.status === "failed" && "text-danger")}>{job.status === "failed" ? job.error?.message ?? "Failed" : job.stage}</span>
          </div>
          {job.status === "failed" && job.error?.hint && <div className="mt-1 text-xs text-muted">{job.error.hint}</div>}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="tabular mr-1 text-2xs text-subtle">{active ? `${Math.round(job.progress * 100)}%` : elapsed(job)}</span>
          {active && (
            <IconButton
              label="Cancel"
              size="icon-xs"
              onClick={() => void run(() => getBackend().cancelJob(job.id), { status: "canceled", stage: "Canceled" })}
            >
              <X />
            </IconButton>
          )}
          {(job.status === "failed" || job.status === "canceled") && (
            <IconButton
              label="Retry"
              size="icon-xs"
              onClick={() => void run(() => getBackend().retryJob(job.id), { status: "queued", stage: "Waiting in queue", progress: 0, error: null })}
            >
              <RotateCcw />
            </IconButton>
          )}
          {!active && (
            <IconButton
              label="Dismiss"
              size="icon-xs"
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => {
                remove(job.id);
                void getBackend().dismissJob(job.id);
              }}
            >
              <Trash2 />
            </IconButton>
          )}
        </div>
      </div>
      {active && <Progress value={job.progress} indeterminate={job.status === "queued"} className="mt-2" label={`${job.title} progress`} />}
    </motion.li>
  );
}

export function JobsIndicator() {
  const jobsMap = useJobs((s) => s.jobs);
  const unseen = useJobs((s) => s.unseen);
  const markSeen = useJobs((s) => s.markSeen);
  const open = useUi((s) => s.jobsOpen);
  const setOpen = useUi((s) => s.setJobs);

  const jobs = useMemo(() => sortJobs(Object.values(jobsMap)), [jobsMap]);
  const active = jobs.filter(isActive);
  const avg = active.length ? active.reduce((s, j) => s + j.progress, 0) / active.length : 0;
  const finished = jobs.filter((j) => !isActive(j));
  const hasFailure = unseen.some((id) => jobsMap[id]?.status === "failed");

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) markSeen();
      }}
    >
      <Tooltip content={active.length ? `${active.length} job${active.length > 1 ? "s" : ""} running` : "Jobs"}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Jobs"
            className={cn(
              "focus-gradient relative flex h-7 items-center gap-1.5 rounded-control px-2 text-sm text-muted transition-soft hover:bg-hover hover:text-fg",
              open && "bg-hover text-fg",
            )}
          >
            {active.length > 0 ? <ProgressRing value={avg} size={16} /> : <Layers className="size-4" />}
            <AnimatePresence initial={false}>
              {active.length > 0 && (
                <motion.span
                  key="count"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                  className="tabular overflow-hidden whitespace-nowrap text-xs"
                >
                  {active.length} running
                </motion.span>
              )}
            </AnimatePresence>
            {unseen.length > 0 && (
              <span
                className={cn("absolute right-1 top-1 size-1.5 rounded-full", hasFailure ? "bg-danger" : "bg-accent-gradient")}
                aria-label={`${unseen.length} finished`}
              />
            )}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="flex items-center justify-between border-b border-divider px-3 py-2.5">
          <div className="text-sm font-semibold text-fg">Jobs</div>
          <Button
            size="xs"
            variant="ghost"
            disabled={finished.length === 0}
            onClick={() => {
              finished.forEach((j) => useJobs.getState().remove(j.id));
              void getBackend().clearFinishedJobs();
            }}
          >
            Clear finished
          </Button>
        </div>
        {jobs.length === 0 ? (
          <EmptyState icon={<Layers />} title="No jobs yet" description="Generations, refines and retextures show up here while they run — even across restarts." className="py-8" />
        ) : (
          <ul className="max-h-[420px] space-y-0.5 overflow-y-auto p-1.5">
            <AnimatePresence initial={false}>
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
