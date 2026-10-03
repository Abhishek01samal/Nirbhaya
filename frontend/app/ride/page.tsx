import type { Metadata } from "next";
import { Ride } from "@/screens/ride";

export const metadata: Metadata = {
  title: "Safe Ride",
  description: "Preview ride monitoring, route deviation and stop-check flows.",
};

export default function RidePage() {
  return <Ride />;
}
