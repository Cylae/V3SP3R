import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server as HttpServer } from "http";

/**
 * V3SP3R ↔ Mentra Glasses Bridge Server
 *
 * This server acts as a relay between:
 *   - Smart glasses (MentraOS, Even Realities, Vuzix, etc.)
 *   - V3SP3R Android app
 *
 * Architecture:
 *   [Glasses] → (MentraOS Cloud) → [This Bridge] → (WebSocket) → [V3SP3R App]
 *
 * Modes:
 *   1. Standalone relay (default) — glasses connect directly via WebSocket
 *   2. MentraOS mode — set MENTRA_API_KEY env var to enable native SDK integration
 *
 * Deployment: Railway, Fly.io, Render, or local with ngrok for dev.
 */

// ==================== Wire Protocol ====================

export interface GlassesMessage {
  type:
    | "VOICE_TRANSCRIPTION"
    | "CAMERA_PHOTO"
    | "VOICE_COMMAND"
    | "AI_RESPONSE"
    | "STATUS_UPDATE"
    | "CONFIG"
    | "CAPTURE_REQUEST";
  text?: string;
  imageBase64?: string;
  imageMimeType?: string;
  displayText?: string;
  isFinal?: boolean;
  metadata?: Record<string, string>;
}

// ==================== Client Tracking ====================

export interface ConnectedClient {
  ws: WebSocket;
  type: "glasses" | "vesper" | "unknown";
  connectedAt: number;
}

export const clients = new Map<WebSocket, ConnectedClient>();

export function getVesperClients(): WebSocket[] {
  return Array.from(clients.entries())
    .filter(([, c]) => c.type === "vesper")
    .map(([ws]) => ws);
}

export function getGlassesClients(): WebSocket[] {
  return Array.from(clients.entries())
    .filter(([, c]) => c.type === "glasses")
    .map(([ws]) => ws);
}

export function broadcast(targets: WebSocket[], message: GlassesMessage) {
  const payload = JSON.stringify(message);
  for (const ws of targets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ==================== Sailor Mouth & State ====================

export let sailorMouthEnabled = false;
export let glassesMuted = false;

export function setSailorMouth(enabled: boolean) {
  sailorMouthEnabled = enabled;
}

export function setGlassesMuted(muted: boolean) {
  glassesMuted = muted;
}

// ── TTS Echo Suppression ──────────────────────────────────────────
export let ttsSpeaking = false;
export let ttsEchoSuppressionUntil = 0;
export const TTS_ECHO_COOLDOWN_MS = 2500;
export let lastSpokenText = "";

export function setTtsSpeaking(speaking: boolean) {
  ttsSpeaking = speaking;
}

export function setLastSpokenText(text: string) {
  lastSpokenText = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Track session context so greetings feel natural
export let wakeCount = 0;
export let lastWakeTimestamp = 0;
export let lastTaskTimestamp = 0;

export const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

export function resetSessionContext() {
  wakeCount = 0;
  lastWakeTimestamp = 0;
  lastTaskTimestamp = 0;
  sailorMouthEnabled = false;
  glassesMuted = false;
  ttsSpeaking = false;
  ttsEchoSuppressionUntil = 0;
  lastSpokenText = "";
  clients.clear();
}

// ── Normal greetings (context-aware) ────────────────────────
const GREETINGS_FIRST = [
  "hey! what's up?",
  "hi fren, what do you need?",
  "hey there, I'm listening",
];

const GREETINGS_RETURN = [
  "welcome back, what's next?",
  "hey again! what do you need?",
  "back at it, what's the move?",
];

const GREETINGS_ACTIVE = [
  "yeah?",
  "what's up?",
  "listening",
  "go ahead",
  "I'm here",
];

const GREETINGS_WITH_COMMAND = [
  "on it",
  "got it",
  "roger that",
  "working on it",
  "let me check",
];

// ── Sailor mouth greetings ──────────────────────────────────
const SAILOR_FIRST = [
  "sup bitch, what we hackin?",
  "HACK THE PLANET, MOTHERFUCKER!",
  "yo what's good, you beautiful degenerate",
];

const SAILOR_RETURN = [
  "oh shit, you're back! what now?",
  "bout damn time you called me",
  "missed you, asshole. what's the play?",
];

const SAILOR_ACTIVE = [
  "yeah bitch?",
  "what now?",
  "talk to me",
  "spit it out",
  "I'm all ears, fucker",
];

const SAILOR_WITH_COMMAND = [
  "on it, you crazy bastard",
  "fuck yeah, let's go",
  "hell yeah, hold my beer",
  "let's break some shit",
  "ready to fuck shit up, captain",
  "at your service, you glorious bastard",
  "what's crackin, you magnificent asshole",
  "let's go, you crazy son of a bitch",
];

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function getWakeGreeting(hasCommand: boolean): string {
  const now = Date.now();
  const timeSinceLastWake = now - lastWakeTimestamp;
  const isFirstWake = wakeCount === 0;
  const isReturning = timeSinceLastWake > IDLE_THRESHOLD_MS;
  const isActive = (now - lastTaskTimestamp) < IDLE_THRESHOLD_MS && !isFirstWake;

  wakeCount++;
  lastWakeTimestamp = now;

  if (hasCommand) {
    return pick(sailorMouthEnabled ? SAILOR_WITH_COMMAND : GREETINGS_WITH_COMMAND);
  }
  if (isFirstWake) {
    return pick(sailorMouthEnabled ? SAILOR_FIRST : GREETINGS_FIRST);
  }
  if (isReturning) {
    return pick(sailorMouthEnabled ? SAILOR_RETURN : GREETINGS_RETURN);
  }
  return pick(sailorMouthEnabled ? SAILOR_ACTIVE : GREETINGS_ACTIVE);
}

export function handleMessage(sender: WebSocket, message: GlassesMessage) {
  const client = clients.get(sender);
  if (!client) return;

  switch (message.type) {
    case "VOICE_TRANSCRIPTION":
    case "VOICE_COMMAND":
      if (client.type === "unknown") {
        client.type = "glasses";
        console.log("Client identified as glasses");
      }
      if (glassesMuted) {
        console.log("[Muted] Suppressing voice input");
        break;
      }
      broadcast(getVesperClients(), message);

      if (message.text) {
        const lower = message.text.toLowerCase();
        const visionTriggers = [
          "what am i looking at", "what do you see", "what is this",
          "analyze this", "scan this", "identify this",
          "take a photo", "take a picture", "capture this",
          "what's this", "what's that", "what is that",
          "turn on this", "turn off this", "turn on that", "turn off that",
          "this tv", "that tv", "this ac", "that ac",
          "i'm looking at", "right in front of me",
        ];
        if (visionTriggers.some((t) => lower.includes(t))) {
          console.log("[Relay] Vision trigger detected, requesting photo from glasses");
          broadcast(getGlassesClients(), {
            type: "CAPTURE_REQUEST",
            text: message.text,
            metadata: { reason: "vision-trigger" },
          });
        }
      }
      break;

    case "CAMERA_PHOTO":
      if (client.type === "unknown") {
        client.type = "glasses";
        console.log("Client identified as glasses");
      }
      broadcast(getVesperClients(), message);
      break;

    case "AI_RESPONSE":
    case "STATUS_UPDATE":
      if (client.type === "unknown") {
        client.type = "vesper";
        console.log("Client identified as vesper");
      }
      broadcast(getGlassesClients(), message);
      break;

    case "CAPTURE_REQUEST":
      if (client.type === "unknown") {
        client.type = "vesper";
        console.log("Client identified as vesper (via CAPTURE_REQUEST)");
      }
      console.log("[Relay] Capture request from V3SP3R — forwarding to glasses");
      broadcast(getGlassesClients(), message);
      break;

    case "CONFIG":
      if (message.metadata) {
        if ("sailor_mouth" in message.metadata) {
          sailorMouthEnabled = message.metadata.sailor_mouth === "true";
          console.log(`[Config] Sailor mouth: ${sailorMouthEnabled}`);
        }
        if ("muted" in message.metadata) {
          glassesMuted = message.metadata.muted === "true";
          console.log(`[Config] Glasses muted: ${glassesMuted}`);
        }
      }
      break;
  }
}

export function checkVisionTrigger(session: any, text: string) {
  const visionTriggers = [
    "take a photo", "take a picture", "capture this", "screenshot",
    "snap a pic", "take a snap", "get a photo", "photograph",
    "what am i looking at", "what do you see", "what is this",
    "analyze this", "scan this", "identify this", "read this",
    "what's this", "what is that", "what's that",
    "turn on this", "turn off this", "turn on that", "turn off that",
    "control this", "control that",
    "this tv", "that tv", "this ac", "that ac", "this device", "that device",
    "the one i'm looking at", "right in front of me", "i'm looking at",
  ];
  const lower = text.toLowerCase();
  if (visionTriggers.some((t) => lower.includes(t))) {
    captureAndAnalyze(session, text);
  }
}

export async function captureAndAnalyze(session: any, prompt: string) {
  try {
    try {
      await session.layouts.showTextWall("Capturing...", { durationMs: 2000 });
    } catch { /* ignore */ }

    if (!session.camera) {
      console.error("[MentraOS] session.camera is missing entirely");
      try {
        await session.layouts.showTextWall("Camera not available", { durationMs: 3000 });
      } catch { /* ignore */ }
      return;
    }

    const captureMethod = session.camera.requestPhoto
      ?? session.camera.capture
      ?? session.camera.takePhoto
      ?? session.camera.snap;

    if (typeof captureMethod !== "function") {
      console.error("[MentraOS] No known capture method found on session.camera");
      try {
        await session.layouts.showTextWall("Camera API unsupported", { durationMs: 3000 });
      } catch { /* ignore */ }
      return;
    }

    const photo = await captureMethod.call(session.camera, {
      metadata: { reason: "vesper-vision" },
    });

    if (!photo) {
      console.error("[MentraOS] Photo request returned null");
      return;
    }

    let rawData = photo.photoData ?? photo.data ?? photo.buffer ?? photo.image ?? photo.photo;

    if (!rawData && (photo.url || photo.photoUrl)) {
      const photoUrl = photo.url || photo.photoUrl;
      try {
        const resp = await fetch(photoUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        rawData = Buffer.from(await resp.arrayBuffer());
      } catch (e) {
        console.error("[MentraOS] Failed to fetch photo from URL:", (e as Error).message);
        return;
      }
    }

    if (!rawData) {
      console.error("[MentraOS] Photo object has no recognizable data field.");
      return;
    }

    const imageBase64 = Buffer.from(rawData).toString("base64");

    broadcast(getVesperClients(), {
      type: "CAMERA_PHOTO",
      text: prompt,
      imageBase64,
      imageMimeType: photo.mimeType || "image/jpeg",
      metadata: { source: "mentra" },
    });

    try {
      await session.layouts.showTextWall("Analyzing...", { durationMs: 3000 });
    } catch { /* ignore */ }
  } catch (e) {
    const errMsg = (e as Error).message;
    console.error("[MentraOS] Vision capture failed:", errMsg);
    try {
      await session.layouts.showTextWall(`Camera error: ${errMsg.slice(0, 40)}`, { durationMs: 3000 });
    } catch { /* ignore */ }
  }
}

export async function speakWithEchoGuard(session: any, text: string) {
  ttsSpeaking = true;
  lastSpokenText = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  try {
    await session.audio.speak(text, {
      language: "en-GB",
      voice: "en-GB-Wavenet-F",
    });
  } finally {
    ttsSpeaking = false;
    ttsEchoSuppressionUntil = Date.now() + TTS_ECHO_COOLDOWN_MS;
  }
}

export function isLikelyTtsEcho(transcription: string): boolean {
  if (!lastSpokenText) return false;
  const normalized = transcription.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (lastSpokenText.includes(normalized) || normalized.includes(lastSpokenText)) {
    return true;
  }
  const spokenWords = new Set(lastSpokenText.split(/\s+/));
  const transWords = normalized.split(/\s+/);
  if (transWords.length === 0) return false;
  const overlap = transWords.filter(w => spokenWords.has(w)).length;
  return overlap / transWords.length > 0.6;
}

export async function handleMentraResponse(session: any, message: GlassesMessage) {
  try {
    switch (message.type) {
      case "AI_RESPONSE":
        if (message.text) {
          try { await session.audio.stop(); } catch { /* no-op */ }
          await speakWithEchoGuard(session, message.text);
        }
        if (message.displayText) {
          await session.layouts.showReferenceCard({
            title: "V3SP3R",
            text: message.displayText,
          });
        }
        break;

      case "STATUS_UPDATE":
        if (message.text) {
          await session.layouts.showTextWall(message.text, {
            durationMs: 5000,
          });
          if (message.text.length <= 50) {
            try { await session.audio.stop(); } catch { /* no-op */ }
            await speakWithEchoGuard(session, message.text);
          }
        }
        break;

      case "CAPTURE_REQUEST":
        console.log("[MentraOS] Received CAPTURE_REQUEST from V3SP3R agent");
        captureAndAnalyze(session, message.text || "What am I looking at?");
        break;
    }
  } catch (e) {
    console.warn("[MentraOS] Response delivery failed:", (e as Error).message);
  }
}

async function waitForSessionReady(
  session: any,
  sessionId: string,
  maxWaitMs = 5000,
  intervalMs = 250
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      await session.layouts.showTextWall("", { durationMs: 1 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export async function startMentraIntegration() {
  const apiKey = process.env.MENTRA_API_KEY;
  if (!apiKey) {
    console.log("MentraOS: No MENTRA_API_KEY set — running in standalone relay mode.");
    return;
  }

  try {
    const { AppServer } = await import("@mentra/sdk");
    const packageName = process.env.MENTRA_PACKAGE_NAME || "com.vesper.glasses";
    const mentraPort = parseInt(process.env.MENTRA_PORT || "3000", 10);

    class VesperGlassesBridge extends AppServer {
      protected async onSession(session: any, sessionId: string, userId: string) {
        await waitForSessionReady(session, sessionId);
        try {
          await session.layouts.showTextWall("V3SP3R Connected", { durationMs: 3000 });
        } catch { /* ignore */ }

        let awaitingCommand = false;
        let awaitingTimer: ReturnType<typeof setTimeout> | null = null;
        const WAKE_TIMEOUT_MS = 15_000;

        function resetAwaitingState() {
          awaitingCommand = false;
          if (awaitingTimer) {
            clearTimeout(awaitingTimer);
            awaitingTimer = null;
          }
        }

        session.events.onTranscription(
          async (data: { text: string; isFinal: boolean; transcribeLanguage?: string }) => {
            if (!data.isFinal || !data.text.trim()) return;
            if (glassesMuted) return;

            if (ttsSpeaking || Date.now() < ttsEchoSuppressionUntil) return;
            if (isLikelyTtsEcho(data.text.trim())) return;

            const rawText = data.text.trim();

            const wakePatterns = [
              /^hey\s+vesper[\s,.:!]*(.*)$/i,
              /^vesper[\s,.:!]*(.*)$/i,
            ];

            let command: string | null = null;
            let isWakeTriggered = false;

            for (const pattern of wakePatterns) {
              const match = rawText.match(pattern);
              if (match) {
                isWakeTriggered = true;
                command = match[1]?.trim() || null;
                break;
              }
            }

            if (isWakeTriggered) {
              const hasCommand = !!(command && command.length > 0);
              try { await session.audio.stop(); } catch { /* no-op */ }
              speakWithEchoGuard(session, getWakeGreeting(hasCommand)).catch(() => {});

              if (hasCommand) {
                lastTaskTimestamp = Date.now();
                resetAwaitingState();

                broadcast(getVesperClients(), {
                  type: "VOICE_COMMAND",
                  text: command!,
                  metadata: {
                    source: "mentra",
                    sessionId,
                    language: data.transcribeLanguage || "en",
                    wake_word: "true",
                  },
                });

                checkVisionTrigger(session, command!);
              } else {
                resetAwaitingState();
                awaitingCommand = true;
                awaitingTimer = setTimeout(() => {
                  awaitingCommand = false;
                  awaitingTimer = null;
                }, WAKE_TIMEOUT_MS);

                broadcast(getVesperClients(), {
                  type: "STATUS_UPDATE",
                  text: "Vesper listening...",
                  metadata: { source: "mentra", wake_word: "true" },
                });
              }
              return;
            }

            if (awaitingCommand) {
              lastTaskTimestamp = Date.now();
              resetAwaitingState();

              broadcast(getVesperClients(), {
                type: "VOICE_COMMAND",
                text: rawText,
                metadata: {
                  source: "mentra",
                  sessionId,
                  language: data.transcribeLanguage || "en",
                  wake_word: "true",
                },
              });

              checkVisionTrigger(session, rawText);
              return;
            }

            broadcast(getVesperClients(), {
              type: "VOICE_TRANSCRIPTION",
              text: rawText,
              isFinal: true,
              metadata: {
                source: "mentra",
                sessionId,
                language: data.transcribeLanguage || "en",
              },
            });
          }
        );

        const virtualWs = {
          readyState: WebSocket.OPEN,
          send: (payload: string) => {
            try {
              const message: GlassesMessage = JSON.parse(payload);
              handleMentraResponse(session, message);
            } catch { /* ignore */ }
          },
        } as unknown as WebSocket;

        clients.set(virtualWs, {
          ws: virtualWs,
          type: "glasses",
          connectedAt: Date.now(),
        });

        session.addCleanupHandler?.(() => {
          clients.delete(virtualWs);
        });
      }
    }

    const app = new VesperGlassesBridge({ packageName, apiKey, port: mentraPort });
    await app.start();
  } catch (e) {
    console.warn("[MentraOS] SDK not available — running in standalone relay mode.");
  }
}

// Server Lifecycle Management
export let wss: WebSocketServer | null = null;
export let httpServer: HttpServer | null = null;

export function startServers() {
  const PORT = parseInt(process.env.PORT || "8089", 10);
  wss = new WebSocketServer({ port: PORT });
  console.log(`V3SP3R Glasses Bridge running on port ${PORT}`);

  const HEARTBEAT_INTERVAL_MS = 25_000;

  const heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      const sock = ws as WebSocket & { isAlive?: boolean };
      if (sock.isAlive === false) {
        clients.delete(ws);
        return ws.terminate();
      }
      sock.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(heartbeatTimer));

  wss.on("connection", (ws, req) => {
    const clientId = req.headers["x-vesper-client"] as string | undefined;
    const clientType = clientId === "v3sp3r-android" ? "vesper" : "unknown";

    const client: ConnectedClient = {
      ws,
      type: clientType as "glasses" | "vesper" | "unknown",
      connectedAt: Date.now(),
    };
    clients.set(ws, client);
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;

    ws.on("message", (data) => {
      try {
        const message: GlassesMessage = JSON.parse(data.toString());
        handleMessage(ws, message);
      } catch (e) {
        console.warn("Invalid message:", (e as Error).message);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });

    ws.send(
      JSON.stringify({
        type: "STATUS_UPDATE",
        text: "Connected to V3SP3R Glasses Bridge",
        metadata: {
          glasses_connected: getGlassesClients().length.toString(),
          vesper_connected: getVesperClients().length.toString(),
        },
      } satisfies GlassesMessage)
    );
  });

  const HTTP_PORT = parseInt(process.env.HTTP_PORT || "8088", 10);
  httpServer = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          glasses: getGlassesClients().length,
          vesper: getVesperClients().length,
          mentra: !!process.env.MENTRA_API_KEY,
          uptime: process.uptime(),
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(HTTP_PORT);

  startMentraIntegration();
}

// Only start servers automatically if NOT running in test environment
if (process.env.NODE_ENV !== "test") {
  startServers();
}
