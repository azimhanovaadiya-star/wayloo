/**
 * TextToSpeechEngine — Web Speech API wrapper (PRD §4).
 * The rest of the app never touches speechSynthesis directly.
 */

export type TtsStatus = "idle" | "speaking" | "error" | "unavailable";

export class TtsEngine {
  private voices: SpeechSynthesisVoice[] = [];
  private status: TtsStatus = "idle";

  constructor() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      this.status = "unavailable";
      return;
    }
    this.loadVoices();
    // Chrome loads voices asynchronously.
    window.speechSynthesis.onvoiceschanged = () => this.loadVoices();
  }

  get available(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  get state(): TtsStatus {
    return this.status;
  }

  cancel(): void {
    if (this.available) window.speechSynthesis.cancel();
    this.status = "idle";
  }

  private loadVoices(): void {
    if (!this.available) return;
    this.voices = window.speechSynthesis.getVoices();
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    const en = this.voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
    if (en.length === 0) return null;
    const preferred =
      en.find((v) => /google uk english|google us english|samantha|karen|daniel|serena/i.test(v.name)) ??
      en.find((v) => /female/i.test(v.name)) ??
      en[0];
    return preferred;
  }

  /**
   * Speak `text`. Resolves when speech finishes (or immediately if TTS is
   * unavailable — the response stays visible in the panel, app never breaks).
   */
  /**
   * Speak `text`. Resolves when speech finishes (or immediately if TTS is
   * unavailable — the response stays visible in the panel, app never breaks).
   * `onStart` fires the moment the utterance actually begins (voice latency leg).
   */
  speak(text: string, onStart?: () => void): Promise<{ spoke: boolean }> {
    if (!this.available) {
      this.status = "unavailable";
      return Promise.resolve({ spoke: false });
    }
    this.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.pickVoice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? "en";
    u.rate = 1.02;
    u.pitch = 1;
    this.status = "speaking";
    return new Promise((resolve) => {
      if (onStart) u.onstart = onStart;
      u.onend = () => {
        this.status = "idle";
        resolve({ spoke: true });
      };
      u.onerror = (e) => {
        // SpeechSynthesisErrorEvent — don't crash; keep silent failure graceful.
        this.status = e.error === "canceled" ? "idle" : "error";
        resolve({ spoke: e.error !== "canceled" });
      };
      window.speechSynthesis.speak(u);
    });
  }
}