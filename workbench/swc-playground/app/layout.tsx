import { Analytics } from '@vercel/analytics/next';
import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import type React from 'react';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';

const _geist = Geist({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Workflow DevKit Compiler Playground',
  description: 'Playground for SWC with @workflow/swc-plugin',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Analytics />
        </ThemeProvider>
      </body>
    </html>
  );
}
