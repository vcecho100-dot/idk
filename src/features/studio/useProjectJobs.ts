import { useMemo } from "react";
import type { Job } from "@/lib/backend/types";
import { isActive, useJobs } from "@/stores/jobs";

/** The project's queued and running jobs. */
export function useProjectJobs(projectId: string | null): Job[] {
  const jobs = useJobs((s) => s.jobs);
  return useMemo(() => (projectId ? Object.values(jobs).filter((j) => j.projectId === projectId && isActive(j)) : []), [jobs, projectId]);
}
