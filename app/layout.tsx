import type { Metadata } from "next";
import { Sidebar } from "@/src/ui/client";
import "./globals.css";

export const metadata: Metadata = { title: "Component Library" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#content">Skip to content</a>
        <div className="shell">
          <Sidebar />
          <main id="content" tabIndex={-1}>
            <div className="page">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
