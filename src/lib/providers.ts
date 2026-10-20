import type { ProviderId, Style } from "@/lib/backend/types";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  mock: "Offline demo",
  tripo: "Tripo",
  meshy: "Meshy",
  fal: "fal.ai",
  local: "Local GPU",
  hfspace: "Hugging Face",
};

export const STYLE_LABEL: Record<Style, string> = {
  realistic: "Realistic",
  stylized: "Stylized",
  cartoon: "Cartoon",
  lowpoly: "Low-poly",
  voxel: "Voxel",
  sculpture: "Sculpture",
};
