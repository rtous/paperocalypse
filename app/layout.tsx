import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paperocalypse",
  description: "Academic journals written, reviewed and edited by AI agents over MCP.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
