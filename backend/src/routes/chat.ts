import { FastifyInstance } from "fastify";
import { verifyAuth } from "../middleware/auth";
import { normalizeRuleAsset } from "../lib/ruleAsset";
import Groq from "groq-sdk";

export default async function chatRoutes(server: FastifyInstance) {
  server.addHook("onRequest", verifyAuth);

  server.post("/", async (request, reply) => {
    const { message } = request.body as { message: string };

    if (!process.env.GROQ_API_KEY) {
      return reply.status(500).send({ error: "GROQ_API_KEY is not configured on the server." });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const systemPrompt = `You are a financial automation assistant for a Stellar wallet.
The user will describe a rule they want to create. Extract the intent and return
a JSON object representing the rule.

Return ONLY valid JSON, no markdown formatting.

Format:
{
  "trigger": "A short phrase describing when the rule runs (e.g. 'on every payment received')",
  "action": "save | invest | buffer",
  "amount": number (the value to move),
  "isPercentage": boolean (true if amount is a %),
  "asset": "XLM | USDC",
  "description": "A short summary of what this rule does",
  "memo": "A short memo for the stellar transaction (max 28 chars)"
}

Asset rules — these matter, the engine routes real funds on them:
- Two assets are supported: XLM (the native asset) and USDC (the stable asset).
- Set "asset" to USDC only when the user clearly means USDC (they say "USDC",
  "dollars", "stablecoin", or "stable"). Otherwise set it to "XLM".
- The "trigger" MUST name the asset it applies to, because the engine matches
  incoming payments against the trigger text:
    * USDC rule  → "on every USDC payment received"
    * XLM rule   → "on every XLM payment received"
    * Either     → "on every payment received"   (omit the asset name)
- Use the asset-agnostic form only when the user genuinely wants the rule to
  fire on any incoming asset.
- Never name one asset in "trigger" while setting "asset" to the other.

Examples:
"save 10% of every payment"        → trigger "on every payment received",      asset "XLM"
"save 20 USDC from my salary"      → trigger "on every USDC payment received", asset "USDC"
"invest 5% of incoming XLM"        → trigger "on every XLM payment received",  asset "XLM"
"put 50 dollars aside each month"  → trigger "monthly",                        asset "USDC"`;

    try {
      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        max_tokens: 256,
        response_format: { type: "json_object" },
      });

      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) throw new Error("No response from AI");
      
      const parsed = JSON.parse(responseText);

      // The model can emit an asset that contradicts its own trigger text.
      // Reconcile them here so the matcher and the executor agree.
      const { asset, trigger, corrected } = normalizeRuleAsset(parsed);
      if (corrected) {
        console.warn(
          `[Chat] Reconciled rule asset → ${asset} (trigger: "${trigger}", model said "${parsed.asset}")`,
        );
      }

      return reply.send({ rule: { ...parsed, asset, trigger } });
    } catch (err: any) {
      console.error("AI Error:", err);
      return reply.status(500).send({ error: "Failed to parse rule intent via AI." });
    }
  });
}
