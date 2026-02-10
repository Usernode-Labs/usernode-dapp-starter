/**
 * LLM wrapper — supports multiple providers via OpenAI-compatible APIs.
 *
 * Supported chat providers:
 *   openai    — OpenAI (ChatGPT)                    https://api.openai.com/v1
 *   anthropic — Anthropic (Claude)                   https://api.anthropic.com/v1
 *   gemini    — Google (Gemini)                      https://generativelanguage.googleapis.com/v1beta/openai
 *   grok      — xAI (Grok)                           https://api.x.ai/v1
 *
 * Image generation:
 *   openai    — DALL-E 3 (OpenAI images API)
 *   grok      — grok-2-image (OpenAI-compat images API)
 *   gemini    — Imagen 3 (native Google REST API, returns base64)
 *   anthropic — Claude refines the prompt, then delegates to IMAGE_PROVIDER
 *
 * Research agent:
 *   Before voting or suggesting options, the LLM drives a multi-step research
 *   loop. It can issue search queries, read specific URLs, and iterate until it
 *   feels informed. Requires searchTools (from search.js).
 *
 * Returns: { chat, chooseVote, suggestOption, generateImage, research, canGenerateImages }
 */

const OpenAI = require("openai");
const { formatSearchResults } = require("./search");

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

const PROVIDERS = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    chatModel: "gpt-4o",
    imageModel: "dall-e-3",
    supportsImages: true,
    imageBackend: "openai-compat",
  },
  anthropic: {
    baseURL: "https://api.anthropic.com/v1",
    chatModel: "claude-sonnet-4-20250514",
    imageModel: "dall-e-3",
    supportsImages: true,
    imageBackend: "anthropic-refine",
  },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatModel: "gemini-2.0-flash",
    imageModel: "imagen-3.0-generate-002",
    supportsImages: true,
    imageBackend: "gemini-native",
  },
  grok: {
    baseURL: "https://api.x.ai/v1",
    chatModel: "grok-3-mini",
    imageModel: "grok-2-image",
    supportsImages: true,
    imageBackend: "openai-compat",
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createLLM({
  // Chat config
  provider = "openai",
  apiKey,
  baseURL,
  chatModel,
  // Image config
  imageProvider,
  imageApiKey,
  imageBaseURL,
  imageModel,
  imageStoreURL,
  // Research — { search, fetchPage } from createSearchTools()
  searchTools = null,
  maxResearchSteps = 6,
} = {}) {
  if (!apiKey) throw new Error("LLM_API_KEY is required");

  // ---- Chat client -------------------------------------------------------
  const chatPreset = PROVIDERS[provider] || PROVIDERS.openai;
  const resolvedChatBaseURL = baseURL || chatPreset.baseURL;
  const resolvedChatModel = chatModel || chatPreset.chatModel;
  const chatClient = new OpenAI({ apiKey, baseURL: resolvedChatBaseURL, timeout: 60000 });

  // ---- Image config -------------------------------------------------------
  const imgProvider = imageProvider || provider;
  const imgPreset = PROVIDERS[imgProvider] || PROVIDERS.openai;
  const imgApiKey = imageApiKey || apiKey;
  const imgBaseURL = imageBaseURL || imgPreset.baseURL;
  const imgModel = imageModel || imgPreset.imageModel;
  const imgBackend = imgPreset.imageBackend || "openai-compat";
  const canGenerateImages = imgPreset.supportsImages && !!imgModel;

  let renderProvider = null;
  let renderClient = null;
  let renderModel = null;
  if (imgBackend === "anthropic-refine") {
    renderProvider = imageProvider && imageProvider !== "anthropic" ? imageProvider : "openai";
    const renderPreset = PROVIDERS[renderProvider] || PROVIDERS.openai;
    const renderKey = imageApiKey || apiKey;
    const renderURL = imageBaseURL || renderPreset.baseURL;
    renderModel = imageModel || renderPreset.imageModel || "dall-e-3";
    renderClient = new OpenAI({ apiKey: renderKey, baseURL: renderURL });
  }

  let imgClient = null;
  if (imgBackend === "openai-compat" && canGenerateImages) {
    if (imgProvider === provider && imgApiKey === apiKey) {
      imgClient = chatClient;
    } else {
      imgClient = new OpenAI({ apiKey: imgApiKey, baseURL: imgBaseURL });
    }
  }

  const canSearch = !!searchTools;

  console.log(`  Chat:     ${provider} / ${resolvedChatModel} (${resolvedChatBaseURL})`);
  if (canGenerateImages) {
    if (imgBackend === "anthropic-refine") {
      console.log(`  Images:   Claude-refined → ${renderProvider}/${renderModel}`);
    } else if (imgBackend === "gemini-native") {
      console.log(`  Images:   gemini / ${imgModel} (native Imagen API)`);
    } else {
      const same = imgProvider === provider;
      console.log(`  Images:   ${imgProvider} / ${imgModel}${same ? "" : " (separate)"}`);
    }
  } else {
    console.log(`  Images:   disabled`);
  }
  console.log(`  Research: ${canSearch ? `enabled (up to ${maxResearchSteps} steps)` : "disabled (no SEARCH_API_KEY)"}`);

  // ------------------------------------------------------------------
  // Date/time context — injected into all prompts
  // ------------------------------------------------------------------

  function dateContext() {
    const now = new Date();
    const date = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const time = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return `Current date and time: ${date}, ${time}.`;
  }

  // ------------------------------------------------------------------
  // Low-level chat helper (multi-turn)
  // ------------------------------------------------------------------

  async function chat(systemPrompt, userPrompt, { temperature = 0.7 } = {}) {
    const resp = await chatClient.chat.completions.create({
      model: resolvedChatModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature,
    });
    return (resp.choices[0].message.content || "").trim();
  }

  async function chatMultiTurn(messages, { temperature = 0.7 } = {}) {
    const resp = await chatClient.chat.completions.create({
      model: resolvedChatModel,
      messages,
      temperature,
    });
    return (resp.choices[0].message.content || "").trim();
  }

  // ------------------------------------------------------------------
  // Research agent — multi-step search + browse loop
  // ------------------------------------------------------------------
  // The LLM drives the loop by issuing JSON commands:
  //   { "action": "search", "query": "..." }
  //   { "action": "read",   "url": "..." }
  //   { "action": "done",   "summary": "..." }
  //
  // The agent runs for up to maxResearchSteps, then auto-summarizes.

  const RESEARCH_SYSTEM = [
    "You are a research agent. Browse the web to gather information about a topic.",
    "",
    "IMPORTANT: Each reply must be EXACTLY one raw JSON object. No markdown, no explanation, no code fences.",
    "",
    "Available commands:",
    '{"action":"search","query":"your search query"}',
    '{"action":"read","url":"https://example.com/page"}',
    '{"action":"done","summary":"Your findings summarized here"}',
    "",
    "Workflow:",
    '1. Start with a search: {"action":"search","query":"..."}',
    "2. Read 1-3 promising pages from the results.",
    "3. Do follow-up searches if needed.",
    '4. When ready, finish: {"action":"done","summary":"..."}',
    "",
    "Keep summaries factual and concise (under 300 words). If the topic is obvious, go straight to done.",
  ].join("\n");

  /** Try to extract a JSON command from an LLM response (handles code fences, leading text, etc.) */
  function _parseJsonCommand(text) {
    if (!text) return null;
    // Strip markdown code fences: ```json ... ``` or ```...```
    let cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    try {
      // Try the whole thing first (common case: LLM replies with just JSON).
      const full = JSON.parse(cleaned);
      if (full && full.action) return full;
    } catch (_) { /* fall through */ }
    try {
      // Try to find a JSON object anywhere in the text.
      const match = cleaned.match(/\{[^{}]*"action"\s*:\s*"[^"]+"/);
      if (match) {
        // Find the full object starting at that position.
        const start = cleaned.indexOf(match[0]);
        // Walk forward to find balanced braces.
        let depth = 0;
        for (let i = start; i < cleaned.length; i++) {
          if (cleaned[i] === "{") depth++;
          if (cleaned[i] === "}") depth--;
          if (depth === 0) {
            return JSON.parse(cleaned.slice(start, i + 1));
          }
        }
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  async function research(topic) {
    if (!canSearch) return "";

    console.log(`  🔬 Starting research: "${topic.slice(0, 60)}…"`);

    const messages = [
      { role: "system", content: RESEARCH_SYSTEM + "\n\n" + dateContext() },
      { role: "user", content: `Research this topic thoroughly:\n\n${topic}` },
    ];

    for (let step = 0; step < maxResearchSteps; step++) {
      const label = `  🔬 Step ${step + 1}/${maxResearchSteps}`;
      console.log(`${label}: thinking…`);
      const t0 = Date.now();
      let response = await chatMultiTurn(messages, { temperature: 0.3 });
      console.log(`${label}: LLM responded (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      messages.push({ role: "assistant", content: response });

      // Parse JSON — handle markdown fences, leading text, etc.
      let cmd = _parseJsonCommand(response);

      // If parsing failed, give the LLM one nudge to fix its format.
      if (!cmd && step === 0) {
        console.log(`${label}: bad format, nudging… (response was: "${response.slice(0, 100)}…")`);
        messages.push({
          role: "user",
          content: 'Please reply with ONLY a raw JSON object. Example: {"action":"search","query":"your query here"}',
        });
        response = await chatMultiTurn(messages, { temperature: 0.2 });
        messages.push({ role: "assistant", content: response });
        cmd = _parseJsonCommand(response);
      }

      if (!cmd || !cmd.action) {
        console.log(`${label}: no valid command — using response as summary`);
        return response.slice(0, 1500);
      }

      if (cmd.action === "done") {
        console.log(`${label}: ✅ Done — summary ready (${(cmd.summary || "").length} chars)`);
        return String(cmd.summary || response).slice(0, 1500);
      }

      if (cmd.action === "search") {
        console.log(`${label}: 🔍 Search → "${cmd.query}"`);
        const results = await searchTools.search(cmd.query || topic);
        const formatted = formatSearchResults(results);
        messages.push({
          role: "user",
          content: `Search results for "${cmd.query}":\n\n${formatted}\n\nRespond with your next JSON command.`,
        });
      } else if (cmd.action === "read") {
        console.log(`${label}: 📄 Read → ${(cmd.url || "").slice(0, 60)}…`);
        const content = await searchTools.fetchPage(cmd.url || "");
        messages.push({
          role: "user",
          content: `Page content from ${cmd.url}:\n\n${content}\n\nRespond with your next JSON command.`,
        });
      } else {
        console.log(`${label}: Unknown action "${cmd.action}" — ending.`);
        break;
      }
    }

    // If we hit the step limit, ask for a summary.
    messages.push({
      role: "user",
      content: "You've reached the research step limit. Please respond with a DONE action and your summary now.",
    });
    const finalResp = await chatMultiTurn(messages, { temperature: 0.3 });
    try {
      const jsonMatch = finalResp.match(/\{[\s\S]*\}/);
      const cmd = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      if (cmd && cmd.summary) return String(cmd.summary).slice(0, 1500);
    } catch (_) { /* fall through */ }
    return finalResp.slice(0, 1500);
  }

  // ------------------------------------------------------------------
  // chooseVote — research, then pick the best option
  // ------------------------------------------------------------------

  async function chooseVote(survey, options, counts) {
    const optionList = options
      .map((o) => {
        const c = counts[o.key] || 0;
        return `- "${o.label}" (key: ${o.key}, current votes: ${c})`;
      })
      .join("\n");

    // Agentic research phase.
    const researchSummary = await research(
      `Survey: "${survey.title}"\n` +
      `Question: "${survey.question}"\n` +
      `Options: ${options.map((o) => o.label).join(", ")}\n\n` +
      `Research these options to decide which is the best answer. ` +
      `Look for current information, comparisons, and expert opinions.`
    );

    const researchBlock = researchSummary
      ? `\n\nYour research findings:\n${researchSummary}\n`
      : "";

    const system = [
      dateContext(),
      "You are a thoughtful, independent-minded participant in a survey.",
      "Pick the option you genuinely believe is the best answer to the question.",
      "Do not just follow the crowd — vote for what you think is right.",
      "Use your research findings to make an informed decision.",
      "Reply with ONLY the option key (the exact string), nothing else.",
    ].join(" ");

    const user = [
      `Survey: "${survey.title}"`,
      `Question: "${survey.question}"`,
      ``,
      `Options:`,
      optionList,
      researchBlock,
      `Reply with the key of the option you vote for.`,
    ].join("\n");

    const response = await chat(system, user, { temperature: 0.5 });
    const key = response.trim().replace(/['"`]/g, "");

    if (options.find((o) => o.key === key)) return key;

    const lower = key.toLowerCase();
    const byLabel = options.find(
      (o) => o.label.toLowerCase() === lower || o.key.toLowerCase() === lower
    );
    if (byLabel) return byLabel.key;

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
  // suggestOption — research, then propose a new option
  // ------------------------------------------------------------------

  async function suggestOption(survey, existingOptions) {
    const optionList = existingOptions
      .map((o) => `- "${o.label}"`)
      .join("\n");

    // Agentic research phase.
    const researchSummary = await research(
      `Survey: "${survey.title}"\n` +
      `Question: "${survey.question}"\n` +
      `Existing options: ${existingOptions.map((o) => o.label).join(", ") || "(none)"}\n\n` +
      `Research this topic to come up with a great new option that isn't already listed. ` +
      `Look for current trends, overlooked answers, and strong candidates. ` +
      `If you find a relevant article or source, note its URL.`
    );

    const researchBlock = researchSummary
      ? `\n\nYour research findings:\n${researchSummary}\n`
      : "";

    const system = [
      dateContext(),
      "You are a creative participant in a survey.",
      "Suggest ONE new option that is not already covered by the existing options.",
      "The option should be reasonable and add value.",
      "Use your research to suggest something well-informed and current.",
      "",
      "You can include a URL in your option label to link to a relevant source,",
      "article, or reference. Just append it to the label text, e.g.:",
      '  "Label text https://example.com/article"',
      "The URL will be rendered as a clickable link. Only include a URL if it",
      "adds genuine value (a source, reference, or relevant page). Don't force it.",
      "",
      "Set wantsImage to true ONLY if the survey question explicitly asks for",
      "an image, meme, drawing, visual, logo, or artwork.",
      "For regular text-based surveys (opinions, preferences, rankings, etc.),",
      "ALWAYS set wantsImage to false.",
      "",
      "Reply ONLY with a JSON object in this exact format:",
      '{"label": "Your option text https://optional-source-url.com", "wantsImage": true, "imageDescription": "A brief description for image generation"}',
      "If no image is needed, set wantsImage to false and imageDescription to an empty string.",
    ].join("\n");

    const user = [
      `Survey: "${survey.title}"`,
      `Question: "${survey.question}"`,
      ``,
      `Existing options:`,
      optionList || "(none yet)",
      researchBlock,
      `Suggest a new option.`,
    ].join("\n");

    const response = await chat(system, user);

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          label: String(parsed.label || "").trim().slice(0, 200),
          wantsImage: canGenerateImages && !!parsed.wantsImage,
          imageDescription: String(parsed.imageDescription || "").trim(),
        };
      }
    } catch (_) {
      // Fall through to fallback
    }

    return {
      label: response.slice(0, 200),
      wantsImage: false,
      imageDescription: "",
    };
  }

  // ------------------------------------------------------------------
  // generateImage — route to the appropriate backend
  // ------------------------------------------------------------------

  async function generateImage(description) {
    if (!canGenerateImages) {
      console.log(`🎨 Image generation not available — skipping.`);
      return null;
    }
    try {
      if (imgBackend === "gemini-native") {
        return await _generateImageGemini(description);
      }
      if (imgBackend === "anthropic-refine") {
        return await _generateImageClaudeRefine(description);
      }
      return await _generateImageOpenAICompat(description);
    } catch (e) {
      console.error(`Image generation failed: ${e.message}`);
      return null;
    }
  }

  async function _generateImageOpenAICompat(description, client, model) {
    const c = client || imgClient;
    const m = model || imgModel;
    if (!c) return null;
    const resp = await c.images.generate({
      model: m,
      prompt: description,
      n: 1,
      size: "1024x1024",
    });
    const url = resp.data[0]?.url || null;
    if (url) console.log(`🎨 Generated (${imgProvider}/${m}): ${url.slice(0, 80)}…`);
    return url;
  }

  async function _generateImageGemini(description) {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${imgModel}:predict`;

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": imgApiKey,
      },
      body: JSON.stringify({
        instances: [{ prompt: description }],
        parameters: { sampleCount: 1, aspectRatio: "1:1" },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Imagen API ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) {
      console.warn("⚠️  Imagen returned no image data.");
      return null;
    }

    const storeURL = imageStoreURL;
    if (!storeURL) {
      console.warn("⚠️  IMAGE_STORE_URL not set — can't host Imagen output.");
      return null;
    }

    const buf = Buffer.from(b64, "base64");
    const uploadResp = await fetch(`${storeURL}/upload`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: buf,
    });
    if (!uploadResp.ok) {
      throw new Error(`Image store upload failed: ${uploadResp.status}`);
    }
    const { url } = await uploadResp.json();
    console.log(`🎨 Generated (gemini/${imgModel}) → ${url}`);
    return url;
  }

  async function _generateImageClaudeRefine(description) {
    const refinedPrompt = await chat(
      [
        "You are Claude, an AI with a distinctive aesthetic sensibility.",
        "Your task: take the image description below and reimagine it as a",
        "detailed, evocative image generation prompt in YOUR OWN creative voice.",
        "Add artistic details, mood, composition, and style choices that reflect",
        "your unique perspective. The result should feel distinctly Claude-like —",
        "thoughtful, nuanced, and aesthetically refined.",
        "",
        "Reply with ONLY the refined prompt text, nothing else. Keep it under 200 words.",
      ].join("\n"),
      `Original description: "${description}"`,
      { temperature: 0.9 }
    );

    console.log(`🎨 Claude refined: "${refinedPrompt.slice(0, 80)}…"`);

    if (!renderClient) {
      console.warn("⚠️  No render provider configured for anthropic-refine.");
      return null;
    }
    return await _generateImageOpenAICompat(refinedPrompt, renderClient, renderModel);
  }

  return { chat, chooseVote, suggestOption, generateImage, research, canGenerateImages };
}

module.exports = { createLLM, PROVIDERS };
