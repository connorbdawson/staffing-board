import type { MetadataRoute } from 'next';
import { withBasePath } from '../lib/base-path';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Staffing Board',
    short_name: 'Staffing',
    description: 'Tablet-friendly staffing and scheduling for small businesses.',
    start_url: withBasePath('/'),
    scope: withBasePath('/'),
    display: 'standalone',
    background_color: '#f4f0e8',
    theme_color: '#16463b',
    icons: [
      {
        src: withBasePath('/icon.svg'),
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
