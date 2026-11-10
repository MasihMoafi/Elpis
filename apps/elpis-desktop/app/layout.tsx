import type { Metadata } from "next";
import { preload } from "react-dom";
import { AppearanceTokens } from "@/components/appearance-tokens";
import { ArrowKeys } from "@/components/arrow-keys";
import "./globals.css";
import "@/components/decision-card.css";
// The Elpis mark is the favicon of the Elpis website (website/index.html in this repository).
export const metadata: Metadata = {
  description: "Your local coding workspace",
  icons: { icon: "/branding/favicon-amber.svg" },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The startup E is fetched with the page, so it shows on the splash's first frame (10 Nov: it arrived 0.3 s late).
  preload("/branding/elpis-symbol-amber.svg", { as: "image" });
  return (
    <html lang="en">
      <body>
        <AppearanceTokens />
        <ArrowKeys />
        {children}
      </body>
    </html>
  );
}
