interface MapPictureNoticeProps {
  message: string | null;
}

export default function MapPictureNotice({ message }: MapPictureNoticeProps) {
  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="crx-map-picture-notice pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-md bg-white/95 px-2.5 py-1.5 text-center text-xs text-gray-700 shadow-sm"
    >
      {message}
    </div>
  );
}
