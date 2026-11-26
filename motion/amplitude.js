import {DEFAULT_CONFIG} from './core.js';

// Copied unchanged from 慢慢跑酷 0.1.2 src/motion/amplitude.js.
// Strategy source: user's private songyuanhong/shenxian-gym,
// 原型/pose.js@47d69a8c2f1733d0bfdcbfa3d5a20c8a1c3d4dd6.
// Retain its small/medium/large multipliers, not its body-height thresholds,
// CDN integration or gameplay. These thresholds use this project's torso units.
const FACTORS = Object.freeze({small:.75, medium:1, large:1.3});
const SPATIAL_THRESHOLDS = Object.freeze([
  'jumpOn','jumpOff','squatOn','squatOff','kneeOn','kneeOff','stepOn','armSwingOn','bobOn',
  'sideOn','sideOff','armsOn','armsOff',
]);
// reachOn/reachOther are shoulder-relative heights and are intentionally not scaled.

/** Build from unscaled defaults/overrides on every call; never pass a previous
 * scaled result as overrides when switching profiles. Timing, filtering,
 * calibration, visibility and all other parameters retain their baseline values.
 */
export function amplitudeConfig(profile = 'medium', overrides = {}) {
  if (typeof profile !== 'string' || !Object.hasOwn(FACTORS, profile)) {
    throw new RangeError(`Unknown motion amplitude: ${String(profile)}`);
  }
  const config = {...DEFAULT_CONFIG, ...overrides};
  for (const key of SPATIAL_THRESHOLDS) config[key] *= FACTORS[profile];
  return config;
}
