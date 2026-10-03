import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/screens/dashboard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Safety Dashboard & Live SOS — Nirbhaya" },
      {
        name: "description",
        content:
          "Personal safety dashboard with a simulated pulse monitor, location map and live multi-agent SOS orchestration.",
      },
      { property: "og:title", content: "Safety Dashboard & Live SOS — Nirbhaya" },
      {
        property: "og:description",
        content:
          "Simulated personal safety monitoring, location and live SOS response orchestration.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Dashboard,
});
