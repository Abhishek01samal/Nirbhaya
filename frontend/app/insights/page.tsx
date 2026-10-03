import type { Metadata } from "next";
import { Insights } from "@/screens/insights";

export const metadata: Metadata = {
  title: "Safety Insights",
  description: "Danger zones, nearby emergency services and the weekly guardian safety report.",
};

export default function InsightsPage() {
  return <Insights />;
}
