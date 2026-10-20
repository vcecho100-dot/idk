import { useState } from "react";
import { LogoMark } from "@/brand/Logo";
import { getBackend } from "@/lib/backend";
import { cn } from "@/lib/utils";

/** A project/version thumbnail with a branded placeholder and a fade-in (no layout shift: fixed aspect). */
export function ProjectThumb({
  versionId,
  cacheKey,
  className,
  alt,
}: {
  versionId: string | null;
  cacheKey?: string | number;
  className?: string;
  alt: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = versionId ? getBackend().thumbnailUrl(versionId, cacheKey) : "";
  const showImage = Boolean(url) && !failed;
  return (
    <div className={cn("relative overflow-hidden bg-[radial-gradient(120%_90%_at_50%_0%,var(--panel-raised),var(--bg))]", className)}>
      {(!showImage || !loaded) && (
        <div className="absolute inset-0 flex items-center justify-center opacity-25">
          <LogoMark size={28} />
        </div>
      )}
      {showImage && (
        <img
          src={url}
          alt={alt}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn("absolute inset-0 size-full object-cover transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0")}
        />
      )}
    </div>
  );
}
