// First / third person: which view the local camera uses (no three.js here —
// the input controller reads it every frame). Default ('auto'): first person
// with mouse + keyboard, third person on touch controls; the toggle key flips
// it and the choice is saved (UserSettings.cameraView).

export type CameraViewSetting = 'auto' | 'first' | 'third';
export type CameraView = 'first' | 'third';

/** Key that flips first ↔ third person (V is taken by the squad's 冲锋 order). */
export const CAMERA_TOGGLE_KEY = 'KeyH';
/** Its label in hints. */
export const CAMERA_TOGGLE_LABEL = 'H';

/** The view in use: 'auto' = first person with mouse + keyboard, third person on touch controls. */
export function resolveCameraView(setting: CameraViewSetting | undefined, touch: boolean): CameraView {
  if (setting === 'first' || setting === 'third') return setting;
  return touch ? 'third' : 'first';
}

/** The setting after pressing the toggle key: the other view, explicitly. */
export function toggledCameraView(setting: CameraViewSetting | undefined, touch: boolean): CameraView {
  return resolveCameraView(setting, touch) === 'first' ? 'third' : 'first';
}
