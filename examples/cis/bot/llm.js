/**
 * LLM wrapper — currently supports OpenAI (ChatGPT / DALL-E).
 *
 * Returns an object with three methods:
 *   chooseVote(survey, options, counts)  → option key
 *   suggestOption(survey, options)       → { label, wantsImage, imageDescription }
 *   generateImage(description)           → url | null
 */

const OpenAI = require("openai");

function createLLM({
  apiKey,
  chatModel = "gpt-4o",
  imageModel = "dall-e-3",
} = {}) {
  if (!apiKey) throw new Error("LLM_API_KEY is required");
  const client = new OpenAI({ apiKey });

  // ------------------------------------------------------------------
  // Low-level chat helper
  // ------------------------------------------------------------------

  async function chat(systemPrompt, userPrompt, { temperature = 0.7 } = {}) {
    const resp = await client.chat.completions.create({
      model: chatModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature,
    });
    return (resp.choices[0].message.content || "").trim();
  }

  // ------------------------------------------------------------------
  // chooseVote — pick the best option for a survey
  // ------------------------------------------------------------------

  async function chooseVote(survey, options, counts) {
    const optionList = options
      .map((o) => {
        const c = counts[o.key] || 0;
        return `- "${o.label}" (key: ${o.key}, current votes: ${c})`;
      })
      .join("\n");

    const system = [
      "You are a thoughtful, independent-minded participant in a survey.",
      "Pick the option you genuinely believe is the best answer to the question.",
      "Do not just follow the crowd — vote for what you think is right.",
      "Reply with ONLY the option key (the exact string), nothing else.",
    ].join(" ");

    const user = [
      `Survey: "${survey.title}"`,
      `Question: "${survey.question}"`,
      ``,
      `Options:`,
      optionList,
      ``,
      `Reply with the key of the option you vote for.`,
    ].join("\n");

    const response = await chat(system, user, { temperature: 0.5 });
    const key = response.trim().replace(/['"`]/g, "");

    // Exact match
    if (options.find((o) => o.key === key)) return key;

    // Fuzzy: LLM may have returned the label or a close variant
    const lower = key.toLowerCase();
    const byLabel = options.find(
      (o) => o.label.toLowerCase() === lower || o.key.toLowerCase() === lower
    );
    if (byLabel) return byLabel.key;

    // Substring match as last resort
    const bySub = options.find(
      (o) =>
        lower.includes(o.key.toLowerCase()) ||
        lower.includes(o.label.toLowerCase())
    );
    if (bySub) return bySub.key;

    console.warn(`⚠️  LLM returned unrecognised key "${key}" — picking first option`);
    return options[0]?.key || null;
  }

  // ------------------------------------------------------------------
  // suggestOption — propose a new option for a survey
  // ------------------------------------------------------------------

  async function suggestOption(survey, existingOptions) {
    const optionList = existingOptions
      .map((o) => `- "${o.label}"`)
      .join("\n");

    const system = [
      "You are a creative participant in a survey.",
      "Suggest ONE new option that is not already covered by the existing options.",
      "The option should be reasonable and add value.",
      "",
      "Set wantsImage to true ONLY if the survey question explicitly asks for",
      "an image, meme, drawing, visual, logo, or artwork.",
      "For regular text-based surveys (opinions, preferences, rankings, etc.),",
      "ALWAYS set wantsImage to false.",
      "",
      "Reply ONLY with a JSON object in this exact format:",
      '{"label": "Your option text", "wantsImage": true, "imageDescription": "A brief description for image generation"}',
      "If no image is needed, set wantsImage to false and imageDescription to an empty string.",
    ].join("\n");

    const user = [
      `Survey: "${survey.title}"`,
      `Question: "${survey.question}"`,
      ``,
      `Existing options:`,
      optionList,
      ``,
      `Suggest a new option.`,
    ].join("\n");

    const response = await chat(system, user);

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          label: String(parsed.label || "").trim().slice(0, 80),
          wantsImage: !!parsed.wantsImage,
          imageDescription: String(parsed.imageDescription || "").trim(),
        };
      }
    } catch (_) {
      // Fall through to fallback
    }

    // Fallback: treat the whole response as a label
    return {
      label: response.slice(0, 80),
      wantsImage: false,
      imageDescription: "",
    };
  }

  // ------------------------------------------------------------------
  // generateImage — create an image via DALL-E
  // ------------------------------------------------------------------

  async function generateImage(description) {
    try {
      const resp = await client.images.generate({
        model: imageModel,
        prompt: description,
        n: 1,
        size: "1024x1024",
      });
      const url = resp.data[0]?.url || null;
      if (url) {
        console.log(`🎨 Generated image: ${url.slice(0, 80)}…`);
      }
      return url;
    } catch (e) {
      console.error(`Image generation failed: ${e.message}`);
      return null;
    }
  }

  return { chat, chooseVote, suggestOption, generateImage };
}

module.exports = { createLLM };
