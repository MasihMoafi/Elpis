import type { Metadata } from "next";
import "./globals.css";
import "@/components/decision-card.css";
// The Elpis mark is the favicon of the Elpis website (website/index.html in this repository).
export const metadata: Metadata = { title: "Elpis", description: "Your local coding workspace", icons: { icon: "/branding/favicon-amber.svg" } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
