import React from 'react';
import type { Metadata } from 'next';
import { Manrope } from 'next/font/google';
import '../styles/globals.css';
import { MotionProvider } from '@/components/ui/MotionProvider';
import { ThemeProvider } from '@/components/ui/ThemeProvider';

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-ui',
  display: 'swap',
});
const themeScript = `(function(){var t='light';try{if(localStorage.getItem('apexformz-theme')==='dark')t='dark'}catch(e){}document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.style.colorScheme=t})();`;

export const metadata: Metadata = {
  title: 'ApexFormz | Precision in Motion',
  description:
    'AI-powered sports training. Analyse your technique, train with real-time feedback, and track your performance across seven disciplines.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body
        className={`${manrope.className} ${manrope.variable} bg-background text-foreground min-h-screen antialiased`}
      >
        <ThemeProvider>
          <MotionProvider>{children}</MotionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
