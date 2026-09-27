import { FastifyInstance } from "fastify";
import { verifyAuth } from "../middleware/auth";
import { getDb } from "../lib/db";
import { buildAiContext, buildRuleContext, computeActivityStats } from "../lib/insights";
import Groq from "groq-sdk";

/**
 * Load the aggregates the model needs to give personalised advice.
 *
 * Failures are non-fatal: if the query errors the route still answers, just
 * without personalisation, rather than breaking rule creation.
 */
async function loadUserContext(userId: string): Promise<{ activity: string; rules: string }> {
  try {
    const sql = getDb();
    const [txRows, ruleRows] = await Promise.all([
      sql`
        SELECT amount, type, "createdAt"
        FROM   "AutomatedTransaction"
        WHERE  "userId" = ${userId}::uuid
          AND  "createdAt" > NOW() - INTERVAL '90 days'
        ORDER  BY "createdAt" DESC
        LIMIT  500
      `,
      sql`
        SELECT trigger, action, amount, "isPercentage", status
        FROM   "Rule"
        WHERE  "userId" = ${userId}::uuid
        ORDER  BY "createdAt" DESC
        LIMIT  50
      `,
    ]);

    return {
      activity: buildAiContext(computeActivityStats(txRows as any[])),
      rules: buildRuleContext(ruleRows as any[]),
    };
  } catch (err) {
    console.error("Failed to load user context for chat:", err);
    return {
      activity: "Transaction history is unavailable for this request.",
      rules: "Rule configuration is unavailable for this request.",
    };
  }
}

export default async function chatRoutes(server: FastifyInstance) {
  server.addHook("onRequest", verifyAuth);

  server.post("/", async (request, reply) => {
    const { message } = request.body as { message: string };

    if (typeof message !== "string" || message.trim().length === 0) {
      return reply.status(400).send({ error: "A message is required." });
    }

    if (!process.env.GROQ_API_KEY) {
      return reply.status(500).send({ error: "GROQ_API_KEY is not configured on the server." });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const { activity, rules } = await loadUserContext(request.user!.id);

    // The model now decides between two shapes: a rule to create, or a piece of
    // coaching advice grounded in the figures below. Previously it could only
    // emit a rule, so any coaching question produced a nonsensical rule.
    const systemPrompt = `You are AutoPilot, a financial automation assistant for a Stellar wallet.

The user's real automation activity (aggregated from their transaction history):
${activity}

The user's configured rules:
${rules}

Decide which of two things the user is asking for.

1. They want to CREATE OR CHANGE an automation rule. Return:
{
  "kind": "rule",
  "trigger": "short phrase for when the rule runs (e.g. 'on every payment received')",
  "action": "save | invest | buffer",
  "amount": number,
  "isPercentage": boolean,
  "description": "short summary of what this rule does",
  "memo": "short stellar memo, max 28 chars"
}

2. They are asking for ADVICE, an explanation, or a question about their finances. Return:
{
  "kind": "advice",
  "message": "2-4 sentences of specific advice"
}

Rules for advice:
- Cite the user's actual figures above when they are relevant. Prefer "you automated 128.4 XLM this week" over "you have been saving".
- If the figures show no history, say so plainly and explain what would make their rules fire.
- Never invent numbers that do not appear above.
- Be concrete and brief. No markdown, no bullet lists, no preamble.

Return ONLY valid JSON, no markdown formatting.`;

    try {
      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        // Advice replies need more headroom than a bare rule object.
        max_tokens: 512,
        response_format: { type: "json_object" },
      });

      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) throw new Error("No response from AI");

      const parsed = JSON.parse(responseText);

      // Advice path: return prose for the client to render as a chat bubble.
      if (parsed?.kind === "advice" || (parsed?.message && !parsed?.action)) {
        const text = String(parsed.message ?? "").trim();
        if (!text) throw new Error("Empty advice response");
        return reply.send({ message: text });
      }

      // Rule path: strip the discriminator so the stored shape is unchanged
      // from before this route learned to give advice.
      const { kind, ...rule } = parsed;
      if (!rule?.action) throw new Error("AI response contained neither advice nor a rule");

      return reply.send({ rule });
    } catch (err: any) {
      console.error("AI Error:", err);
      return reply.status(500).send({ error: "Failed to parse rule intent via AI." });
    }
  });
}
