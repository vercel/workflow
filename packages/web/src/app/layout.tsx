import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { connection } from 'next/server';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { LayoutClient } from './layout-client';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Workflow Observability UI',
  description:
    'Web interface for inspecting flow runs, steps, streams, and events',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // TODO: We should be using SSR as much as possible, remove this line
  // and move the config/search params code to server-compatible pattern
  await connection();

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <NuqsAdapter>
          <LayoutClient>{children}</LayoutClient>
        </NuqsAdapter>
      </body>
    </html>
  );
}
