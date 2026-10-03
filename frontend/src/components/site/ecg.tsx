import { useEffect, useState } from "react";

const pulse = "0,48 22,48 33,45 40,51 48,48 62,48 69,39 75,58 82,15 90,85 97,44 104,48 134,48 145,45 153,51 163,48 180,48 188,40 194,58 201,16 209,84 216,46 224,48 256,48 270,45 278,51 286,48 304,48 312,39 319,58 326,15 334,85 341,46 348,48 380,48 391,45 399,51 407,48 425,48 432,40 439,58 446,16 454,84 461,46 468,48 512,48";

export function EcgMonitor() {
  const [bpm, setBpm] = useState(78);
  useEffect(() => {
    const timer = window.setInterval(() => setBpm(76 + Math.floor(Math.random() * 5)), 2400);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="relative overflow-hidden border border-border bg-surface p-5 md:p-6">
    <div className="flex items-start justify-between gap-4"><div><p className="label-mono">Heart rate / ECG preview</p><p className="mt-3 font-mono text-5xl tabular-nums">{bpm}<span className="ml-2 text-sm text-muted-foreground">BPM</span></p></div><span className="flex items-center gap-2 font-mono text-[10px] uppercase"><span className="size-2 animate-pulse bg-foreground" /> Simulation</span></div>
    <div className="relative mt-4 h-28 overflow-hidden border-y border-border bg-background dot-grid" aria-label="Animated simulated heart-rate waveform">
      <svg viewBox="0 0 1024 100" preserveAspectRatio="none" className="ecg-track absolute inset-y-0 left-0 h-full w-[200%] text-foreground" aria-hidden="true"><polyline points={pulse} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className="ecg-glow" /><polyline points={pulse} transform="translate(512 0)" fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className="ecg-glow" /></svg>
    </div>
    <p className="mt-3 text-xs text-muted-foreground">Visual simulation only — no heart-rate sensor is connected.</p>
  </div>;
}