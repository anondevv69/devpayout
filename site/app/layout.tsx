import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DEVS — Hold DEVS. Receive MSFT.",
  description: "Open-source payout mechanics for $DEVS holders on Robinhood Chain.",
  openGraph: { title: "DEVS — Hold DEVS. Receive MSFT.", description: "Open-source payout mechanics for $DEVS holders on Robinhood Chain.", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "DEVS — Hold DEVS. Receive MSFT.", description: "Open-source payout mechanics for $DEVS holders on Robinhood Chain.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
