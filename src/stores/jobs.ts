import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import type { Job } from "@/lib/backend/types";

export const ACTIVE_STATUSES = new Set<Job["status"]>(["queued", "running", "downloading"]);
export const isActive = (j: Job) => ACTIVE_STATUSES.has(j.status);

interface JobsState {
  jobs: Record<string, Job>;
  /** Jobs that finished since the user last opened the jobs popover. */
  unseen: string[];
  load(): Promise<void>;
  upsert(job: Job): void;
  remove(id: string): void;
  markSeen(): void;
}

export const useJobs = create<JobsState>((set, get) => ({
  jobs: {},
  unseen: [],
  async load() {
    const list = await getBackend().listJobs();
    set({ jobs: Object.fromEntries(list.map((j) => [j.id, j])) });
  },
  upsert(job) {
    const prev = get().jobs[job.id];
    const finishedNow = prev && isActive(prev) && !isActive(job);
    set({
      jobs: { ...get().jobs, [job.id]: job },
      unseen: finishedNow ? [...new Set([...get().unseen, job.id])] : get().unseen,
    });
  },
  remove(id) {
    const { [id]: _removed, ...rest } = get().jobs;
    set({ jobs: rest, unseen: get().unseen.filter((u) => u !== id) });
  },
  markSeen() {
    if (get().unseen.length) set({ unseen: [] });
  },
}));

export function sortJobs(jobs: Job[]): Job[] {
  const rank = (j: Job) => (j.status === "running" || j.status === "downloading" ? 0 : j.status === "queued" ? 1 : 2);
  return [...jobs].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
}
