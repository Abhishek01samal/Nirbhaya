"use client";

import { SosProvider } from "@/lib/sos-store";
import type { ReactNode } from "react";

export function AppProviders({ children }: { children: ReactNode }) {
  return <SosProvider>{children}</SosProvider>;
}
