// Notifications de fin de génération : bip discret (WebAudio) et
// clignotement du titre de l'onglet quand la page est en arrière-plan.

let audioCtx: AudioContext | null = null;

/** Bip double discret (aucun fichier audio requis). */
export function playCompletionBeep(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = audioCtx ?? new Ctor();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const now = audioCtx.currentTime;
    for (const [freq, at] of [
      [660, 0],
      [880, 0.14],
    ] as const) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.06, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.2);
    }
  } catch {
    /* audio indisponible */
  }
}

let flashTimer: ReturnType<typeof setInterval> | null = null;

/** Fait clignoter le titre de l'onglet (limité en durée). */
export function flashTitle(message: string, times = 6): void {
  if (flashTimer) clearInterval(flashTimer);
  const base = document.title;
  let on = false;
  let count = 0;
  flashTimer = setInterval(() => {
    count += 1;
    on = !on;
    document.title = on ? message : base;
    if (count >= times * 2) {
      if (flashTimer) clearInterval(flashTimer);
      flashTimer = null;
      document.title = base;
    }
  }, 700);
}

/** Met en évidence le titre pendant la génération (onglet en arrière-plan). */
export function setGeneratingTitle(active: boolean): void {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
    document.title = document.title.replace(/^Hermes génère… · /, "");
  }
  if (active) {
    document.title = `Hermes génère… · ${document.title.replace(/^Hermes génère… · /, "")}`;
  } else {
    document.title = document.title.replace(/^Hermes génère… · /, "");
  }
}
