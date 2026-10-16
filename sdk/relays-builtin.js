// The relay list built into the SDK (ADR 0030): what a call starts from when ours, at
// https://ax.fr.sa/relays.json, is not answered within 3 s or fails, so a join never needs our
// control plane up. Our relays, by name, on a real certificate: nothing is pinned. Each names its
// region (ADR 0036). The deploy writes this file as it writes the server's own list
// (lab/deploy.sh relays); it is fixed per SDK version.
export const BUILT_IN = Object.freeze([
  Object.freeze({ at: '187.7.77.25:443', name: 'ax.fr.sa', region: 'eu' }),
  Object.freeze({ at: '187.7.77.25:4433', name: 'ax.fr.sa', region: 'eu' }),
]);
