import type { Metadata } from "next";
import { Barlow, Bebas_Neue, JetBrains_Mono } from "next/font/google";
import { AppProviders } from "@/components/site/providers";
import "@/styles.css";

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-barlow",
});

const bebas = Bebas_Neue({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-bebas",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: {
    default: "Nirbhaya — Personal Safety Command System",
    template: "%s — Nirbhaya",
  },
  description:
    "Personal safety monitoring, guardian coordination, live risk signals and emergency escalation in one command system.",
  authors: [{ name: "Nirbhaya" }],
  openGraph: {
    title: "Nirbhaya — Personal Safety Command System",
    description: "Live risk signals, trusted guardians, safety history and visible emergency escalation.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${bebas.variable} ${jetbrains.variable}`}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
