/**
 * CIS transaction client — reads and writes to the Usernode mock server (or
 * production node) and rebuilds survey state from on-chain transactions.
 *
 * This is a Node.js port of the browser-side logic in usernode_cis.html.
 */

const SURVEY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Helpers (ported from usernode_cis.html)
// ---------------------------------------------------------------------------

function parseMemo(m) {
  if (m == null) return null;
  try {
    return JSON.parse(String(m));
  } catch (_) {
    return null;
  }
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function last6(s) {
  const v = String(s || "");
  return v.length >= 6 ? v.slice(-6) : v;
}

function usernameSuffix(address) {
  const core = last6(address);
  return core ? `_${core}` : "_unknown";
}

function deriveDefaultUsername(address) {
  return `user${usernameSuffix(address)}`;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

function extractTxTimestampMs(tx) {
  if (!tx || typeof tx !== "object") return null;
  const candidates = [
    tx.created_at,
    tx.createdAt,
    tx.timestamp_ms,
    tx.timestampMs,
    tx.timestamp,
    tx.time,
  ];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v))
      return v < 10_000_000_000 ? v * 1000 : v;
    if (typeof v === "string" && v.trim()) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

function normalizeTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  const from = pick(tx, [
    "from_pubkey",
    "from",
    "source",
    "fromAddress",
    "from_address",
  ]);
  const to = pick(tx, [
    "destination_pubkey",
    "to",
    "destination",
    "toAddress",
    "to_address",
  ]);
  const memo = pick(tx, ["memo"]);
  const amount = pick(tx, ["amount"]);
  const ts = extractTxTimestampMs(tx) || Date.now();
  const id = pick(tx, ["id", "txid", "tx_id", "hash"]);
  return {
    id: id == null ? null : String(id),
    from: from == null ? null : String(from),
    to: to == null ? null : String(to),
    amount: amount == null ? null : amount,
    memo: memo == null ? null : String(memo),
    ts,
  };
}

function normalizeTransactionsResponse(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== "object") return [];
  if (Array.isArray(resp.items)) return resp.items;
  if (Array.isArray(resp.transactions)) return resp.transactions;
  if (resp.data && Array.isArray(resp.data.items)) return resp.data.items;
  return [];
}

// ---------------------------------------------------------------------------
// Survey definitions
// ---------------------------------------------------------------------------

const ALLOWED_SURVEY_DURATION_MS = new Set([
  60_000,
  2 * 24 * 3600_000,
  3 * 24 * 3600_000,
  4 * 24 * 3600_000,
  5 * 24 * 3600_000,
  6 * 24 * 3600_000,
  7 * 24 * 3600_000,
]);
const DEFAULT_SURVEY_DURATION_MS = 7 * 24 * 3600_000;

function normalizeSurveyDurationMs(v) {
  const n = typeof v === "number" ? Math.round(v) : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SURVEY_DURATION_MS;
  return ALLOWED_SURVEY_DURATION_MS.has(n) ? n : DEFAULT_SURVEY_DURATION_MS;
}

function normalizeSurveyDefinition(rawSurvey) {
  if (!rawSurvey || typeof rawSurvey !== "object") return null;
  const title = String(rawSurvey.title || "").trim();
  const question = String(rawSurvey.question || "").trim();
  const activeDurationMs = normalizeSurveyDurationMs(
    rawSurvey.active_duration_ms != null
      ? rawSurvey.active_duration_ms
      : rawSurvey.duration_ms
  );
  const optionsRaw = Array.isArray(rawSurvey.options)
    ? rawSurvey.options
    : [];
  const options = optionsRaw
    .map((o, i) => {
      if (!o || typeof o !== "object") return null;
      const label = String(o.label || "").trim();
      if (!label) return null;
      const key = String(o.key || slugify(label) || `opt_${i + 1}`);
      return { key, label };
    })
    .filter(Boolean);
  if (!title || !question) return null;
  const idBase = String(rawSurvey.id || slugify(title) || "").trim();
  if (!idBase) return null;
  return { id: idBase, title, question, activeDurationMs, options };
}

// ---------------------------------------------------------------------------
// Parse CIS transaction
// ---------------------------------------------------------------------------

function parseCisTx(rawTx, appPubkey) {
  const tx = normalizeTx(rawTx);
  if (!tx || !tx.from || !tx.to || tx.to !== appPubkey) return null;
  const memoObj = parseMemo(tx.memo);
  if (!memoObj) return null;
  const app = memoObj.app ? String(memoObj.app) : null;
  if (app !== "cis" && app !== "exocortex") return null;
  return { tx, memo: memoObj };
}

// ---------------------------------------------------------------------------
// Rebuild surveys from transactions
// ---------------------------------------------------------------------------

function rebuildSurveys(txs, appPubkey) {
  const allCreations = [];
  for (const rawTx of txs) {
    const parsed = parseCisTx(rawTx, appPubkey);
    if (!parsed || parsed.memo.type !== "create_survey") continue;
    const survey = normalizeSurveyDefinition(parsed.memo.survey);
    if (!survey) continue;
    allCreations.push({ survey, ts: parsed.tx.ts, from: parsed.tx.from });
  }

  allCreations.sort((a, b) => a.ts - b.ts);

  const lastAcceptedBySender = new Map();
  const latestCreated = new Map();
  for (const entry of allCreations) {
    const prev = lastAcceptedBySender.get(entry.from);
    if (prev != null && entry.ts - prev < SURVEY_COOLDOWN_MS) continue;
    lastAcceptedBySender.set(entry.from, entry.ts);
    const existing = latestCreated.get(entry.survey.id);
    if (!existing || entry.ts >= existing.ts) {
      latestCreated.set(entry.survey.id, {
        survey: entry.survey,
        ts: entry.ts,
      });
    }
  }

  const now = Date.now();
  return Array.from(latestCreated.values())
    .sort((a, b) => b.ts - a.ts)
    .map((x) => {
      const expiresAtMs = x.ts + x.survey.activeDurationMs;
      return {
        ...x.survey,
        createdAtMs: x.ts,
        expiresAtMs,
        archived: now >= expiresAtMs,
      };
    });
}

// ---------------------------------------------------------------------------
// Compute results for a single survey (votes + user-added options)
// ---------------------------------------------------------------------------

function computeResults(txs, appPubkey, survey, botAddress) {
  const optionsByKey = new Map();
  for (const opt of survey.options) {
    if (!opt || !opt.key) continue;
    optionsByKey.set(String(opt.key), { ...opt });
  }

  // Collect user-added options (oldest per sender wins)
  const oldestOptionBySender = new Map();
  for (const rawTx of txs) {
    const parsed = parseCisTx(rawTx, appPubkey);
    if (!parsed || parsed.memo.type !== "add_option") continue;
    const sv =
      parsed.memo.survey == null ? null : String(parsed.memo.survey);
    if (sv !== survey.id) continue;
    const optionObj =
      parsed.memo.option && typeof parsed.memo.option === "object"
        ? parsed.memo.option
        : null;
    const label =
      optionObj && optionObj.label != null
        ? String(optionObj.label).trim()
        : "";
    if (!label) continue;
    const rawKey =
      optionObj && optionObj.key != null
        ? String(optionObj.key).trim()
        : slugify(label);
    const { tx } = parsed;
    const key = rawKey || `opt_${last6(tx.from)}_${String(tx.ts)}`;
    const prev = oldestOptionBySender.get(tx.from);
    if (!prev || tx.ts < prev.ts) {
      oldestOptionBySender.set(tx.from, {
        key,
        label,
        ts: tx.ts,
        from: tx.from,
      });
    }
  }

  // Merge into options map
  const added = Array.from(oldestOptionBySender.values()).sort(
    (a, b) => a.ts - b.ts
  );
  for (const it of added) {
    let key = it.key;
    if (optionsByKey.has(key)) key = `${key}_${last6(it.from)}`;
    if (optionsByKey.has(key)) key = `${key}_${String(it.ts).slice(-4)}`;
    optionsByKey.set(key, {
      key,
      label: it.label,
      userAdded: true,
      addedBy: it.from,
    });
  }

  const allOptions = Array.from(optionsByKey.values());

  // Tally votes (latest per sender wins)
  const users = new Map();
  for (const rawTx of txs) {
    const parsed = parseCisTx(rawTx, appPubkey);
    if (!parsed) continue;
    const { tx, memo: memoObj } = parsed;

    const entry = users.get(tx.from) || {
      from: tx.from,
      username: deriveDefaultUsername(tx.from),
      usernameTs: 0,
      voteKey: null,
      voteTs: 0,
    };

    if (memoObj.type === "set_username") {
      if (tx.ts >= entry.usernameTs) {
        entry.username = memoObj.username
          ? String(memoObj.username)
          : entry.username;
        entry.usernameTs = tx.ts;
      }
      users.set(tx.from, entry);
      continue;
    }

    let voteKey = null;
    if (memoObj.type === "vote") {
      const sv =
        memoObj.survey == null ? null : String(memoObj.survey);
      const ch =
        memoObj.choice != null
          ? String(memoObj.choice)
          : memoObj.vote != null
            ? String(memoObj.vote)
            : null;
      if (!sv || sv === survey.id)
        voteKey = ch == null ? null : ch.trim();
    }

    if (voteKey && allOptions.some((o) => o.key === voteKey)) {
      if (tx.ts >= entry.voteTs) {
        entry.voteKey = voteKey;
        entry.voteTs = tx.ts;
      }
    }

    users.set(tx.from, entry);
  }

  const counts = {};
  for (const opt of allOptions) counts[opt.key] = 0;
  for (const u of users.values()) {
    if (!u.voteKey) continue;
    counts[u.voteKey] = (counts[u.voteKey] || 0) + 1;
  }

  const botEntry = botAddress ? users.get(botAddress) || null : null;
  const botAddedOption = botAddress
    ? oldestOptionBySender.get(botAddress) || null
    : null;

  return { options: allOptions, counts, botEntry, botAddedOption };
}

// ---------------------------------------------------------------------------
// HTTP helpers — talk to the mock server (or production node)
// ---------------------------------------------------------------------------

async function fetchTransactions(nodeUrl, appPubkey, limit = 400) {
  const resp = await fetch(`${nodeUrl}/__mock/getTransactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner_pubkey: appPubkey,
      filterOptions: { limit },
    }),
  });
  if (!resp.ok) throw new Error(`getTransactions failed: ${resp.status}`);
  const json = await resp.json();
  return normalizeTransactionsResponse(json);
}

async function sendTransaction(
  nodeUrl,
  fromPubkey,
  destPubkey,
  memo,
  { timeoutMs = 45_000, pollIntervalMs = 800 } = {}
) {
  const sendResp = await fetch(`${nodeUrl}/__mock/sendTransaction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from_pubkey: fromPubkey,
      destination_pubkey: destPubkey,
      amount: 1,
      memo,
    }),
  });
  if (!sendResp.ok)
    throw new Error(`sendTransaction failed: ${sendResp.status}`);
  const { tx } = await sendResp.json();
  const txId = tx && tx.id;

  // Poll until the tx appears in getTransactions (mock has a 5s delay).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const items = await fetchTransactions(nodeUrl, destPubkey, 50);
    if (items.some((t) => (t.id || t.txid || t.hash) === txId)) return tx;
  }
  console.warn(`⚠️  Tx ${txId} not confirmed within ${timeoutMs}ms — continuing`);
  return tx;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  fetchTransactions,
  sendTransaction,
  rebuildSurveys,
  computeResults,
  parseCisTx,
  slugify,
  last6,
  usernameSuffix,
  deriveDefaultUsername,
  sleep,
};
