import { createFileRoute } from "@tanstack/react-router";
import { Guardians } from "@/screens/guardians";

export const Route = createFileRoute("/guardians")({
  head: () => ({
    meta: [
      { title: "Guardians & Tactical Radar — Nirbhaya" },
      {
        name: "description",
        content: "Manage trusted guardians, link codes, proximity radar and emergency escalation priority.",
      },
      { property: "og:title", content: "Guardians — Nirbhaya" },
      {
        property: "og:description",
        content: "Trusted contacts and tactical radar receiving SOS escalation alerts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Guardians,
});
