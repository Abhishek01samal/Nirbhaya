"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Plus,
  Trash2,
  Users,
  Shield,
  Radio,
  MapPin,
  Clock,
  PhoneCall,
  Siren,
  CheckCircle2,
  Wifi,
} from "lucide-react";
import { Page, Section, Tag } from "@/components/site/shell";
import { ChatWidget } from "@/components/site/chat-widget";
import { TacticalMap, type MapMarker } from "@/components/site/tactical-map";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { guardians as initialGuardians } from "@/lib/mock-data";
import { guardianApi, type GuardianRecord } from "@/lib/api";
import { DEFAULT_LOCATION } from "@/lib/geo";

export function GuardianRegister() {
  type Guardian = (typeof initialGuardians)[number] & {
    lat?: number;
    lng?: number;
    distanceKm?: number;
    etaMins?: number;
    signal?: number;
  };

  const [guardians, setGuardians] = useState<Guardian[]>(
    initialGuardians.map((g, i) => ({
      ...g,
      lat: DEFAULT_LOCATION.lat + (i === 0 ? 0.008 : i === 1 ? -0.012 : 0.015),
      lng: DEFAULT_LOCATION.lng + (i === 0 ? 0.006 : i === 1 ? 0.014 : -0.009),
      distanceKm: i === 0 ? 1.2 : i === 1 ? 2.8 : 4.5,
      etaMins: i === 0 ? 3 : i === 1 ? 7 : 12,
      signal: i === 0 ? 98 : i === 1 ? 92 : 84,
    }))
  );

  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [phone, setPhone] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const guardianCode = "SP-7KQ4M-X9PT2-20260926";

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("Nirbhaya-guardians");
      if (saved) {
        const parsed = JSON.parse(saved) as Guardian[];
        if (parsed.length) setGuardians(parsed);
      }
    } catch {
      setNotice("Saved guardian details could not be read on this device.");
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem("Nirbhaya-guardians", JSON.stringify(guardians));
  }, [guardians, ready]);

  // Try fetching live guardians from backend API
  useEffect(() => {
    guardianApi
      .list()
      .then((res) => {
        if (res?.guardians?.length) {
          const mapped: Guardian[] = res.guardians.map((g, idx) => ({
            id: g.id || `G-${String(idx + 1).padStart(2, "0")}`,
            name: `Guardian ${idx + 1}`,
            relation: g.relationship || "Trusted Contact",
            phone: "+91 98765 43210",
            priority: g.priority || idx + 1,
            status: g.status === "ACTIVE" || g.status === "LINKED" ? "LINKED" : "PENDING",
            lastSeen: "NOW",
            lat: DEFAULT_LOCATION.lat + (idx * 0.007 - 0.005),
            lng: DEFAULT_LOCATION.lng + (idx * 0.009 - 0.004),
            distanceKm: (idx + 1) * 1.5,
            etaMins: (idx + 1) * 4,
            signal: 95 - idx * 5,
          }));
          setGuardians(mapped);
        }
      })
      .catch(() => {
        /* fallback to local storage / mock */
      });
  }, []);

  function addGuardian(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanRelation = relation.trim();
    const digits = phone.replace(/\D/g, "");
    if (!cleanName || !cleanRelation || digits.length < 7) {
      setNotice("Enter a name, relationship, and valid phone number.");
      return;
    }
    const nextNumber = guardians.reduce((max, g) => Math.max(max, Number(g.id.replace("G-", "")) || 0), 0) + 1;
    const newG: Guardian = {
      id: `G-${String(nextNumber).padStart(2, "0")}`,
      name: cleanName,
      relation: cleanRelation,
      phone,
      priority: guardians.length + 1,
      status: "PENDING",
      lastSeen: "JUST NOW",
      lat: DEFAULT_LOCATION.lat + 0.01,
      lng: DEFAULT_LOCATION.lng + 0.01,
      distanceKm: 3.2,
      etaMins: 8,
      signal: 90,
    };

    setGuardians((current) => [...current, newG]);
    setName("");
    setRelation("");
    setPhone("");
    setNotice(`Invitation prepared for ${cleanName}. They must accept it to become linked.`);

    // Send to backend API asynchronously
    guardianApi
      .create({
        guardianUserId: newG.id,
        relationship: cleanRelation,
        priority: newG.priority,
      })
      .catch(() => {});
  }

  function accept(id: string) {
    setGuardians((current) =>
      current.map((g) => (g.id === id ? { ...g, status: "LINKED", lastSeen: "NOW" } : g))
    );
    setNotice("Guardian accepted and is now included in the escalation order.");
    guardianApi.accept(id).catch(() => {});
  }

  function remove(id: string) {
    setGuardians((current) =>
      current
        .filter((g) => g.id !== id)
        .map((g, index) => ({ ...g, priority: index + 1 }))
    );
    setNotice("Guardian removed.");
    guardianApi.remove(id).catch(() => {});
  }

  function move(id: string, offset: number) {
    setGuardians((current) => {
      const from = current.findIndex((g) => g.id === id);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const reordered = [...current];
      const [selected] = reordered.splice(from, 1);
      if (!selected) return current;
      reordered.splice(to, 0, selected);
      return reordered.map((g, index) => ({ ...g, priority: index + 1 }));
    });
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(guardianCode);
      setNotice("Guardian code copied.");
    } catch {
      setNotice("Copy was blocked. Select the code and copy it manually.");
    }
  }

  // Construct map markers for tactical radar
  const mapMarkers: MapMarker[] = [
    { id: "user-loc", lat: DEFAULT_LOCATION.lat, lng: DEFAULT_LOCATION.lng, label: "Your Location", kind: "you" },
    ...guardians.map((g) => ({
      id: g.id,
      lat: g.lat ?? DEFAULT_LOCATION.lat + 0.005,
      lng: g.lng ?? DEFAULT_LOCATION.lng + 0.005,
      label: `${g.name} (${g.relation})`,
      kind: "guardian" as const,
    })),
  ];

  return (
    <Page>
      {/* Tactical Guardian Radar Map */}
      <Section title="Guardian Tactical Radar & Live Map" note="Real-time proximity telemetry & responder status">
        <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
          <div className="flex flex-col border border-border bg-surface">
            <div className="border-b border-border p-4 flex items-center justify-between font-mono text-xs uppercase">
              <span className="flex items-center gap-2">
                <Radio className="size-4 animate-pulse text-emerald-500" />
                Active Proximity Radar
              </span>
              <Tag inverse>HYD-ESC-RADAR #09</Tag>
            </div>
            <TacticalMap markers={mapMarkers} featured={true} showMarkers={false} caption="Linked Guardians Proximity Map" />
          </div>

          <div className="flex flex-col justify-between border border-border bg-surface p-6">
            <div>
              <p className="label-mono flex items-center gap-2">
                <Users className="size-4" /> Escalation Hierarchy
              </p>
              <h2 className="mt-3 font-display text-4xl uppercase leading-tight">
                Guardian Proximity Telemetry<span className="text-muted-foreground">.</span>
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                In an emergency, guardians are notified strictly by priority order with live location links and automated WebRTC audio bridge.
              </p>

              <div className="mt-6 space-y-3">
                {guardians.map((g) => (
                  <div key={g.id} className="flex items-center justify-between border border-border bg-background p-3.5 font-mono text-xs">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-foreground">{g.name}</span>
                        <Tag inverse={g.status === "LINKED"}>{g.status}</Tag>
                      </div>
                      <span className="text-[10px] text-muted-foreground uppercase">{g.relation} ┬╖ Priority 0{g.priority}</span>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">{g.etaMins ? `~${g.etaMins} mins ETA` : "In range"}</div>
                      <span className="text-[10px] text-emerald-600">{g.distanceKm} km away ┬╖ Signal {g.signal}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 border-t border-border pt-4">
              <Button
                variant="outline"
                className="w-full font-mono text-xs uppercase justify-center"
                onClick={() => setNotice("Triggered live radar ping test to all linked guardians.")}
              >
                <Wifi className="mr-2 size-4" /> Ping Guardian Telemetry
              </Button>
            </div>
          </div>
        </div>
      </Section>

      {/* Add Guardian Form */}
      <Section title="Add a new guardian" note="Creates a pending invitation & syncs to safety database">
        <form onSubmit={addGuardian} className="grid gap-4 border border-border bg-surface p-6 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end shadow-sm">
          <label className="grid gap-2">
            <span className="label-mono">Full name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Anika Rao" className="h-11" />
          </label>
          <label className="grid gap-2">
            <span className="label-mono">Relationship</span>
            <Input value={relation} onChange={(e) => setRelation(e.target.value)} placeholder="Sister, friend, spouseΓÇª" className="h-11" />
          </label>
          <label className="grid gap-2">
            <span className="label-mono">Phone number</span>
            <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" className="h-11" />
          </label>
          <Button type="submit" className="h-11 font-mono text-xs uppercase font-bold px-6">
            <Plus className="mr-1 size-4" /> Add Guardian
          </Button>
        </form>
        {notice ? <p role="status" className="mt-3 border-l-4 border-foreground bg-surface-2 p-4 text-sm font-mono">{notice}</p> : null}
      </Section>

      {/* Guardian List & Re-ordering */}
      <Section title="Your trusted guardians" note="Priority order determines alert escalation sequence">
        <div className="grid gap-4 md:grid-cols-3">
          {guardians.map((g, index) => (
            <div key={g.id} className="panel p-6 border border-border bg-surface hover:border-foreground transition-all flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-4">
                  <span className="font-mono text-xs text-muted-foreground">{g.id} ┬╖ P0{g.priority}</span>
                  <Tag inverse={g.status === "LINKED"}>{g.status}</Tag>
                </div>
                <h3 className="font-display mt-5 text-3xl uppercase leading-none tracking-wide">{g.name}</h3>
                <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{g.relation}</p>
              </div>

              <div className="mt-6 border-t border-border pt-4">
                <div className="flex flex-wrap justify-between gap-2 font-mono text-xs text-muted-foreground mb-4">
                  <span>{g.phone}</span>
                  <span>LAST SEEN: {g.lastSeen}</span>
                </div>
                <div className="flex items-center gap-2">
                  {g.status === "PENDING" ? (
                    <Button size="sm" onClick={() => accept(g.id)} className="mr-auto font-mono text-xs uppercase">
                      <Check className="mr-1 size-3.5" /> Accept
                    </Button>
                  ) : (
                    <span className="mr-auto label-mono flex items-center gap-1.5 text-emerald-700 font-bold">
                      <CheckCircle2 className="size-3.5" /> Alerts Enabled
                    </span>
                  )}
                  <Button variant="outline" size="icon" onClick={() => move(g.id, -1)} disabled={index === 0} aria-label={`Move ${g.name} up`} title="Move up">
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button variant="outline" size="icon" onClick={() => move(g.id, 1)} disabled={index === guardians.length - 1} aria-label={`Move ${g.name} down`} title="Move down">
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button variant="outline" size="icon" onClick={() => remove(g.id)} aria-label={`Remove ${g.name}`} title="Remove guardian">
                    <Trash2 className="size-4 text-red-600" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {!guardians.length ? (
          <p className="border border-border bg-surface p-6 text-sm text-muted-foreground">No guardians yet. Add your first trusted contact above.</p>
        ) : null}
      </Section>

      {/* Guardian Code Section */}
      <Section title="Your unique guardian pairing code">
        <div className="panel flex flex-col justify-between gap-5 border border-border p-6 md:flex-row md:items-center bg-surface">
          <div>
            <p className="break-all font-mono text-xl tracking-widest md:text-3xl font-bold">{guardianCode}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Share this secure code with trusted individuals. Once paired, they will receive instant SOS push alerts and live location updates.
            </p>
          </div>
          <Button variant="outline" onClick={copyCode} className="shrink-0 font-mono text-xs uppercase h-11 px-5">
            <Copy className="mr-2 size-4" /> Copy Pairing Code
          </Button>
        </div>
      </Section>

      <ChatWidget />
    </Page>
  );
}
