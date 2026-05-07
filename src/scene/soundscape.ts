/**
 * Sheikah-style procedural soundscape via Web Audio API.
 *
 *   • Ambient drone — low cyan tone with slow filter sweep, always-on
 *     while enabled. Carries the "powered on" feeling of a Sheikah Slate.
 *   • Chime — short amber bell triggered on each tier transition.
 *   • Heartbeat — short sub-bass thump for the opening scan.
 *
 * Browsers require a user gesture before audio can start. We don't
 * auto-start; the user toggles "Sound" in the panel, which calls enable().
 */

export type Soundscape = {
  enable(): Promise<void>;
  disable(): void;
  enabled: () => boolean;
  chime(): void;
  heartbeat(): void;
};

export function createSoundscape(): Soundscape {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let droneNodes: AudioNode[] = [];
  let on = false;

  function ensureCtx(): AudioContext {
    if (!ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctor();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0;
      masterGain.connect(ctx.destination);
    }
    return ctx;
  }

  function startDrone() {
    if (!ctx || !masterGain) return;
    stopDrone();

    // Two low oscillators — root + perfect fifth (a major-fifth interval reads
    // as cinematic / hopeful, not minor / spooky). Slight detune for chorus.
    const root = ctx.createOscillator();
    root.type = 'sine';
    root.frequency.value = 110;
    root.detune.value = -4;

    const fifth = ctx.createOscillator();
    fifth.type = 'sine';
    fifth.frequency.value = 165;
    fifth.detune.value = +6;

    // Sub for body
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 55;

    // Per-voice gains
    const rootGain = ctx.createGain(); rootGain.gain.value = 0.10;
    const fifthGain = ctx.createGain(); fifthGain.gain.value = 0.07;
    const subGain = ctx.createGain(); subGain.gain.value = 0.18;

    // Lowpass filter — characteristic Sheikah "muted" sound
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.7;

    // Slow filter sweep LFO (~0.06 Hz = 16s period)
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220; // ±220 Hz around the base
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    // Wire voices → filter → master
    root.connect(rootGain).connect(filter);
    fifth.connect(fifthGain).connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(masterGain);

    root.start();
    fifth.start();
    sub.start();
    lfo.start();

    droneNodes = [root, fifth, sub, lfo, rootGain, fifthGain, subGain, filter, lfoGain];
  }

  function stopDrone() {
    for (const n of droneNodes) {
      if ('stop' in n) (n as OscillatorNode).stop();
      n.disconnect();
    }
    droneNodes = [];
  }

  return {
    enabled: () => on,

    async enable() {
      ensureCtx();
      if (ctx!.state === 'suspended') await ctx!.resume();
      on = true;
      // Fade in the drone over 1.2s.
      const now = ctx!.currentTime;
      masterGain!.gain.cancelScheduledValues(now);
      masterGain!.gain.setValueAtTime(masterGain!.gain.value, now);
      masterGain!.gain.linearRampToValueAtTime(0.45, now + 1.2);
      startDrone();
    },

    disable() {
      on = false;
      if (!ctx || !masterGain) return;
      const now = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(masterGain.gain.value, now);
      masterGain.gain.linearRampToValueAtTime(0, now + 0.8);
      // Stop drone after the fade so we don't cut audibly.
      setTimeout(() => stopDrone(), 900);
    },

    chime() {
      if (!on || !ctx) return;
      const now = ctx.currentTime;
      // Bell tone: fundamental + inharmonic partials with exponential decay.
      const freq = 880;
      const partials = [
        { f: freq,        g: 0.45, decay: 1.6 },
        { f: freq * 1.76, g: 0.18, decay: 1.0 },
        { f: freq * 2.64, g: 0.10, decay: 0.7 },
        { f: freq * 0.5,  g: 0.20, decay: 1.8 },
      ];
      const tail = ctx.createGain();
      tail.gain.value = 1;
      tail.connect(masterGain!);

      for (const p of partials) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = p.f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(p.g, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);
        osc.connect(g).connect(tail);
        osc.start(now);
        osc.stop(now + p.decay + 0.05);
      }
    },

    heartbeat() {
      if (!on || !ctx) return;
      const now = ctx.currentTime;
      // 60 Hz sub-bass thump, two beats spaced like a heartbeat.
      const beat = (when: number, gain: number) => {
        const osc = ctx!.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 60;
        const g = ctx!.createGain();
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(gain, when + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
        osc.connect(g).connect(masterGain!);
        osc.start(when);
        osc.stop(when + 0.22);
      };
      beat(now, 0.5);
      beat(now + 0.20, 0.32);
    },
  };
}
