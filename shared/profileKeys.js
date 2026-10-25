import { DEFAULT_VERSION, VERSIONS, versionSlug } from './versions.js';

// Keep older default-season passports valid; additional seasons have their own DIY slots.
export const PROFILE_KEYS = Object.freeze(['loadout', 'ownership', 'diy', 'skins', 'stats',
  ...VERSIONS.filter(v => v.id !== DEFAULT_VERSION).map(v => `diy.${versionSlug(v)}`)]);
