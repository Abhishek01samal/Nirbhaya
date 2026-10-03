"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, sosApi, type SosRecord } from "@/lib/api";
import type { GeoPoint } from "@/lib/api";
import { HYDERABAD, readBrowserLocation } from "@/lib/geo";

type SosContextValue = {
  active: boolean;
  sos: SosRecord | null;
  linked: boolean;
  lastError: string;
  triggerSos: (input?: {
    triggerType?: SosRecord["triggerType"];
    reason?: string;
    confidence?: number;
    location?: GeoPoint;
  }) => Promise<void>;
  standDown: () => Promise<void>;
};

const SosContext = createContext<SosContextValue | null>(null);

export function SosProvider({ children }: { children: ReactNode }) {
  const [sos, setSos] = useState<SosRecord | null>(null);
  const [localActive, setLocalActive] = useState(false);
  const [linked, setLinked] = useState(false);
  const [lastError, setLastError] = useState("");

  const active = localActive || Boolean(sos && !["CANCELLED", "RESOLVED"].includes(sos.status));

  useEffect(() => {
    document.documentElement.classList.toggle("sos-alert", active);
    document.body?.classList.toggle("sos-alert", active);
    return () => {
      document.documentElement.classList.remove("sos-alert");
      document.body?.classList.remove("sos-alert");
    };
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    sosApi
      .active()
      .then((result) => {
        if (cancelled) return;
        setLinked(true);
        if (result.active && result.sos) {
          setSos(result.sos);
          setLocalActive(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLinked(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const triggerSos = useCallback(async (input?: {
    triggerType?: SosRecord["triggerType"];
    reason?: string;
    confidence?: number;
    location?: GeoPoint;
  }) => {
    setLocalActive(true);
    setLastError("");
    let location = input?.location;
    if (!location) {
      try {
        location = await readBrowserLocation();
      } catch {
        location = { ...HYDERABAD };
      }
    }
    try {
      const created = await sosApi.create({
        triggerType: (input?.triggerType as "MANUAL" | "VOICE_DANGER" | "OFF_ROUTE" | "LONG_STOP") ?? "MANUAL",
        location,
        triggerData: {
          riskLevel: "critical",
          confidence: input?.confidence ?? 0.9,
          reason: input?.reason ?? "Manual SOS from dashboard",
        },
      });
      setSos(created);
      setLinked(true);
      try {
        await sosApi.confirm(created.id);
      } catch {
        /* verification window may already have passed */
      }
      try {
        await sosApi.startEscalation(created.id);
      } catch {
        /* guardians may be empty */
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const existing = (error.details as { existing?: SosRecord } | undefined)?.existing;
        if (existing) {
          setSos(existing);
          setLinked(true);
          return;
        }
      }
      setLastError(error instanceof Error ? error.message : "Could not reach the SOS service.");
    }
  }, []);

  const standDown = useCallback(async () => {
    setLocalActive(false);
    const id = sos?.id;
    setSos(null);
    if (!id) return;
    try {
      await sosApi.cancel(id);
    } catch {
      try {
        await sosApi.resolve(id);
      } catch {
        /* local stand-down still applies */
      }
    }
  }, [sos?.id]);

  const value = useMemo(
    () => ({ active, sos, linked, lastError, triggerSos, standDown }),
    [active, sos, linked, lastError, triggerSos, standDown],
  );

  return <SosContext.Provider value={value}>{children}</SosContext.Provider>;
}

export function useSos() {
  const ctx = useContext(SosContext);
  if (!ctx) throw new Error("useSos must be used inside SosProvider");
  return ctx;
}
