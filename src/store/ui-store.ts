"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/messages";

export type Theme = "dark" | "light";

interface UiStore {
  locale: Locale;
  theme: Theme;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
}

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      locale: DEFAULT_LOCALE,
      theme: "dark",
      setLocale: (locale) => set({ locale }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "ai-meeting-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ locale: state.locale, theme: state.theme }),
    },
  ),
);

