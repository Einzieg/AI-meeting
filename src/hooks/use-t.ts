"use client";

import { useCallback } from "react";
import { useUiStore } from "@/store/ui-store";
import { translate, type MessageKey } from "@/lib/i18n/messages";

export type TFunction = (key: MessageKey, params?: Record<string, string | number>) => string;

export function useT(): TFunction {
  const locale = useUiStore((s) => s.locale);
  return useCallback((key, params) => translate(locale, key, params), [locale]);
}
