const GLYPHS: Record<string, string> = {
  enter: "↵",
  shift: "⇧",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  esc: "Esc",
  space: "Space",
  backspace: "⌫",
  delete: "Del",
};

/** Splits "Ctrl+Shift+K" into display keys: ["Ctrl", "⇧", "K"]. */
export function formatKeys(combo: string): string[] {
  return combo.split("+").map((k) => {
    const key = k.trim();
    return GLYPHS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key);
  });
}
