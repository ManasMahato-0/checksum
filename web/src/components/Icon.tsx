// Small stroke icons, 16px by default; color comes from currentColor.
const paths = {
  check: <path d="M3.5 8.5l3 3 6-7" />,
  x: <path d="M4.5 4.5l7 7m0-7l-7 7" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.5l6 10.5H2z" />
      <path d="M8 7v2.5m0 1.8v.2" />
    </>
  ),
  upload: <path d="M8 10.5V3m0 0L5 6m3-3l3 3M3 10.5v1A1.5 1.5 0 004.5 13h7a1.5 1.5 0 001.5-1.5v-1" />,
  file: (
    <>
      <path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6z" />
      <path d="M9 2v4h4" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5m0 10v1.5M1.5 8H3m10 0h1.5M3.4 3.4l1 1m7.2 7.2l1 1m0-9.2l-1 1m-7.2 7.2l-1 1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  arrowUp: <path d="M8 13V3m0 0L4 7m4-4l4 4" />,
  arrowDown: <path d="M8 3v10m0 0l-4-4m4 4l4-4" />,
  chevronLeft: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  chevronRight: <path d="M6 3.5L10.5 8 6 12.5" />,
  chevronDown: <path d="M3.5 6l4.5 4.5L12.5 6" />,
  logout: <path d="M6.5 13.5H4A1.5 1.5 0 012.5 12V4A1.5 1.5 0 014 2.5h2.5M10.5 11l3-3-3-3M13.5 8H6" />,
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.2V11m0-6v.2" />
    </>
  ),
};

export type IconName = keyof typeof paths | 'spinner';

export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  if (name === 'spinner') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="spinner" {...a11y}>
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M13.5 8A5.5 5.5 0 008 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...a11y}
    >
      {paths[name]}
    </svg>
  );
}
