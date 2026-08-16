"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeModeSwitch() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const activeTheme = mounted && resolvedTheme === "dark" ? "dark" : "light";

  return (
    <fieldset className="grp-theme-switch">
      <legend className="grp-sr-only">Theme</legend>
      <button
        aria-pressed={activeTheme === "light"}
        className="grp-theme-switch-button"
        onClick={() => setTheme("light")}
        type="button"
      >
        Light
      </button>
      <button
        aria-pressed={activeTheme === "dark"}
        className="grp-theme-switch-button"
        onClick={() => setTheme("dark")}
        type="button"
      >
        Dark
      </button>
    </fieldset>
  );
}
