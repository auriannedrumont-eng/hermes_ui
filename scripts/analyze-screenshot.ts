// Analyse visuelle de capture d'écran via le VLM
import ZAI from "z-ai-web-dev-sdk";
import { readFileSync } from "node:fs";

const [file, question] = [process.argv[2], process.argv[3] ?? "Décris cette interface."];

async function main() {
  const zai = await ZAI.create();
  const b64 = readFileSync(file).toString("base64");
  const res: any = await zai.chat.completions.createVision({
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          { type: "text", text: question },
        ],
      },
    ],
    thinking: { type: "disabled" },
  });
  console.log(res.choices?.[0]?.message?.content ?? "(réponse vide)");
}

main().catch((e) => console.error("VLM_FAILED", e?.message || e));
