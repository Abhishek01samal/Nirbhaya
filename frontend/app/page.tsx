import type { Metadata } from "next";
import { Dashboard } from "@/screens/dashboard";

export const metadata: Metadata = {
  title: "Safety Dashboard & Live SOS",
  description:
    "Personal safety dashboard with a simulated pulse monitor, location map and live multi-agent SOS orchestration.",
};

export default function HomePage() {
  return <Dashboard />;
}
