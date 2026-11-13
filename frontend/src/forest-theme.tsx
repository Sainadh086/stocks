import { Leaf, Moon, Sun, Trees, Waves } from "lucide-react";
import { useData } from "./api";
import { useAppearance, supportedThemes } from "./appearance";
import { alternateColorTheme, themes } from "./themes";
import type { Preferences } from "./types";

// One lightweight vector scene scales from a preview tile to the full backdrop.
export function ForestScene() {
  return (
    <svg
      className="forest-scene"
      viewBox="0 0 1200 650"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="forest-moon" cx="850" cy="95" r="40" />
      <path
        className="forest-ridge far"
        d="M0 300 160 120 290 230 440 90 610 270 790 140 970 250 1100 120 1200 240V650H0Z"
      />
      <path
        className="forest-ridge near"
        d="M0 390 130 270 320 340 500 220 660 330 870 210 1020 330 1200 240V650H0Z"
      />
      <path
        className="forest-rock"
        d="M630 305 700 235 810 215 920 250 995 470 900 575 610 555Z"
      />
      <path
        className="forest-water"
        d="M777 236Q810 242 842 230L857 370Q840 410 877 489L933 548Q840 580 721 548L793 479Q820 438 800 384Z"
      />
      <path
        className="forest-water-highlight"
        d="M809 249Q825 320 820 383T840 489M837 250Q834 320 846 359M811 427 802 483"
      />
      <path
        className="forest-river"
        d="M746 528Q1000 542 852 590T1075 650H570Q550 594 740 580T746 528Z"
      />
      {[
        [30, 180, 1.2],
        [155, 235, 0.9],
        [265, 165, 1.35],
        [390, 280, 0.75],
        [520, 300, 0.7],
        [1040, 170, 1.3],
        [1150, 230, 1],
        [600, 410, 0.6],
        [965, 390, 0.7],
      ].map(([x, y, scale], i) => (
        <g
          className={`forest-tree tree-${i % 3}`}
          key={x}
          transform={`translate(${x} ${y}) scale(${scale})`}
        >
          <path d="M-5 130H5V290H-5Z" />
          <path d="M0 0-42 83H-26L-65 140H-40L-85 210H85L40 140H65L26 83H42Z" />
        </g>
      ))}
      <path
        className="forest-bank"
        d="M0 550Q200 480 400 553T660 620L720 650H0ZM960 610Q1100 510 1200 530V650H1000Z"
      />
      <ellipse className="forest-mist" cx="815" cy="530" rx="145" ry="18" />
    </svg>
  );
}

export function ForestAtmosphere() {
  return (
    <div className="forest-atmosphere" aria-hidden="true">
      <ForestScene />
    </div>
  );
}

export function ForestRetreat() {
  return (
    <div className="forest-retreat">
      <div className="retreat-art">
        <ForestScene />
        <span>
          <Trees size={15} /> FOREST RETREAT
        </span>
      </div>
      <div className="retreat-copy">
        <strong>
          <Leaf size={15} /> Room to grow.
        </strong>
        <p>A little perspective for your day.</p>
        <span>
          <Waves size={14} /> Waterfall & woodland
        </span>
      </div>
    </div>
  );
}

export function ThemeModeSwitch() {
  const preferences = useData<Preferences>("preferences", "/preferences");
  const update = useAppearance();
  const theme = preferences.data?.theme ?? "light";
  const dark = themes.find((item) => item.id === theme)?.mode === "dark";
  const alternate = alternateColorTheme(theme);
  const target =
    alternate === "dark" && !supportedThemes(preferences.data).includes("dark")
      ? "midnight"
      : alternate;
  const available = supportedThemes(preferences.data).includes(target);
  return (
    <div className="theme-mode-control">
      <button
        className="theme-mode-switch"
        role="switch"
        aria-label="Dark mode"
        aria-checked={dark}
        disabled={!preferences.data || update.isPending || !available}
        title={
          !available
            ? "Restart Varshan and refresh to enable forest dark mode."
            : "Switch color mode"
        }
        onClick={() => update.mutate({ theme: target })}
      >
        {dark ? <Moon size={17} /> : <Sun size={17} />}
        <span>{dark ? "Dark" : "Light"}</span>
      </button>
      {update.error && (
        <span className="mode-error" role="alert">
          Could not save appearance. Try again.
        </span>
      )}
    </div>
  );
}
