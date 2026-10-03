import type { Metadata } from "next";
import { Assistant } from "@/screens/assistant";

export const metadata: Metadata = {
  title: "Safety Assistant",
  description:
    "An AI-powered conversation interface for the Nirbhaya safety preview. No emergency actions are performed.",
};

export default function AssistantPage() {
  return <Assistant />;
}
