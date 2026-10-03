import { createFileRoute } from "@tanstack/react-router";
import { RoutesPlanner } from "@/screens/routes-planner";

export const Route = createFileRoute("/routes")({
  head: () => ({
    meta: [
      { title: "SafeRoute Planner — Nirbhaya" },
      {
        name: "description",
        content: "Safety-evaluated route planner comparing Shield vs Direct routes and safe havens.",
      },
      { property: "og:title", content: "SafeRoute Planner — Nirbhaya" },
      {
        property: "og:description",
        content: "Tactical route safety analysis and multi-modal guardian transit optimizer.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RoutesPlanner,
});