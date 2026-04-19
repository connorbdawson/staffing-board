import type { Metadata, Viewport } from 'next';
import './globals.css';
import { withBasePath } from '../lib/base-path';

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
  themeColor: '#16463b',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
