import type { ReactNode } from 'react';

const shapes = {
  addTask: <><path d="M12 21a9 9 0 1 0-9-9c0 1.48.36 2.88 1 4.12L3 21l4.88-1c1.24.64 2.64 1 4.12 1Z" /><path d="M12 8.5v7M8.5 12h7" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="4" /><path d="M8 7v10" /></>,
  message: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />,
  settings: <><path d="M12 3.5 19.36 7.75v8.5L12 20.5 4.64 16.25v-8.5Z" /><circle cx="12" cy="12" r="3.2" /></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></>,
  play: <path d="m9 5 11 7-11 7Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  video: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3ZM7 4v16m10-16v16M3 9h4m10 0h4M3 15h4m10 0h4" /></>,
  link: <><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)" /></>,
  external: <><path d="M14 3h7v7m0-7L10 14M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /></>,
  volume: <><path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
  muted: <><path d="m11 4-6 5H2v6h3l6 5ZM16 9l6 6m0-6-6 6" /></>,
  fullscreen: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
} satisfies Record<string, ReactNode>;

export function Icon({ name, size = 20 }: { name: keyof typeof shapes; size?: number }) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}
