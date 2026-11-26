import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_PICTURE_STORAGE_KEY,
  readMapPicturePreference,
  saveMapPicturePreference,
} from './mapPreferences';

describe('map picture preference', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('defaults to Satellite and accepts one of the supported saved pictures', () => {
    expect(readMapPicturePreference()).toBe('satellite');
    expect(readMapPicturePreference('roads')).toBe('roads');
    window.localStorage.setItem(MAP_PICTURE_STORAGE_KEY, 'usda');
    expect(readMapPicturePreference()).toBe('usda');
  });

  it('ignores old, invalid, and Hybrid choices', () => {
    for (const invalid of ['hybrid', 'google', '']) {
      window.localStorage.setItem(MAP_PICTURE_STORAGE_KEY, invalid);
      expect(readMapPicturePreference()).toBe('satellite');
    }
  });

  it('uses the default when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked storage');
    });
    expect(readMapPicturePreference()).toBe('satellite');
  });

  it('keeps the in-memory map usable when saving storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked storage');
    });
    expect(() => saveMapPicturePreference('usda')).not.toThrow();
  });
});
