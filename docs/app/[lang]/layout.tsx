import '../global.css';
import type { Metadata } from 'next';
import { Footer } from '@/components/geistdocs/footer';
import { Navbar } from '@/components/geistdocs/navbar';
import { GeistdocsProvider } from '@/components/geistdocs/provider';
import { basePath } from '@/geistdocs';
import { mono, sans } from '@/lib/geistdocs/fonts';
import { cn } from '@/lib/utils';

const getMetadataBase = () => {
  // Use VERCEL_URL for preview deployments, production URL for production
  if (process.env.VERCEL_ENV === 'production') {
    return new URL('https://useworkflow.dev');
  }
  if (process.env.VERCEL_URL) {
    return new URL(`https://${process.env.VERCEL_URL}`);
  }
  // Fallback for local development
  return new URL('http://localhost:3000');
};

export const metadata: Metadata = {
  metadataBase: getMetadataBase(),
};

const Layout = async ({ children, params }: LayoutProps<'/[lang]'>) => {
  const { lang } = await params;

  return (
    <html
      className={cn(sans.variable, mono.variable, 'scroll-smooth antialiased')}
      lang={lang}
      suppressHydrationWarning
    >
      <body>
        <GeistdocsProvider basePath={basePath} lang={lang}>
          <Navbar />
          {children}
          <Footer />
        </GeistdocsProvider>
      </body>
    </html>
  );
};

export default Layout;
