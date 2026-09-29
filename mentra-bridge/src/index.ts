import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage } from "http";

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

// ==================== Sailor Mouth & Voice State ====================

let sailorMouthEnabled = false;
let glassesMuted = false;

// ── TTS Echo Suppression ──────────────────────────────────────────
// When TTS is playing, the glasses mic picks up the audio and
// re-transcribes it as a user utterance, creating a feedback loop.
// We suppress transcriptions during TTS playback + a brief cooldown.
let ttsSpeaking = false;
let ttsEchoSuppressionUntil = 0;
const TTS_ECHO_COOLDOWN_MS = 2500; // Extra silence after TTS ends
let lastSpokenText = ""; // Track what was spoken to detect echoes

// Track session context so greetings feel natural
let wakeCount = 0;
let lastWakeTimestamp = 0;
let lastTaskTimestamp = 0; // when we last forwarded a VOICE_COMMAND

const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min = "been a while"

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
  // Mid-session, keep it short
  return pick(sailorMouthEnabled ? SAILOR_ACTIVE : GREETINGS_ACTIVE);
}

export function isLikelyTtsEcho(transcription: string): boolean {
  if (!lastSpokenText) return false;
  const normalized = transcription.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  if (!normalized) return false;

  // Substring checks require at least 5 characters to avoid false matches on short words
  if (normalized.length >= 5 && lastSpokenText.length >= 5) {
    if (lastSpokenText.includes(normalized) || normalized.includes(lastSpokenText)) {
      return true;
    }
  } else if (normalized === lastSpokenText) {
    return true;
  }

  // Check word overlap — if >60% of words match, it's an echo
  const spokenWords = new Set(lastSpokenText.split(/\s+/).filter(Boolean));
  const transWords = normalized.split(/\s+/).filter(Boolean);
  if (transWords.length === 0) return false;
  const overlap = transWords.filter((w) => spokenWords.has(w)).length;
  return overlap / transWords.length > 0.6;
}

// State Accessors for Testing
export function setSailorMouthEnabled(enabled: boolean) {
  sailorMouthEnabled = enabled;
}

export function getSailorMouthEnabled(): boolean {
  return sailorMouthEnabled;
}

export function setGlassesMuted(muted: boolean) {
  glassesMuted = muted;
}

export function getGlassesMuted(): boolean {
  return glassesMuted;
}

export function setLastSpokenText(text: string) {
  lastSpokenText = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

export function resetStateForTesting() {
  clients.clear();
  sailorMouthEnabled = false;
  glassesMuted = false;
  ttsSpeaking = false;
  ttsEchoSuppressionUntil = 0;
  lastSpokenText = "";
  wakeCount = 0;
  lastWakeTimestamp = 0;
  lastTaskTimestamp = 0;
}

// ==================== Message Handler ====================

export function handleMessage(sender: WebSocket, message: GlassesMessage) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    return;
  }

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

      // Relay mode vision trigger: ask glasses to capture a photo
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
      // V3SP3R Android app requesting a photo capture (agent request_photo action).
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

// ==================== Heartbeat ====================

const HEARTBEAT_INTERVAL_MS = 25_000;

function heartbeat(this: WebSocket & { isAlive?: boolean }) {
  this.isAlive = true;
}

export function setupClientConnection(ws: WebSocket, req: IncomingMessage) {
  const clientId = req.headers["x-vesper-client"] as string | undefined;
  const clientType = clientId === "v3sp3r-android" ? "vesper" : "unknown";

  const client: ConnectedClient = {
    ws,
    type: clientType as "glasses" | "vesper" | "unknown",
    connectedAt: Date.now(),
  };
  clients.set(ws, client);
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on("pong", heartbeat);

  console.log(
    `Client connected: ${client.type} (${clients.size} total) from ${req.socket.remoteAddress}`
  );

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message && typeof message === "object" && typeof message.type === "string") {
        handleMessage(ws, message as GlassesMessage);
      }
    } catch (e) {
      console.warn("Invalid message:", (e as Error).message);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} remaining)`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    clients.delete(ws);
  });

  if (ws.readyState === WebSocket.OPEN) {
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
  }
}

// ==================== MentraOS Native Integration ====================

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
  console.warn(
    `[MentraOS] Session ${sessionId} WebSocket not ready after ${maxWaitMs}ms — proceeding anyway`
  );
}

export async function startMentraIntegration() {
  const apiKey = process.env.MENTRA_API_KEY;
  if (!apiKey) {
    console.log(
      "MentraOS: No MENTRA_API_KEY set — running in standalone relay mode."
    );
    return;
  }

  try {
    const { AppServer } = await import("@mentra/sdk");

    const packageName =
      process.env.MENTRA_PACKAGE_NAME || "com.vesper.glasses";
    const mentraPort = parseInt(process.env.MENTRA_PORT || "3000", 10);

    class VesperGlassesBridge extends AppServer {
      protected async onSession(
        session: any,
        sessionId: string,
        userId: string
      ) {
        console.log(
          `[MentraOS] Session started: ${sessionId} (user: ${userId})`
        );

        await waitForSessionReady(session, sessionId);

        try {
          await session.layouts.showTextWall("V3SP3R Connected", {
            durationMs: 3000,
          });
        } catch (e) {
          console.warn(
            `[MentraOS] Welcome display failed (non-fatal): ${(e as Error).message}`
          );
        }

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
          async (data: {
            text: string;
            isFinal: boolean;
            transcribeLanguage?: string;
          }) => {
            if (!data.isFinal || !data.text.trim()) return;
            if (glassesMuted) return;

            if (ttsSpeaking || Date.now() < ttsEchoSuppressionUntil) {
              console.log(`[Echo] Suppressed during TTS: "${data.text.trim().slice(0, 40)}"`);
              return;
            }
            if (isLikelyTtsEcho(data.text.trim())) {
              console.log(`[Echo] Suppressed echo match: "${data.text.trim().slice(0, 40)}"`);
              return;
            }

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
                console.log(`[MentraOS] Wake + command: "${command}"`);
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
                console.log(`[MentraOS] Wake word detected — awaiting command`);
                resetAwaitingState();
                awaitingCommand = true;
                awaitingTimer = setTimeout(() => {
                  console.log(`[MentraOS] Wake word timed out`);
                  awaitingCommand = false;
                  awaitingTimer = null;
                  try {
                    session.layouts
                      .showTextWall("Vesper: timed out", { durationMs: 2000 })
                      .catch(() => {});
                  } catch {
                    // ignore
                  }
                }, WAKE_TIMEOUT_MS);

                try {
                  session.layouts
                    .showTextWall("Vesper: listening...", { durationMs: 3000 })
                    .catch(() => {});
                } catch {
                  // ignore
                }

                broadcast(getVesperClients(), {
                  type: "STATUS_UPDATE",
                  text: "Vesper listening...",
                  metadata: { source: "mentra", wake_word: "true" },
                });
              }
              return;
            }

            if (awaitingCommand) {
              console.log(`[MentraOS] Follow-up command: "${rawText}"`);
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

            console.log(`[MentraOS] Voice (passive): "${rawText}"`);
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
            } catch {
              // ignore
            }
          },
        } as unknown as WebSocket;

        clients.set(virtualWs, {
          ws: virtualWs,
          type: "glasses",
          connectedAt: Date.now(),
        });

        session.addCleanupHandler?.(() => {
          clients.delete(virtualWs);
          console.log(`[MentraOS] Session ended: ${sessionId}`);
        });
      }
    }

    const app = new VesperGlassesBridge({
      packageName,
      apiKey,
      port: mentraPort,
    });

    await app.start();
  } catch (e) {
    console.warn(
      "[MentraOS] SDK not available — running in standalone relay mode."
    );
  }
}

function checkVisionTrigger(session: any, text: string) {
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

async function captureAndAnalyze(session: any, prompt: string) {
  try {
    if (!session.camera) return;
    const captureMethod = session.camera.requestPhoto
      ?? session.camera.capture
      ?? session.camera.takePhoto
      ?? session.camera.snap;

    if (typeof captureMethod !== "function") return;

    const photo = await captureMethod.call(session.camera, {
      metadata: { reason: "vesper-vision" },
    });

    if (!photo) return;
    let rawData = photo.photoData ?? photo.data ?? photo.buffer ?? photo.image ?? photo.photo;
    if (!rawData) return;

    const imageBase64 = Buffer.from(rawData).toString("base64");
    broadcast(getVesperClients(), {
      type: "CAMERA_PHOTO",
      text: prompt,
      imageBase64,
      imageMimeType: photo.mimeType || "image/jpeg",
      metadata: { source: "mentra" },
    });
  } catch (e) {
    console.error("[MentraOS] Vision capture failed:", (e as Error).message);
  }
}

async function speakWithEchoGuard(session: any, text: string) {
  ttsSpeaking = true;
  lastSpokenText = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
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

async function handleMentraResponse(session: any, message: GlassesMessage) {
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
        captureAndAnalyze(session, message.text || "What am I looking at?");
        break;
    }
  } catch (e) {
    console.warn("[MentraOS] Response delivery failed:", (e as Error).message);
  }
}

// ==================== Server Lifecycle Control ====================

let activeWss: WebSocketServer | null = null;
let activeHttpServer: ReturnType<typeof createServer> | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

export function startServers(
  port = parseInt(process.env.PORT || "8089", 10),
  httpPort = parseInt(process.env.HTTP_PORT || "8088", 10)
): { wss: WebSocketServer | null; httpServer: ReturnType<typeof createServer> | null } {
  if (activeWss) return { wss: activeWss, httpServer: activeHttpServer };

  activeWss = new WebSocketServer({ port });
  console.log(`V3SP3R Glasses Bridge running on port ${port}`);

  heartbeatInterval = setInterval(() => {
    if (!activeWss) return;
    for (const ws of activeWss.clients) {
      const sock = ws as WebSocket & { isAlive?: boolean };
      if (sock.isAlive === false) {
        console.log("Terminating unresponsive client");
        clients.delete(ws);
        return ws.terminate();
      }
      sock.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  activeWss.on("close", () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });

  activeWss.on("connection", (ws, req) => {
    setupClientConnection(ws, req);
  });

  activeHttpServer = createServer((req, res) => {
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

  activeHttpServer.listen(httpPort, () => {
    console.log(`Health check on port ${httpPort}`);
  });

  startMentraIntegration();

  return { wss: activeWss, httpServer: activeHttpServer };
}

export function stopServers(): Promise<void> {
  return new Promise((resolve) => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    let pending = 2;
    const done = () => {
      pending--;
      if (pending <= 0) resolve();
    };

    if (activeWss) {
      activeWss.close(() => done());
      activeWss = null;
    } else {
      done();
    }

    if (activeHttpServer) {
      activeHttpServer.close(() => done());
      activeHttpServer = null;
    } else {
      done();
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  startServers();
}
