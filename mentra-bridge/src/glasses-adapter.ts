import WebSocket from "ws";

/**
 * Glasses Adapter — connects smart glasses SDKs to the V3SP3R bridge.
 *
 * Supported platforms:
 *   - MentraOS (@mentra/sdk) — Mentra Live, Even Realities G1
 *   - Generic WebSocket — any glasses with a WS API
 */

interface GlassesMessage {
  type: string;
  text?: string;
  imageBase64?: string;
  imageMimeType?: string;
  displayText?: string;
  isFinal?: boolean;
  metadata?: Record<string, string>;
}

// ==================== Base Adapter ====================

export abstract class GlassesAdapter {
  protected ws: WebSocket | null = null;
  protected bridgeUrl: string;

  constructor(bridgeUrl: string) {
    this.bridgeUrl = bridgeUrl;
  }

  connect() {
    this.ws = new WebSocket(this.bridgeUrl);

    this.ws.on("open", () => {
      console.log(`[${this.name}] Connected to bridge`);
      this.onBridgeConnected();
    });

    this.ws.on("message", (data) => {
      try {
        const message: GlassesMessage = JSON.parse(data.toString());
        this.onBridgeMessage(message);
      } catch {
        console.warn(`[${this.name}] Invalid bridge message`);
      }
    });

    this.ws.on("close", () => {
      console.log(`[${this.name}] Disconnected from bridge`);
      setTimeout(() => this.connect(), 3000);
    });
  }

  protected send(message: GlassesMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  abstract get name(): string;
  abstract onBridgeConnected(): void;
  abstract onBridgeMessage(message: GlassesMessage): void;
}

// ==================== MentraOS Adapter ====================

/**
 * MentraOS adapter using the verified @mentra/sdk API.
 *
 * Real API surface (from @mentra/sdk v2.1.29):
 *   - session.events.onTranscription(cb)  → { text, isFinal, transcribeLanguage }
 *   - session.events.onPhotoTaken(cb)     → { photoData: ArrayBuffer }
 *   - session.events.onButtonPress(cb)    → ButtonPress data
 *   - session.camera.requestPhoto(opts)   → { photoData: ArrayBuffer, mimeType }
 *   - session.audio.speak(text, opts)     → TTS through glasses speakers
 *   - session.layouts.showTextWall(text, opts) → HUD display
 *   - session.layouts.showReferenceCard({ title, text }) → Card display
 *   - session.layouts.clearView()         → Clear HUD
 *
 * Usage:
 *   import { AppServer, AppSession } from '@mentra/sdk';
 *
 *   class VesperBridge extends AppServer {
 *     constructor() {
 *       super({
 *         packageName: 'com.vesper.glasses',
 *         apiKey: process.env.MENTRA_API_KEY!,
 *         port: 3000
 *       });
 *     }
 *
 *     async onSession(session: AppSession, sessionId: string, userId: string) {
 *       const adapter = new MentraAdapter('ws://bridge:8089');
 *       adapter.connect();
 *       adapter.initSession(session);
 *     }
 *   }
 */
export class MentraAdapter extends GlassesAdapter {
  // AppSession from @mentra/sdk — typed as any since SDK types may vary
  private session: any = null;

  get name() {
    return "MentraOS";
  }

  /**
   * Initialize with a MentraOS AppSession.
   * Call from your AppServer.onSession() handler.
   */
  initSession(session: any) {
    this.session = session;

    // Voice transcription → V3SP3R
    session.events.onTranscription(
      (data: { text: string; isFinal: boolean; transcribeLanguage?: string }) => {
        if (data.isFinal && data.text.trim()) {
          console.log(`[MentraOS] Transcription: "${data.text}"`);
          this.send({
            type: "VOICE_TRANSCRIPTION",
            text: data.text.trim(),
            isFinal: true,
            metadata: {
              source: "mentra",
              language: data.transcribeLanguage || "en",
            },
          });
        }
      }
    );

    // Reactive photo events (when user takes photo via glasses UI)
    session.events.onPhotoTaken(
      (data: { photoData: ArrayBuffer }) => {
        const imageBase64 = Buffer.from(data.photoData).toString("base64");
        console.log(`[MentraOS] Photo taken: ${imageBase64.length} chars`);
        this.send({
          type: "CAMERA_PHOTO",
          text: "What am I looking at?",
          imageBase64,
          imageMimeType: "image/jpeg",
          metadata: { source: "mentra" },
        });
      }
    );

    // Button press → could trigger voice command mode or photo capture
    session.events.onButtonPress((data: any) => {
      console.log(`[MentraOS] Button press:`, data);
    });

    console.log("[MentraOS] Session initialized — listening for voice & camera events");
  }

  /**
   * Programmatically request a photo from glasses camera.
   * Use for "What am I looking at?" voice-triggered vision analysis.
   */
  async requestVisionAnalysis(prompt: string = "What am I looking at?") {
    if (!this.session?.camera?.requestPhoto) {
      console.warn("[MentraOS] Camera API not available on this session");
      return;
    }

    try {
      const photo = await this.session.camera.requestPhoto({
        metadata: { reason: "vesper-vision" },
      });

      const imageBase64 = Buffer.from(photo.photoData).toString("base64");

      this.send({
        type: "CAMERA_PHOTO",
        text: prompt,
        imageBase64,
        imageMimeType: photo.mimeType || "image/jpeg",
        metadata: { source: "mentra" },
      });

      // Show processing indicator on glasses
      await this.session.layouts.showTextWall("Analyzing...", {
        durationMs: 3000,
      });
    } catch (e) {
      console.error("[MentraOS] Camera capture failed:", (e as Error).message);
    }
  }

  onBridgeConnected() {
    console.log("[MentraOS] Bridge relay active");
  }

  /**
   * Handle V3SP3R responses — speak through glasses + show on HUD.
   */
  onBridgeMessage(message: GlassesMessage) {
    if (!this.session) return;

    switch (message.type) {
      case "AI_RESPONSE":
        // Cancel in-flight speech, then speak with British female voice
        if (message.text) {
          this.session.audio.stop?.().catch(() => {});
          this.session.audio
            .speak(message.text, {
              language: "en-GB",
              voice: "en-GB-Wavenet-F",
            })
            .catch((e: Error) =>
              console.warn("[MentraOS] TTS failed:", e.message)
            );
        }
        // Show on HUD
        if (message.displayText) {
          this.session.layouts
            .showReferenceCard({
              title: "V3SP3R",
              text: message.displayText,
            })
            .catch((e: Error) =>
              console.warn("[MentraOS] Display failed:", e.message)
            );
        }
        break;

      case "STATUS_UPDATE":
        if (message.text) {
          this.session.layouts
            .showTextWall(message.text, { durationMs: 5000 })
            .catch((e: Error) =>
              console.warn("[MentraOS] Display failed:", e.message)
            );
        }
        break;
    }
  }
}

// ==================== Generic WebSocket Adapter ====================

/**
 * Generic adapter for glasses that expose a simple WebSocket API.
 */
export class GenericGlassesAdapter extends GlassesAdapter {
  private glassesWs: WebSocket | null = null;

  get name() {
    return "Generic";
  }

  connectToGlasses(glassesWsUrl: string) {
    this.glassesWs = new WebSocket(glassesWsUrl);

    this.glassesWs.on("message", (data) => {
      try {
        const message: GlassesMessage = JSON.parse(data.toString());
        this.send(message);
      } catch {
        // ignore invalid messages
      }
    });
  }

  onBridgeConnected() {}

  onBridgeMessage(message: GlassesMessage) {
    if (
      this.glassesWs?.readyState === WebSocket.OPEN &&
      (message.type === "AI_RESPONSE" || message.type === "STATUS_UPDATE")
    ) {
      this.glassesWs.send(JSON.stringify(message));
    }
  }
}
