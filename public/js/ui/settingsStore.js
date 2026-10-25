// Shared preference state without loading the settings modal / audio just to read image visibility.
// settings.js owns persistence and the audio / document effects, as before.
import { createStore, loadPref, savePref } from '../store.js';
import { sanitizeSettings } from './gameLogic/settings.js';

/** Settings store: { bgm, sfx, voice, voiceLang, voiceNative, voiceOverrides, muted, damageNumbers, officialDamageNumbers, ammoEnergyCount, fullscreenWakeLock, bondTimers, combatMetrics, prepDeployFold, quality, officialFx, otherSkins, textSize, keys }. */
const saved = loadPref('settings', null);
export const settingsStore = createStore(sanitizeSettings({ ...saved, ...(saved?.teamCombatV1 !== true ? { combatMetrics: true } : {}) }));
savePref('settings', { ...settingsStore.get(), teamCombatV1: true });
