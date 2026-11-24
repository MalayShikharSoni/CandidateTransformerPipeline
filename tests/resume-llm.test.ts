import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createClaudeExtractor, RESUME_MODEL, SYSTEM_PROMPT } from "../src/adapters/resume-llm.js";

const OUTPUT = { headline: null, skills: ["Go"], experience: [], education: [] };

/** A client whose beta.messages.parse returns (or throws) what the test says. */
function stubClient(respond: (params: Record<string, unknown>) => unknown) {
  const seen: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          seen.push(params);
          return respond(params);
        },
      },
    },
  } as unknown as Anthropic;
  return { client, seen };
}

describe("createClaudeExtractor", () => {
  it("sends the resume as data with the fixed prompt, schema, low effort and refusal fallback", async () => {
    const { client, seen } = stubClient(() => ({
      stop_reason: "end_turn",
      model: RESUME_MODEL,
      parsed_output: OUTPUT,
    }));

    const outcome = await createClaudeExtractor(client).extract("Go developer");

    expect(outcome).toEqual({ ok: true, model: RESUME_MODEL, output: OUTPUT });
    expect(seen[0]).toMatchObject({
      model: RESUME_MODEL,
      system: SYSTEM_PROMPT,
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "<resume>\nGo developer\n</resume>" }],
    });
  });

  it("records the model that actually answered when a fallback ran", async () => {
    const { client } = stubClient(() => ({
      stop_reason: "end_turn",
      model: "claude-opus-4-8",
      parsed_output: OUTPUT,
    }));
    expect(await createClaudeExtractor(client).extract("x")).toMatchObject({ model: "claude-opus-4-8" });
  });

  it.each([
    [{ stop_reason: "refusal", parsed_output: null }, "the model declined to read this resume (refusal)."],
    [{ stop_reason: "max_tokens", parsed_output: null }, "the model's answer was cut off (max_tokens)."],
    [{ stop_reason: "end_turn", parsed_output: null }, "the model's answer did not match the expected schema."],
  ])("turns %j into a warning", async (response, reason) => {
    const { client } = stubClient(() => ({ model: RESUME_MODEL, ...response }));
    expect(await createClaudeExtractor(client).extract("x")).toEqual({ ok: false, reason });
  });

  it.each([
    [Anthropic.APIError.generate(401, undefined, "bad key", new Headers()), "Anthropic rejected the API key (HTTP 401). Check ANTHROPIC_API_KEY in .env."],
    [Anthropic.APIError.generate(429, undefined, "slow down", new Headers()), "Anthropic rate limit reached (HTTP 429). Try again later."],
    [new Anthropic.APIConnectionError({ message: "offline" }), "Network error calling the Anthropic API: offline"],
    [Anthropic.APIError.generate(529, undefined, "overloaded", new Headers()), "Anthropic API error (HTTP 529): 529 overloaded"],
    [new Error("boom"), "LLM extraction failed: boom"],
  ])("turns a thrown %s into a warning instead of failing the run", async (error, reason) => {
    const { client } = stubClient(() => {
      throw error;
    });
    expect(await createClaudeExtractor(client).extract("x")).toEqual({ ok: false, reason });
  });
});
