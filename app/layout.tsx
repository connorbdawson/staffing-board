import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { withBasePath } from '../lib/base-path';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Staffing Board',
  description: 'Tablet-friendly staffing and scheduling for small businesses.',
  manifest: withBasePath('/manifest.webmanifest'),
  appleWebApp: {
    capable: true,
    title: 'Staffing Board',
    statusBarStyle: 'default',
  },
  icons: {
    icon: withBasePath('/icon.svg'),
    apple: withBasePath('/icon.svg'),
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#2563eb',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.className}>
      <body>{children}</body>
    </html>
  );
}
