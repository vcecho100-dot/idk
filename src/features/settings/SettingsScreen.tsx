import type { SettingsSection } from "@/stores/route";

export default function SettingsScreen({ section }: { section: SettingsSection }) {
  return <div className="flex flex-1 items-center justify-center text-muted">Settings · {section}</div>;
}
