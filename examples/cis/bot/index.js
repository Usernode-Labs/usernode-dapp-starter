#!/usr/bin/env node
require("dotenv").config();

/**
 * CIS Bot — an AI participant that votes on surveys, adds options, and
 * optionally generates images.
 *
 * Environment variables:
 *   NODE_URL          — Base URL of the Usernode server (default http://localhost:8000)
 *   CIS_APP_PUBKEY    — The CIS app's public key (default ut1_cis_demo_pubkey)
 *   BOT_ADDRESS       — This bot's public-key / address
 *   BOT_NAME          — Display name base for the bot (e.g. "chatgpt_bot")
 *   LLM_API_KEY       — OpenAI API key (required)
 *   LLM_CHAT_MODEL    — Chat model (default gpt-4o)
 *   LLM_IMAGE_MODEL   — Image model (default dall-e-3)
 *   POLL_INTERVAL_S   — Seconds between poll cycles (default 60)
 *   VOTE_RECONSIDER_S — Seconds between vote reconsiderations (default 3600)
 *   ENABLE_IMAGES     — Set to "false" to skip image generation (default true)
 */

const {
  fetchTransactions,
  sendTransaction,
  rebuildSurveys,
  computeResults,
  slugify,
  usernameSuffix,
  sleep,
} = require("./cis-client");

const { createLLM } = require("./llm");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NODE_URL = process.env.NODE_URL || "http://localhost:8000";
const CIS_APP_PUBKEY = process.env.CIS_APP_PUBKEY || "ut1_cis_demo_pubkey";
const BOT_ADDRESS = process.env.BOT_ADDRESS || "ut1_bot_chatgpt_default";
const BOT_NAME = process.env.BOT_NAME || "chatgpt_bot";
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_CHAT_MODEL = process.env.LLM_CHAT_MODEL || "gpt-4o";
const LLM_IMAGE_MODEL = process.env.LLM_IMAGE_MODEL || "dall-e-3";
const POLL_INTERVAL_S = Number(process.env.POLL_INTERVAL_S) || 10;
const VOTE_RECONSIDER_S = Number(process.env.VOTE_RECONSIDER_S) || 3600;
const ENABLE_IMAGES = process.env.ENABLE_IMAGES !== "false";
const IMAGE_STORE_URL = process.env.IMAGE_STORE_URL || "http://localhost:8001";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Track when we last considered voting on each survey (in-memory, lost on restart).
const lastVoteConsideredAt = new Map(); // surveyId -> timestamp ms

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemo(obj) {
  return JSON.stringify(obj);
}

async function rehostImage(temporaryUrl) {
  // Download the image from the temporary URL (e.g., DALL-E CDN).
  const downloadResp = await fetch(temporaryUrl);
  if (!downloadResp.ok) {
    throw new Error(`Failed to download image: ${downloadResp.status}`);
  }
  const contentType = downloadResp.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await downloadResp.arrayBuffer());

  // Upload to our permanent image store.
  const uploadResp = await fetch(`${IMAGE_STORE_URL}/upload`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: buf,
  });
  if (!uploadResp.ok) {
    throw new Error(`Failed to upload to image store: ${uploadResp.status}`);
  }
  const { url } = await uploadResp.json();
  log(`  🖼️  Re-hosted image → ${url}`);
  return url;
}

function botUsername() {
  const suffix = usernameSuffix(BOT_ADDRESS);
  const base = BOT_NAME.replace(/_[A-Za-z0-9]{6}$/, "").slice(
    0,
    Math.max(1, 24 - suffix.length)
  );
  return (base || "bot") + suffix;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function ensureUsername(txs) {
  // Check if we've already set our username.
  const target = botUsername();
  for (const rawTx of txs) {
    const tx =
      rawTx && typeof rawTx === "object"
        ? rawTx
        : null;
    if (!tx) continue;
    const from = tx.from_pubkey || tx.from || tx.source || null;
    if (String(from) !== BOT_ADDRESS) continue;
    const memo =
      tx.memo != null
        ? (() => {
            try {
              return JSON.parse(String(tx.memo));
            } catch (_) {
              return null;
            }
          })()
        : null;
    if (
      memo &&
      (memo.app === "cis" || memo.app === "exocortex") &&
      memo.type === "set_username" &&
      memo.username === target
    ) {
      return; // Already set
    }
  }

  log(`Setting username to "${target}"…`);
  const memo = makeMemo({
    app: "cis",
    type: "set_username",
    username: target,
  });
  await sendTransaction(NODE_URL, BOT_ADDRESS, CIS_APP_PUBKEY, memo);
  log(`✅ Username set.`);
}

async function considerVoting(llm, survey, results) {
  const { options, counts, botEntry } = results;
  if (options.length === 0) return;

  const now = Date.now();
  const lastConsidered = lastVoteConsideredAt.get(survey.id) || 0;
  const alreadyVoted = botEntry && botEntry.voteKey;

  // Skip if we've already voted and it hasn't been long enough to reconsider.
  if (alreadyVoted && now - lastConsidered < VOTE_RECONSIDER_S * 1000) return;

  log(
    `🗳️  Considering vote on "${survey.title}"` +
      (alreadyVoted ? ` (reconsidering, current: ${botEntry.voteKey})` : "")
  );

  const chosenKey = await llm.chooseVote(survey, options, counts);
  lastVoteConsideredAt.set(survey.id, now);

  if (!chosenKey) {
    log(`  ⚠️  LLM returned no valid choice — skipping.`);
    return;
  }

  // Skip sending if we already voted for this option.
  if (alreadyVoted && botEntry.voteKey === chosenKey) {
    log(`  ↩️  Sticking with current vote: ${chosenKey}`);
    return;
  }

  const chosenLabel =
    options.find((o) => o.key === chosenKey)?.label || chosenKey;
  log(`  → Voting for: "${chosenLabel}" (${chosenKey})`);

  const memo = makeMemo({
    app: "cis",
    type: "vote",
    survey: survey.id,
    choice: chosenKey,
  });
  await sendTransaction(NODE_URL, BOT_ADDRESS, CIS_APP_PUBKEY, memo);
  log(`  ✅ Vote submitted.`);
}

async function considerAddingOption(llm, survey, results) {
  const { options, botAddedOption } = results;

  // Only add one option per survey.
  if (botAddedOption) return;

  log(`💡 Suggesting new option for "${survey.title}"…`);

  const suggestion = await llm.suggestOption(survey, options);
  if (!suggestion || !suggestion.label) {
    log(`  ⚠️  LLM returned empty suggestion — skipping.`);
    return;
  }

  let label = suggestion.label;

  // Generate image if the LLM thinks it's appropriate, then re-host permanently.
  if (ENABLE_IMAGES && suggestion.wantsImage && suggestion.imageDescription) {
    log(`  🎨 Generating image: "${suggestion.imageDescription.slice(0, 60)}…"`);
    const tempUrl = await llm.generateImage(suggestion.imageDescription);
    if (tempUrl) {
      try {
        const permanentUrl = await rehostImage(tempUrl);
        label = `${label} ${permanentUrl}`;
      } catch (e) {
        log(`  ⚠️  Re-host failed (${e.message}), using temporary URL`);
        label = `${label} ${tempUrl}`;
      }
    }
  }

  const optionKey = slugify(suggestion.label) || `opt_${Date.now().toString(36)}`;
  log(`  → Adding option: "${label.slice(0, 60)}…" (${optionKey})`);

  const memo = makeMemo({
    app: "cis",
    type: "add_option",
    survey: survey.id,
    option: { key: optionKey, label },
  });
  await sendTransaction(NODE_URL, BOT_ADDRESS, CIS_APP_PUBKEY, memo);
  log(`  ✅ Option added.`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runOnce(llm) {
  const txs = await fetchTransactions(NODE_URL, CIS_APP_PUBKEY, 400);
  const surveys = rebuildSurveys(txs, CIS_APP_PUBKEY);
  const activeSurveys = surveys.filter((s) => !s.archived);

  log(
    `📊 ${activeSurveys.length} active survey(s), ${surveys.length - activeSurveys.length} archived`
  );

  // Ensure our username is set.
  await ensureUsername(txs);

  for (const survey of activeSurveys) {
    let results = computeResults(txs, CIS_APP_PUBKEY, survey, BOT_ADDRESS);

    // Add an option first so the bot can consider voting for it.
    try {
      const hadOption = !!results.botAddedOption;
      await considerAddingOption(llm, survey, results);
      if (!hadOption) {
        // Re-fetch transactions and recompute so the new option is voteable.
        txs = await fetchTransactions(NODE_URL, CIS_APP_PUBKEY, 400);
        results = computeResults(txs, CIS_APP_PUBKEY, survey, BOT_ADDRESS);
      }
    } catch (e) {
      log(`  ❌ Add-option error on "${survey.title}": ${e.message}`);
    }

    try {
      await considerVoting(llm, survey, results);
    } catch (e) {
      log(`  ❌ Vote error on "${survey.title}": ${e.message}`);
    }
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  CIS Bot");
  console.log(`  Address:  ${BOT_ADDRESS}`);
  console.log(`  Name:     ${botUsername()}`);
  console.log(`  Node:     ${NODE_URL}`);
  console.log(`  App key:  ${CIS_APP_PUBKEY}`);
  console.log(`  Model:    ${LLM_CHAT_MODEL}`);
  console.log(`  Images:   ${ENABLE_IMAGES ? "enabled (" + LLM_IMAGE_MODEL + ")" : "disabled"}`);
  console.log(`  Img store:${ENABLE_IMAGES ? " " + IMAGE_STORE_URL : " (disabled)"}`);
  console.log(`  Poll:     every ${POLL_INTERVAL_S}s`);
  console.log(`  Reconsider votes: every ${VOTE_RECONSIDER_S}s`);
  console.log("═══════════════════════════════════════════════");

  if (!LLM_API_KEY) {
    console.error("❌ LLM_API_KEY is required. Set it in .env or as an environment variable.");
    process.exit(1);
  }

  const llm = createLLM({
    apiKey: LLM_API_KEY,
    chatModel: LLM_CHAT_MODEL,
    imageModel: LLM_IMAGE_MODEL,
  });

  // Run immediately, then on interval.
  while (true) {
    try {
      await runOnce(llm);
    } catch (e) {
      log(`❌ Loop error: ${e.message}${e.cause ? " (" + e.cause.message + ")" : ""}`);
    }
    await sleep(POLL_INTERVAL_S * 1000);
  }
}

main();
