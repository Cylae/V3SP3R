import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { WebSocket } from "ws";
import {
  getWakeGreeting,
  isLikelyTtsEcho,
  handleMessage,
  clients,
  resetSessionContext,
  setSailorMouth,
  setGlassesMuted,
  setLastSpokenText,
  GlassesMessage,
  ConnectedClient,
} from "./index.js";
import { MentraAdapter, GenericGlassesAdapter } from "./glasses-adapter.js";

describe("Mentra Bridge Unit Tests", () => {
  beforeEach(() => {
    resetSessionContext();
  });

  describe("Wake Greeting Logic", () => {
    it("returns a greeting on first wake without command", () => {
      const greeting = getWakeGreeting(false);
      assert.strictEqual(typeof greeting, "string");
      assert.ok(greeting.length > 0);
    });

    it("returns a command greeting when command is present", () => {
      const greeting = getWakeGreeting(true);
      assert.strictEqual(typeof greeting, "string");
      assert.ok(greeting.length > 0);
    });

    it("uses sailor mouth greetings when sailor mouth is enabled", () => {
      setSailorMouth(true);
      const greeting = getWakeGreeting(false);
      assert.strictEqual(typeof greeting, "string");
      assert.ok(greeting.length > 0);
    });
  });

  describe("TTS Echo Suppression", () => {
    it("detects exact and substring speech echoes", () => {
      setLastSpokenText("Scanning Sub-GHz signal at 433 megahertz");

      assert.strictEqual(isLikelyTtsEcho("Scanning Sub GHz signal"), true);
      assert.strictEqual(isLikelyTtsEcho("433 megahertz"), true);
      assert.strictEqual(isLikelyTtsEcho("Turn on the TV"), false);
    });

    it("handles empty last spoken text gracefully", () => {
      setLastSpokenText("");
      assert.strictEqual(isLikelyTtsEcho("hello world"), false);
    });
  });

  describe("Message Handling and Routing", () => {
    it("identifies unknown client as glasses on VOICE_TRANSCRIPTION", () => {
      const dummyWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
      clients.set(dummyWs, { ws: dummyWs, type: "unknown", connectedAt: Date.now() });

      const msg: GlassesMessage = {
        type: "VOICE_TRANSCRIPTION",
        text: "hello vesper",
        isFinal: true,
      };

      handleMessage(dummyWs, msg);

      const client = clients.get(dummyWs);
      assert.strictEqual(client?.type, "glasses");
    });

    it("identifies unknown client as vesper on AI_RESPONSE", () => {
      const dummyWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
      clients.set(dummyWs, { ws: dummyWs, type: "unknown", connectedAt: Date.now() });

      const msg: GlassesMessage = {
        type: "AI_RESPONSE",
        text: "Command executed",
      };

      handleMessage(dummyWs, msg);

      const client = clients.get(dummyWs);
      assert.strictEqual(client?.type, "vesper");
    });

    it("suppresses voice messages when glasses are muted", () => {
      setGlassesMuted(true);

      const vesperWs = { readyState: WebSocket.OPEN, send: (data: string) => { received.push(data); } } as unknown as WebSocket;
      const glassesWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;

      const received: string[] = [];

      clients.set(vesperWs, { ws: vesperWs, type: "vesper", connectedAt: Date.now() });
      clients.set(glassesWs, { ws: glassesWs, type: "glasses", connectedAt: Date.now() });

      const msg: GlassesMessage = {
        type: "VOICE_TRANSCRIPTION",
        text: "hello",
        isFinal: true,
      };

      handleMessage(glassesWs, msg);
      assert.strictEqual(received.length, 0);
    });

    it("handles CONFIG messages to update settings", () => {
      const dummyWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
      clients.set(dummyWs, { ws: dummyWs, type: "vesper", connectedAt: Date.now() });

      const configMsg: GlassesMessage = {
        type: "CONFIG",
        metadata: {
          sailor_mouth: "true",
          muted: "true",
        },
      };

      handleMessage(dummyWs, configMsg);
    });
  });

  describe("Adapters", () => {
    it("instantiates MentraAdapter and GenericGlassesAdapter", () => {
      const mentraAdapter = new MentraAdapter("ws://localhost:8089");
      assert.strictEqual(mentraAdapter.name, "MentraOS");

      const genericAdapter = new GenericGlassesAdapter("ws://localhost:8089");
      assert.strictEqual(genericAdapter.name, "Generic");
    });
  });
});
