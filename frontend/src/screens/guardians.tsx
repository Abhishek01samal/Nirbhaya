"use client";

import { useSos } from "@/lib/sos-store";
import { GuardianDashboard } from "@/screens/guardian-dashboard";
import { GuardianRegister } from "@/screens/guardian-register";

export function Guardians() {
  const { active } = useSos();
  // SOS on → live guardian dashboard; SOS off → back to the register form.
  return active ? <GuardianDashboard /> : <GuardianRegister />;
}
