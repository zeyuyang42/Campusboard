const I = ({ d, size = 18, fill = "currentColor" }: { d: string; size?: number; fill?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} aria-hidden="true"><path d={d} /></svg>
);
export const PlayIcon = ({ size = 18 }: { size?: number }) => <I size={size} d="M8 5v14l11-7z" />;
export const PauseIcon = ({ size = 18 }: { size?: number }) => <I size={size} d="M6 5h4v14H6zm8 0h4v14h-4z" />;
export const NextIcon = () => <I d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z" />;
export const PrevIcon = () => <I d="M6 6h2v12H6zm3.5 6l8.5 6V6l-8.5 6z" />;
export const ShuffleIcon = () => <I d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />;
export const RepeatIcon = () => <I d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />;
export const RepeatOneIcon = () => <I d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z" />;
export const QueueIcon = () => <I d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />;
export const VolumeIcon = ({ muted }: { muted?: boolean }) => muted ? <I d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /> : <I d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />;
export const MoreIcon = () => <I d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />;
export const PlusIcon = () => <I d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />;
export const CloseIcon = ({ size }: { size?: number } = {}) => <I size={size} d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />;
export const UpIcon = () => <I size={16} d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z" />;
export const DownIcon = () => <I size={16} d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />;
export const ExternalIcon = () => <I size={14} d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />;
export const ExpandIcon = ({ size }: { size?: number } = {}) => <I size={size} d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />;
/** An offline copy (#2): a small check in a circle, for track rows. */
export const SavedIcon = ({ size = 13 }: Sized) => <I size={size} d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1.6 14.2L6.2 12l1.4-1.4 2.8 2.8 6-6 1.4 1.4-7.4 7.4z" />;
/** The sleep timer (#70). */
export const ClockIcon = () => <I d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />;
/** AirPlay audio: rings above a triangle (#42). */
export const AirPlayIcon = () => <I d="M6 22h12l-6-6-6 6zM12 2C6.48 2 2 6.48 2 12c0 2.73 1.1 5.21 2.88 7.02l1.42-1.42A7.96 7.96 0 0 1 4 12c0-4.42 3.58-8 8-8s8 3.58 8 8c0 2.2-.89 4.2-2.32 5.62l1.42 1.42A9.96 9.96 0 0 0 22 12c0-5.52-4.48-10-10-10zm0 4c-3.31 0-6 2.69-6 6 0 1.66.67 3.16 1.76 4.24l1.42-1.42A3.98 3.98 0 0 1 8 12c0-2.21 1.79-4 4-4s4 1.79 4 4c0 1.1-.45 2.1-1.18 2.82l1.42 1.42A5.98 5.98 0 0 0 18 12c0-3.31-2.69-6-6-6z" />;
export const MenuIcon = () => <I d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />;
type Sized = { size?: number };
export const MiniPlayerIcon = ({ size }: Sized) => <I size={size} d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z" />;
export const PinIcon = ({ size }: Sized) => <I size={size} d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />;
export const SquareIcon = ({ size }: Sized) => <I size={size} d="M18 4H6c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H6V6h12v12z" />;
export const StripIcon = ({ size }: Sized) => <I size={size} d="M19 8H5c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2zm0 6H5v-4h14v4z" />;
