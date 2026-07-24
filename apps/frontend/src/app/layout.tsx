import React from 'react';
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "../styles/globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Apexformz | AI Sports Trainer",
  description: "Democratizing elite coaching with real-time AI pose estimation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-background text-foreground min-h-screen antialiased`}>
        <div className="fixed inset-0 bg-[url('/grid.svg')] bg-center [mask-image:linear-gradient(180deg,white,rgba(255,255,255,0))] -z-10" />
        <div className="fixed top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent z-50" />
        {children}
      </body>
    </html>
  );
}
