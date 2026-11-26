export type MapPicture = 'satellite' | 'roads' | 'terrain' | 'usda';

export const MAP_PICTURE_STORAGE_KEY = 'crx.map-picture';
const DEFAULT_PICTURE: MapPicture = 'satellite';
const VALID_PICTURES = new Set<MapPicture>(['satellite', 'roads', 'terrain', 'usda']);

export function readMapPicturePreference(fallback: MapPicture = DEFAULT_PICTURE): MapPicture {
  try {
    if (typeof window === 'undefined') return DEFAULT_PICTURE;
    const stored = window.localStorage.getItem(MAP_PICTURE_STORAGE_KEY);
    if (stored === null) return fallback;
    return stored && VALID_PICTURES.has(stored as MapPicture)
      ? stored as MapPicture
      : DEFAULT_PICTURE;
  } catch {
    return DEFAULT_PICTURE;
  }
}

export function saveMapPicturePreference(picture: MapPicture): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MAP_PICTURE_STORAGE_KEY, picture);
    }
  } catch {
    // Private browsing or storage policy can disable localStorage; maps still work in memory.
  }
}
