import type { Metadata } from "next";
import { RoutesPlanner } from "@/screens/routes-planner";

export const metadata: Metadata = {
  title: "Route Planning",
  description: "Compare a safe-destination route and simulated guardian travel options.",
};

export default function RoutesPage() {
  return <RoutesPlanner />;
}
