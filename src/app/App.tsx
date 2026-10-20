import { lazy, Suspense } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TitleBar } from "@/components/shell/TitleBar";
import { useRoute } from "@/stores/route";
import { useSettings } from "@/stores/settings";
import { useAppearance } from "./useAppearance";
import { useEngineEvents } from "./useEngineEvents";
import { HomeScreen } from "@/features/home/HomeScreen";
import { ScreenFallback } from "./ScreenFallback";

const StudioScreen = lazy(() => import("@/features/studio/StudioScreen"));
const LibraryScreen = lazy(() => import("@/features/library/LibraryScreen"));
const SettingsScreen = lazy(() => import("@/features/settings/SettingsScreen"));

function Routes() {
  const route = useRoute((s) => s.route);
  const key = route.name === "studio" ? `studio:${route.projectId ?? "new"}` : route.name;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.main
        key={key}
        className="relative flex min-h-0 flex-1 flex-col"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
      >
        <Suspense fallback={<ScreenFallback />}>
          {route.name === "home" && <HomeScreen />}
          {route.name === "studio" && <StudioScreen projectId={route.projectId} />}
          {route.name === "library" && <LibraryScreen />}
          {route.name === "settings" && <SettingsScreen section={route.section ?? "general"} />}
        </Suspense>
      </motion.main>
    </AnimatePresence>
  );
}

export function App() {
  useAppearance();
  useEngineEvents();
  const theme = useSettings((s) => s.settings.theme);
  const reducedMotion = useSettings((s) => s.settings.reducedMotion);

  return (
    <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
      <TooltipProvider delayDuration={450} skipDelayDuration={250}>
        <div className="flex h-full flex-col">
          <TitleBar />
          <Routes />
        </div>
        <Toaster theme={theme} position="bottom-right" offset={16} gap={8} visibleToasts={4} closeButton />
      </TooltipProvider>
    </MotionConfig>
  );
}
