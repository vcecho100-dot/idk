import { useEffect } from "react";
import { getBackend } from "@/lib/backend";
import { useJobs } from "@/stores/jobs";
import { useLibrary } from "@/stores/library";

/** Keeps the jobs and library stores in sync with engine events. */
export function useEngineEvents(): void {
  useEffect(() => {
    const backend = getBackend();
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadLibrary = () => {
      // Coalesce bursts (e.g. 4 variants finishing together) into one refresh.
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void useLibrary.getState().load(), 60);
    };
    const offJobs = backend.onJobUpdate((job) => useJobs.getState().upsert(job));
    const offLib = backend.onLibraryChanged((e) => {
      if (e.type === "deleted") useLibrary.getState().drop(e.projectId);
      reloadLibrary();
    });
    return () => {
      clearTimeout(reloadTimer);
      offJobs();
      offLib();
    };
  }, []);
}
