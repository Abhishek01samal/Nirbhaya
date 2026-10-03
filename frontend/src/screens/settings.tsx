"use client";

import { useEffect, useState } from "react";
import { Page, Section } from "@/components/site/shell";
import { settingsGroups } from "@/lib/mock-data";
import { Button } from "@/components/ui/button";

export function Settings() {
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries(settingsGroups.flatMap((group) => group.items.map((item) => [item.label, item.enabled]))));
  const [threshold, setThreshold] = useState(120);
  const [sensitivity, setSensitivity] = useState(65);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("Nirbhaya-settings");
      if (!stored) return;
      const parsed = JSON.parse(stored) as { state?: Record<string, boolean>; threshold?: number; sensitivity?: number };
      if (parsed.state) setState(parsed.state);
      if (typeof parsed.threshold === "number") setThreshold(parsed.threshold);
      if (typeof parsed.sensitivity === "number") setSensitivity(parsed.sensitivity);
    } catch { setSaved(false); }
  }, []);

  function saveSettings() {
    window.localStorage.setItem("Nirbhaya-settings", JSON.stringify({ state, threshold, sensitivity }));
    setSaved(true);
  }

  return <Page>
    <Section title="Trigger locks" note="Saved on this device">
      <div className="grid gap-4 md:grid-cols-3">
        <label className="border border-border bg-surface p-5"><span className="label-mono">Heart-rate threshold</span><span className="mt-4 block font-mono text-3xl">{threshold} <small className="text-xs text-muted-foreground">BPM</small></span><input aria-label="Heart-rate threshold" className="mt-4 w-full accent-foreground" type="range" min="90" max="180" value={threshold} onChange={(event) => { setThreshold(Number(event.target.value)); setSaved(false); }} /><span className="mt-2 block text-xs text-muted-foreground">Requires a paired heart-rate sensor.</span></label>
        <label className="border border-border bg-surface p-5"><span className="label-mono">Shake sensitivity</span><span className="mt-4 block font-mono text-3xl">{sensitivity}%</span><input aria-label="Shake sensitivity" className="mt-4 w-full accent-foreground" type="range" min="10" max="100" value={sensitivity} onChange={(event) => { setSensitivity(Number(event.target.value)); setSaved(false); }} /><span className="mt-2 block text-xs text-muted-foreground">Requires device motion permissions and validation.</span></label>
        <div className="border border-border bg-surface p-5"><span className="label-mono">Device-offline alert</span><p className="mt-4 text-sm">First signal: “Your device has gone offline.”</p><p className="mt-3 text-xs text-muted-foreground">A browser cannot detect a phone shutdown or send this alert while offline.</p><Button variant="outline" className="mt-5 w-full" disabled>Not available in preview</Button></div>
      </div>
    </Section>
    {settingsGroups.map((group) => <Section key={group.title} title={group.title}><ul className="divide-y divide-border border border-border bg-surface">{group.items.map((item) => { const on = state[item.label]; return <li key={item.label} className="flex items-center gap-6 px-6 py-5"><div className="flex-1"><p>{item.label}</p><p className="mt-1 text-sm text-muted-foreground">{item.detail}</p></div><Button variant="outline" size="sm" aria-pressed={Boolean(on)} onClick={() => { setState((current) => ({ ...current, [item.label]: !on })); setSaved(false); }} className={`w-16 border border-foreground font-mono text-[10px] ${on ? "bg-foreground text-background" : ""}`}>{on ? "ON" : "OFF"}</Button></li>; })}</ul></Section>)}
    <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-4 py-6 md:px-8"><Button onClick={saveSettings} className="uppercase">Save settings</Button><span role="status" className="text-xs text-muted-foreground">{saved ? "Saved on this device." : "Changes are not saved yet."}</span></div>
  </Page>;
}