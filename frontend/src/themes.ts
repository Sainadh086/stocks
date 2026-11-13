export const themes = [
  {
    id: "light",
    name: "Porcelain",
    description: "Clean ivory, ink typography and sapphire accents.",
    mode: "light",
    colors: ["#f4f5f9", "#ffffff", "#415ac6"],
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep navy surfaces with crisp electric blue highlights.",
    mode: "dark",
    colors: ["#0b1425", "#17243a", "#8baaff"],
  },
  {
    id: "forest",
    name: "Botanical",
    description: "A misty forest, cascading waterfall and fern-green details.",
    mode: "light",
    colors: ["#eaf0e8", "#ffffff", "#26735a"],
  },
  {
    id: "obsidian",
    name: "Obsidian",
    description: "Charcoal, warm copper and a focused trading-desk feel.",
    mode: "dark",
    colors: ["#151515", "#242322", "#f5b47e"],
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Indigo glass, violet accents and luminous depth.",
    mode: "dark",
    colors: ["#131229", "#24213e", "#b9a0ff"],
  },
  {
    id: "sandstone",
    name: "Sandstone",
    description: "Editorial cream, espresso text and terracotta accents.",
    mode: "light",
    colors: ["#f1eae0", "#fffcf6", "#a34d30"],
  },
  {
    id: "dark",
    name: "Dark",
    description: "Quiet graphite surfaces with soft silver and mint accents.",
    mode: "dark",
    colors: ["#101719", "#1b272b", "#99dbc7"],
  },
  {
    id: "forest-dark",
    name: "Forest at night",
    description:
      "Moonlit trees, a luminous waterfall and deep evergreen glass.",
    mode: "dark",
    colors: ["#091c18", "#202a29", "#9edbbb"],
  },
] as const;
export type Theme = (typeof themes)[number]["id"];
export function applyTheme(value: string) {
  const theme = themes.find((t) => t.id === value) ?? themes[0];
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.colorMode = theme.mode;
}

export function alternateColorTheme(value: string): Theme {
  if (value === "forest") return "forest-dark";
  if (value === "forest-dark") return "forest";
  return themes.find((theme) => theme.id === value)?.mode === "dark"
    ? "light"
    : "dark";
}
