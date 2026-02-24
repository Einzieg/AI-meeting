import type { Metadata } from "next";
import "./globals.css";
import { UiPreferencesApplier } from "./ui-preferences-applier";

export const metadata: Metadata = {
  title: "AI Meeting",
  description: "Multi-AI multi-model discussion system",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" data-theme="dark">
      <body className="min-h-screen bg-background antialiased">
        <UiPreferencesApplier />
        {children}
      </body>
    </html>
  );
}
