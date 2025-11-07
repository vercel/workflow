import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Durable Agents',
  description: 'A durable agent using the new Workflow DevKit',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
