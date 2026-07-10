import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";

/** OpenAI-shaped chat completions mock with plausible usage numbers. */
export function createMockUpstream() {
  const app = new Hono();

  app.post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json()) as { model?: string; messages?: unknown };
    const promptTokens = Math.ceil(JSON.stringify(body.messages ?? "").length / 4);
    return c.json({
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "x402 gateway online" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 6,
        total_tokens: promptTokens + 6,
      },
    });
  });

  return app;
}

export function startMockUpstream(port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: createMockUpstream().fetch, port }, () => resolve(server));
  });
}
