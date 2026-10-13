import { config } from "../config";
import { createLogger } from "../logger";
import { fetchWithTimeout, withRetry } from "../retry";

const log = createLogger("gemini");

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

/**
 * Thin Gemini REST client with a model fallback chain.
 *
 * When no API key is configured, or every model fails, callers fall back to a
 * deterministic heuristic (see pricing/heuristic.ts) so the autonomous loop
 * keeps running rather than crashing.
 */
export class GeminiClient {
  get configured(): boolean {
    return Boolean(config.gemini.apiKey);
  }

  private models(): string[] {
    return [config.gemini.primaryModel, ...config.gemini.fallbackModels];
  }

  /**
   * Verify the API key with a real, cheap call at boot, so a bad or expired key
   * is visible in the logs instead of silently degrading to heuristic pricing.
   */
  async ping(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${config.gemini.apiKey}`,
        { method: "GET" },
        config.gemini.timeoutMs,
      );
      if (!res.ok) {
        log.error("gemini key check failed", {
          status: res.status,
          body: (await res.text()).slice(0, 200),
        });
        return false;
      }
      return true;
    } catch (err) {
      log.error("gemini key check error", { error: (err as Error).message });
      return false;
    }
  }

  /**
   * Ask Gemini for a JSON response. Returns null when unavailable so callers
   * can degrade gracefully instead of throwing.
   */
  async generateJson<T>(prompt: string, schemaHint: string): Promise<T | null> {
    const text = await this.generateText(prompt, schemaHint);
    if (text === null) return null;
    return parseJsonLoose<T>(text);
  }

  async generateText(prompt: string, schemaHint = ""): Promise<string | null> {
    if (!this.configured) {
      log.debug("gemini not configured, skipping");
      return null;
    }

    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 1024,
        ...(schemaHint ? { responseMimeType: "application/json" } : {}),
      },
    });

    let lastError: unknown;
    for (const model of this.models()) {
      try {
        const res = await withRetry(
          () =>
            fetchWithTimeout(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.gemini.apiKey}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
              },
              config.gemini.timeoutMs,
            ),
          { retries: 1, baseDelayMs: 800, maxDelayMs: 4000 },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const json = (await res.json()) as GeminiResponse;
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        const text = parts
          .map((p) => p.text ?? "")
          .join("")
          .trim();
        if (text) return text;
        throw new Error("empty response");
      } catch (err) {
        lastError = err;
        log.warn("gemini model failed, trying next", {
          model,
          error: (err as Error).message,
        });
      }
    }
    log.error("all gemini models failed", { error: (lastError as Error)?.message });
    return null;
  }
}

/** Gemini occasionally wraps JSON in prose or fences; recover the object. */
export function parseJsonLoose<T>(text: string): T | null {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const gemini = new GeminiClient();
