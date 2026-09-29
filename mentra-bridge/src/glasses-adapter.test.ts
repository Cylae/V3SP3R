import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { MentraAdapter, GenericGlassesAdapter } from "./glasses-adapter";

describe("Glasses Adapter Suite", () => {
  describe("MentraAdapter", () => {
    let adapter: MentraAdapter;

    beforeEach(() => {
      adapter = new MentraAdapter("ws://localhost:8089");
    });

    it("has correct adapter name", () => {
      assert.strictEqual(adapter.name, "MentraOS");
    });

    it("initializes session and registers event listeners", () => {
      let transcriptionCallback: Function | null = null;
      let photoCallback: Function | null = null;
      let buttonCallback: Function | null = null;

      const mockSession = {
        events: {
          onTranscription: (cb: Function) => {
            transcriptionCallback = cb;
          },
          onPhotoTaken: (cb: Function) => {
            photoCallback = cb;
          },
          onButtonPress: (cb: Function) => {
            buttonCallback = cb;
          },
        },
      };

      adapter.initSession(mockSession);

      assert.ok(transcriptionCallback !== null);
      assert.ok(photoCallback !== null);
      assert.ok(buttonCallback !== null);
    });

    it("handles requestVisionAnalysis gracefully when camera API is missing", async () => {
      const mockSession = {};
      adapter.initSession(mockSession);

      // Should not throw exception
      await adapter.requestVisionAnalysis("Analyze this remote");
    });

    it("requests photo via camera API and formats image when available", async () => {
      let textWallShown = "";
      const sampleBuffer = Buffer.from("test image data").buffer;

      const mockSession = {
        camera: {
          requestPhoto: async () => ({
            photoData: sampleBuffer,
            mimeType: "image/jpeg",
          }),
        },
        layouts: {
          showTextWall: async (text: string) => {
            textWallShown = text;
          },
        },
      };

      adapter.initSession(mockSession);
      await adapter.requestVisionAnalysis("What is this?");

      assert.strictEqual(textWallShown, "Analyzing...");
    });

    it("routes AI_RESPONSE bridge messages to session audio and layout", () => {
      let spokenText = "";
      let cardText = "";

      const mockSession = {
        audio: {
          stop: async () => {},
          speak: async (text: string) => {
            spokenText = text;
          },
        },
        layouts: {
          showReferenceCard: async (opts: { title: string; text: string }) => {
            cardText = opts.text;
          },
        },
      };

      adapter.initSession(mockSession);

      adapter.onBridgeMessage({
        type: "AI_RESPONSE",
        text: "SubGHz transmit complete",
        displayText: "Sent 433.92MHz signal",
      });

      assert.strictEqual(spokenText, "SubGHz transmit complete");
      assert.strictEqual(cardText, "Sent 433.92MHz signal");
    });
  });

  describe("GenericGlassesAdapter", () => {
    it("has correct adapter name", () => {
      const genericAdapter = new GenericGlassesAdapter("ws://localhost:8089");
      assert.strictEqual(genericAdapter.name, "Generic");
    });
  });
});
