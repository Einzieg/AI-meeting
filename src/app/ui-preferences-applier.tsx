"use client";

import { useEffect } from "react";
import { useUiStore } from "@/store/ui-store";

export function UiPreferencesApplier() {
  const theme = useUiStore((s) => s.theme);
  const locale = useUiStore((s) => s.locale);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return null;
}

