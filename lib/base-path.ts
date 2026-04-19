export const SITE_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function withBasePath(path: string) {
  if (!SITE_BASE_PATH) return path;
  if (path === '/') return SITE_BASE_PATH || '/';
  return `${SITE_BASE_PATH}${path}`;
}
