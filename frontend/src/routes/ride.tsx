import { createFileRoute } from "@tanstack/react-router";
import { Ride } from "@/screens/ride";

export const Route = createFileRoute("/ride")({
  head: () => ({
    meta: [
      { title: "Safe Ride & Screenshot OCR — Nirbhaya" },
      {
        name: "description",
        content: "Ride safety monitoring with Ola/Uber screenshot OCR parsing and trajectory tracking.",
      },
      { property: "og:title", content: "Safe Ride — Nirbhaya" },
      {
        property: "og:description",
        content: "Interactive Ola/Uber ride safety monitoring with AI screenshot extraction.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Ride,
});