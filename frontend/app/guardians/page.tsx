import type { Metadata } from "next";
import { Guardians } from "@/screens/guardians";

export const metadata: Metadata = {
  title: "Guardians",
  description: "Manage trusted guardians, link codes and escalation priority.",
};

export default function GuardiansPage() {
  return <Guardians />;
}
