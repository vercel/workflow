import '@/app/global.css';
import { Analytics } from '@vercel/analytics/next';
import { RootProvider } from 'fumadocs-ui/provider';
import { Geist, Geist_Mono } from 'next/font/google';
import { HomeLayout } from '@/components/layout/home';
import { Toaster } from '@/components/ui/sonner';
import { baseOptions } from '@/lib/layout.shared';
import { Metadata } from 'next';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://useworkflow.dev'),
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider
          search={{
            links: [
              ['Getting Started with Workflows', '/docs/getting-started'],
              ['Concepts', '/docs/foundations/concepts'],
              [
                'Control Flow Patterns',
                '/docs/foundations/control-flow-patterns',
              ],
              ['Errors & Retries', '/docs/foundations/errors-and-retries'],
              ['API Reference', '/docs/api-reference'],
            ],
          }}
        >
          <HomeLayout
            baseOptions={baseOptions}
            links={[
              {
                text: 'Docs',
                url: '/docs/getting-started',
                secondary: false,
              },
              {
                text: 'Examples',
                url: 'https://github.com/vercel/workflow-examples',
                secondary: false,
              },
            ]}
          >
            {children}
          </HomeLayout>
        </RootProvider>
        <Toaster />
        <Analytics />
      </body>
    </html>
  );
}
