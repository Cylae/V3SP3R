import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { WebSocket } from "ws";
import {
  isLikelyTtsEcho,
  getWakeGreeting,
  resetStateForTesting,
  setSailorMouthEnabled,
  getSailorMouthEnabled,
  setGlassesMuted,
  getGlassesMuted,
  setLastSpokenText,
  broadcast,
  getVesperClients,
  getGlassesClients,
  handleMessage,
  clients,
  GlassesMessage,
  ConnectedClient,
} from "./index";

function createMockWebSocket(): WebSocket {
  const sentMessages: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sentMessages.push(data);
    },
    sentMessages,
  } as unknown as WebSocket & { sentMessages: string[] };
  return ws;
}

describe("Mentra Bridge - Index Core Logic", () => {
  beforeEach(() => {
    resetStateForTesting();
  });

  describe("TTS Echo Detection (isLikelyTtsEcho)", () => {
    it("returns false when no text has been spoken yet", () => {
      assert.strictEqual(isLikelyTtsEcho("hello world"), false);
    });

    it("detects exact and substring spoken text matches above length threshold", () => {
      setLastSpokenText("Scanning SubGHz signals for garage doors");
      assert.strictEqual(isLikelyTtsEcho("scanning subghz signals"), true);
      assert.strictEqual(isLikelyTtsEcho("garage doors"), true);
      assert.strictEqual(isLikelyTtsEcho("completely unrelated phrase"), false);
    });

    it("handles short words correctly without false positive substring matches", () => {
      setLastSpokenText("ok");
      assert.strictEqual(isLikelyTtsEcho("ok"), true);
      assert.strictEqual(isLikelyTtsEcho("looking at the apple tree"), false);
    });

    it("detects echo based on word overlap (>60%)", () => {
      setLastSpokenText("The battery level is ninety five percent");
      assert.strictEqual(
        isLikelyTtsEcho("battery level ninety five percent"),
        true
      );
      assert.strictEqual(isLikelyTtsEcho("battery status unknown"), false);
    });
  });

  describe("Wake Greeting Logic (getWakeGreeting)", () => {
    it("returns standard first-time greeting when sailor mouth is disabled", () => {
      setSailorMouthEnabled(false);
      const greeting = getWakeGreeting(false);
      assert.ok(typeof greeting === "string" && greeting.length > 0);
    });

    it("returns sailor mouth greeting when enabled", () => {
      setSailorMouthEnabled(true);
      assert.strictEqual(getSailorMouthEnabled(), true);
      const greeting = getWakeGreeting(false);
      assert.ok(typeof greeting === "string" && greeting.length > 0);
    });

    it("returns command-oriented greeting when command is present", () => {
      setSailorMouthEnabled(false);
      const greeting = getWakeGreeting(true);
      assert.ok(
        ["on it", "got it", "roger that", "working on it", "let me check"].includes(
          greeting
        )
      );
    });
  });

  describe("Client Tracking & Broadcasting", () => {
    it("correctly filters Vesper vs Glasses clients", () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const ws3 = createMockWebSocket();

      clients.set(ws1, { ws: ws1, type: "vesper", connectedAt: Date.now() });
      clients.set(ws2, { ws: ws2, type: "glasses", connectedAt: Date.now() });
      clients.set(ws3, { ws: ws3, type: "unknown", connectedAt: Date.now() });

      assert.strictEqual(getVesperClients().length, 1);
      assert.strictEqual(getVesperClients()[0], ws1);

      assert.strictEqual(getGlassesClients().length, 1);
      assert.strictEqual(getGlassesClients()[0], ws2);
    });

    it("broadcasts messages to active open WebSockets", () => {
      const ws1 = createMockWebSocket() as WebSocket & { sentMessages: string[] };
      const ws2 = { readyState: WebSocket.CLOSED, send: () => {} } as unknown as WebSocket;

      const msg: GlassesMessage = {
        type: "STATUS_UPDATE",
        text: "Test status update",
      };

      broadcast([ws1, ws2], msg);

      assert.strictEqual(ws1.sentMessages.length, 1);
      assert.strictEqual(
        JSON.parse(ws1.sentMessages[0]).text,
        "Test status update"
      );
    });
  });

  describe("Message Handling & Routing (handleMessage)", () => {
    it("safely ignores null or non-object messages", () => {
      const ws = createMockWebSocket();
      clients.set(ws, { ws, type: "glasses", connectedAt: Date.now() });

      // Should not throw
      handleMessage(ws, null as any);
      handleMessage(ws, "string" as any);
      handleMessage(ws, 123 as any);
    });

    it("identifies unknown sender as glasses on voice input and relays to Vesper", () => {
      const glassesWs = createMockWebSocket();
      const vesperWs = createMockWebSocket() as WebSocket & { sentMessages: string[] };

      clients.set(glassesWs, {
        ws: glassesWs,
        type: "unknown",
        connectedAt: Date.now(),
      });
      clients.set(vesperWs, {
        ws: vesperWs,
        type: "vesper",
        connectedAt: Date.now(),
      });

      handleMessage(glassesWs, {
        type: "VOICE_COMMAND",
        text: "Check battery status",
      });

      assert.strictEqual(clients.get(glassesWs)?.type, "glasses");
      assert.strictEqual(vesperWs.sentMessages.length, 1);
      const relayed = JSON.parse(vesperWs.sentMessages[0]);
      assert.strictEqual(relayed.text, "Check battery status");
    });

    it("suppresses voice input when muted", () => {
      setGlassesMuted(true);
      assert.strictEqual(getGlassesMuted(), true);

      const glassesWs = createMockWebSocket();
      const vesperWs = createMockWebSocket() as WebSocket & { sentMessages: string[] };

      clients.set(glassesWs, { ws: glassesWs, type: "glasses", connectedAt: Date.now() });
      clients.set(vesperWs, { ws: vesperWs, type: "vesper", connectedAt: Date.now() });

      handleMessage(glassesWs, {
        type: "VOICE_COMMAND",
        text: "Hello",
      });

      assert.strictEqual(vesperWs.sentMessages.length, 0);
    });

    it("triggers a photo capture request when vision triggers are detected in relay mode", () => {
      const glassesWs = createMockWebSocket() as WebSocket & { sentMessages: string[] };
      const vesperWs = createMockWebSocket();

      clients.set(glassesWs, { ws: glassesWs, type: "glasses", connectedAt: Date.now() });
      clients.set(vesperWs, { ws: vesperWs, type: "vesper", connectedAt: Date.now() });

      handleMessage(glassesWs, {
        type: "VOICE_COMMAND",
        text: "What am I looking at right now?",
      });

      // Glasses should receive a CAPTURE_REQUEST message
      assert.strictEqual(glassesWs.sentMessages.length, 1);
      const captureReq = JSON.parse(glassesWs.sentMessages[0]);
      assert.strictEqual(captureReq.type, "CAPTURE_REQUEST");
      assert.strictEqual(captureReq.metadata?.reason, "vision-trigger");
    });

    it("handles CONFIG messages to toggle sailor mouth and muted state", () => {
      const vesperWs = createMockWebSocket();
      clients.set(vesperWs, { ws: vesperWs, type: "vesper", connectedAt: Date.now() });

      handleMessage(vesperWs, {
        type: "CONFIG",
        metadata: {
          sailor_mouth: "true",
          muted: "true",
        },
      });

      assert.strictEqual(getSailorMouthEnabled(), true);
      assert.strictEqual(getGlassesMuted(), true);
    });
  });
});
