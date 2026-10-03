import type { Metadata } from "next";
import { Settings } from "@/screens/settings";

export const metadata: Metadata = {
  title: "Settings",
  description: "Configure emergency triggers, privacy and evidence preferences.",
};

export default function SettingsPage() {
  return <Settings />;
}
