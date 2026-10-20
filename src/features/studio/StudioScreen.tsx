export default function StudioScreen({ projectId }: { projectId?: string }) {
  return <div className="flex flex-1 items-center justify-center text-muted">Studio {projectId ?? ""}</div>;
}
