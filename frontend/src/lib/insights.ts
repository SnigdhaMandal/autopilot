/**
 * Derives coaching statistics from a user's automated transaction history.
 *
 * Everything here is a pure function over rows already fetched by the caller,
 * so the same maths backs the Coach cards, the goal ETAs and the system prompt
 * sent to the chat model — and can be unit tested without a database.
 */

export interface TxRow {
  /** Positive magnitude of the transfer, in XLM. */
  amount: number;
  /** Rule action that produced it: "Save" | "Invest" | "Buffer" | … */
  type: string;
  ruleId: string | null;
  createdAt: string | Date;
}

export interface ActivityStats {
  /** Total moved by automation in the trailing 7 days. */
  thisWeekTotal: number;
  /** Total moved in the 7 days before that, for week-over-week comparison. */
  lastWeekTotal: number;
  /** Total moved across every transaction supplied. */
  allTimeTotal: number;
  /** Trailing-7-day total split by action type, e.g. { Save: 42.5 }. */
  byTypeThisWeek: Record<string, number>;
  /** All-time total split by action type. */
  byTypeAllTime: Record<string, number>;
  txCountThisWeek: number;
  txCountAllTime: number;
  /** Largest single automated transfer, or 0 when there is no history. */
  largestTx: number;
  /** Days since the most recent automated transfer; null with no history. */
  daysSinceLastTx: number | null;
  /** Whole days between the first and last transaction. */
  observedDays: number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function toTime(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Discard rows that would poison the arithmetic — a non-finite or negative
 * amount, or an unparseable timestamp. Amounts are normalised to magnitudes so
 * a ledger that stores outflows as negatives still aggregates correctly.
 */
function sanitize(txs: TxRow[]): Array<TxRow & { time: number; amount: number }> {
  return (txs ?? [])
    .filter((t): t is TxRow => t != null)
    .map((t) => ({ ...t, amount: Math.abs(Number(t.amount)), time: toTime(t.createdAt) }))
    .filter((t) => Number.isFinite(t.amount) && Number.isFinite(t.time));
}

function addTo(bucket: Record<string, number>, key: string, amount: number): void {
  const label = key || "Other";
  bucket[label] = (bucket[label] ?? 0) + amount;
}

/**
 * Aggregate a transaction list into the stats the coaching surfaces need.
 *
 * `now` is injectable so the week boundaries are deterministic under test.
 */
export function computeActivityStats(txs: TxRow[], now: number = Date.now()): ActivityStats {
  const rows = sanitize(txs);

  const stats: ActivityStats = {
    thisWeekTotal: 0,
    lastWeekTotal: 0,
    allTimeTotal: 0,
    byTypeThisWeek: {},
    byTypeAllTime: {},
    txCountThisWeek: 0,
    txCountAllTime: rows.length,
    largestTx: 0,
    daysSinceLastTx: null,
    observedDays: 0,
  };

  if (rows.length === 0) return stats;

  let earliest = Infinity;
  let latest = -Infinity;

  for (const tx of rows) {
    const age = now - tx.time;

    stats.allTimeTotal += tx.amount;
    addTo(stats.byTypeAllTime, tx.type, tx.amount);

    // Future-dated rows (clock skew) count toward the current week, never the previous one.
    if (age < WEEK_MS) {
      stats.thisWeekTotal += tx.amount;
      stats.txCountThisWeek += 1;
      addTo(stats.byTypeThisWeek, tx.type, tx.amount);
    } else if (age < 2 * WEEK_MS) {
      stats.lastWeekTotal += tx.amount;
    }

    if (tx.amount > stats.largestTx) stats.largestTx = tx.amount;
    if (tx.time < earliest) earliest = tx.time;
    if (tx.time > latest) latest = tx.time;
  }

  stats.daysSinceLastTx = Math.max(0, Math.floor((now - latest) / DAY_MS));
  stats.observedDays = Math.max(0, Math.floor((latest - earliest) / DAY_MS));

  return stats;
}

/** Trim to at most `dp` decimals without leaving a trailing ".00". */
export function fmtXlm(amount: number, dp = 2): string {
  if (!Number.isFinite(amount)) return "0";
  const rounded = Number(amount.toFixed(dp));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(dp);
}

/** Percentage change from `previous` to `current`, or null when undefined. */
export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// ── Goal ETA ──────────────────────────────────────────────────────────────────

export interface EtaRule {
  id: string;
  amount: number;
  isPercentage: boolean;
}

export interface EtaInput {
  remaining: number;
  rule: EtaRule | null;
  /** Transactions attributed to the linked rule. */
  ruleTxs: TxRow[];
  /** Every automated transaction, used to infer payment size for % rules. */
  allTxs: TxRow[];
  now?: number;
}

export interface EtaResult {
  /** Human-readable ETA for display. */
  label: string;
  /** Inferred XLM per week, or null when it could not be established. */
  weeklyRate: number | null;
  /** Whether `weeklyRate` came from observed history or a documented fallback. */
  basis: "history" | "estimate" | "none";
}

/**
 * Assumed payment size for a percentage rule that has never fired, so a
 * freshly linked rule can still show an indicative ETA. Replaced by the user's
 * real average payment as soon as any history exists.
 */
export const ASSUMED_PAYMENT_XLM = 50;

/** Assumed triggers per week for a fixed-amount rule with no history yet. */
export const ASSUMED_TRIGGERS_PER_WEEK = 4;

/**
 * Estimate when a goal completes, preferring the linked rule's measured
 * throughput over any assumption.
 *
 * The old implementation always assumed a 50 XLM average payment and 4
 * triggers per week. Here those constants are the last resort: with history
 * available the rate comes from what the rule actually moved per week.
 */
export function calcGoalEta(input: EtaInput): EtaResult {
  const { remaining, rule, ruleTxs, allTxs, now = Date.now() } = input;

  if (remaining <= 0) return { label: "Completed! 🎉", weeklyRate: null, basis: "none" };
  if (!rule) return { label: "Link a savings rule to get an ETA", weeklyRate: null, basis: "none" };

  const history = sanitize(ruleTxs);
  let weeklyRate: number | null = null;
  let basis: EtaResult["basis"] = "estimate";

  if (history.length > 0) {
    const earliest = Math.min(...history.map((t) => t.time));
    const total = history.reduce((sum, t) => sum + t.amount, 0);

    // Measure over whole days elapsed, floored at one week so a burst of
    // activity in the first few days is not extrapolated into a wild rate.
    const elapsedMs = Math.max(now - earliest, WEEK_MS);
    const rate = total / (elapsedMs / WEEK_MS);

    if (rate > 0) {
      weeklyRate = rate;
      basis = "history";
    }
  }

  if (weeklyRate === null) {
    // No history for this rule — fall back to an explicit assumption, using
    // the user's real average payment for percentage rules when we have one.
    if (rule.isPercentage) {
      const all = sanitize(allTxs);
      const avgPayment =
        all.length > 0 ? all.reduce((s, t) => s + t.amount, 0) / all.length : ASSUMED_PAYMENT_XLM;
      weeklyRate = (rule.amount / 100) * avgPayment * ASSUMED_TRIGGERS_PER_WEEK;
    } else {
      weeklyRate = rule.amount * ASSUMED_TRIGGERS_PER_WEEK;
    }
  }

  if (!Number.isFinite(weeklyRate) || weeklyRate <= 0) {
    return { label: "Calculating…", weeklyRate: null, basis: "none" };
  }

  const weeks = Math.ceil(remaining / weeklyRate);
  const suffix = basis === "history" ? "" : " (est.)";

  if (weeks <= 1) return { label: `This week${suffix}`, weeklyRate, basis };
  if (weeks <= 4) return { label: `~${weeks} weeks${suffix}`, weeklyRate, basis };

  const months = Math.ceil(weeks / 4);
  if (months <= 12) {
    return { label: `~${months} month${months > 1 ? "s" : ""}${suffix}`, weeklyRate, basis };
  }

  const years = Math.ceil(months / 12);
  return { label: `~${years} year${years > 1 ? "s" : ""}${suffix}`, weeklyRate, basis };
}

// ── Weekly tip ────────────────────────────────────────────────────────────────

export interface TipContext {
  hasSaveRule: boolean;
  hasInvestRule: boolean;
  hasBufferRule: boolean;
  pausedCount: number;
  stats: ActivityStats;
}

export interface WeeklyTip {
  body: string;
  actionLabel: string;
  actionPrompt: string;
}

/**
 * Pick a weekly tip from the user's own configuration and activity.
 *
 * Ordered most- to least-specific: the first condition that matches wins, so
 * an idle automation or a missing buffer is surfaced ahead of generic advice.
 * The final branch rotates by ISO week so even a fully configured, steady user
 * sees the card change week to week rather than reading one frozen string.
 */
export function buildWeeklyTip(ctx: TipContext, now: number = Date.now()): WeeklyTip {
  const { stats } = ctx;

  if (stats.txCountAllTime === 0) {
    return {
      body:
        "Your rules are armed but haven't fired yet. AutoPilot acts on incoming payments — once one lands you'll see the amount it set aside here.",
      actionLabel: "Check my rule triggers",
      actionPrompt: "My rules haven't triggered yet. What trigger should I use to catch my income?",
    };
  }

  if (stats.daysSinceLastTx !== null && stats.daysSinceLastTx >= 14) {
    return {
      body: `No automated activity for ${stats.daysSinceLastTx} days, though you've automated ${fmtXlm(
        stats.allTimeTotal,
      )} XLM in total. If your income moved to a different wallet, your rule triggers may need updating.`,
      actionLabel: "Review my triggers",
      actionPrompt:
        "My automations have gone quiet for two weeks. Help me review my rule triggers.",
    };
  }

  const change = pctChange(stats.thisWeekTotal, stats.lastWeekTotal);

  if (change !== null && change <= -25) {
    return {
      body: `You automated ${fmtXlm(stats.thisWeekTotal)} XLM this week, down ${Math.abs(
        change,
      )}% from ${fmtXlm(
        stats.lastWeekTotal,
      )} XLM last week. A fixed weekly amount alongside your percentage rule keeps contributions steady when income dips.`,
      actionLabel: "Add a steady weekly rule",
      actionPrompt:
        "My savings dropped this week. Create a fixed weekly savings rule to smooth out my contributions.",
    };
  }

  if (change !== null && change >= 25) {
    return {
      body: `Strong week — ${fmtXlm(stats.thisWeekTotal)} XLM automated, up ${change}% from ${fmtXlm(
        stats.lastWeekTotal,
      )} XLM. Raising your rate while income is high is the cheapest time to do it.`,
      actionLabel: "Raise my savings rate",
      actionPrompt: `I automated ${fmtXlm(
        stats.thisWeekTotal,
      )} XLM this week, up ${change}%. Help me raise my savings rate.`,
    };
  }

  if (!ctx.hasBufferRule) {
    return {
      body: `You've automated ${fmtXlm(
        stats.allTimeTotal,
      )} XLM so far with no balance buffer protecting it. A buffer rule pauses non-essential outflows when your balance drops below a floor you set.`,
      actionLabel: "Set up a buffer rule",
      actionPrompt: "Help me set up a balance buffer rule to protect my spending floor",
    };
  }

  if (!ctx.hasInvestRule && (stats.byTypeAllTime.Save ?? 0) > 0) {
    return {
      body: `You've saved ${fmtXlm(
        stats.byTypeAllTime.Save ?? 0,
      )} XLM but none of it is being invested. Routing even a small slice into a recurring investment compounds over time.`,
      actionLabel: "Start investing a slice",
      actionPrompt: "I have savings but no investment rule. Help me start investing a small slice.",
    };
  }

  if (ctx.pausedCount > 0) {
    return {
      body: `${ctx.pausedCount} of your rules ${
        ctx.pausedCount > 1 ? "are" : "is"
      } paused. Paused rules keep their config but never fire, so nothing is being set aside by them.`,
      actionLabel: "Review paused rules",
      actionPrompt: "Help me decide whether to resume or replace my paused rules.",
    };
  }

  // Steady state: rotate weekly so the card keeps moving.
  const avgPerTx = stats.txCountAllTime > 0 ? stats.allTimeTotal / stats.txCountAllTime : 0;
  const rotating: WeeklyTip[] = [
    {
      body: `You're averaging ${fmtXlm(avgPerTx)} XLM per automated transfer across ${
        stats.txCountAllTime
      } transfers. Nudging your rate by a few percent compounds without changing how your week feels.`,
      actionLabel: "Nudge my rate up",
      actionPrompt: "Help me increase my savings rate by a few percent.",
    },
    {
      body: `${fmtXlm(
        stats.allTimeTotal,
      )} XLM automated so far. Linking a rule to a named goal turns that flow into visible progress you can track.`,
      actionLabel: "Link a rule to a goal",
      actionPrompt: "Help me link one of my rules to a savings goal.",
    },
    {
      body: `Your largest single automated transfer was ${fmtXlm(
        stats.largestTx,
      )} XLM. A per-month cap on a rule keeps a single large payment from moving more than you intended.`,
      actionLabel: "Add a monthly cap",
      actionPrompt: "Help me add a monthly limit to my savings rule.",
    },
    {
      body: `Steady week — ${fmtXlm(
        stats.thisWeekTotal,
      )} XLM automated. Splitting one rule across two destinations diversifies without extra effort.`,
      actionLabel: "Split my automation",
      actionPrompt: "Help me split my savings rule across two destinations.",
    },
  ];

  // ISO-ish week index; stable within a week, advances every 7 days.
  const weekIndex = Math.floor(now / WEEK_MS);
  return rotating[weekIndex % rotating.length];
}

// ── AI context ────────────────────────────────────────────────────────────────

/**
 * Render the user's activity as a compact block for the chat model's system
 * prompt, so advice can reference real figures instead of guessing.
 *
 * Only aggregates are included — no transaction hashes, memos or counterparty
 * addresses — to keep identifying detail out of the third-party model call.
 */
export function buildAiContext(stats: ActivityStats): string {
  if (stats.txCountAllTime === 0) {
    return "The user has no automated transaction history yet; their rules have not fired.";
  }

  const lines = [
    `- Automated this week: ${fmtXlm(stats.thisWeekTotal)} XLM across ${stats.txCountThisWeek} transfer(s)`,
    `- Automated previous week: ${fmtXlm(stats.lastWeekTotal)} XLM`,
    `- Automated all time: ${fmtXlm(stats.allTimeTotal)} XLM across ${stats.txCountAllTime} transfer(s)`,
    `- Largest single transfer: ${fmtXlm(stats.largestTx)} XLM`,
  ];

  const byType = Object.entries(stats.byTypeAllTime);
  if (byType.length > 0) {
    lines.push(
      `- By action (all time): ${byType
        .map(([type, total]) => `${type} ${fmtXlm(total)} XLM`)
        .join(", ")}`,
    );
  }

  if (stats.daysSinceLastTx !== null) {
    lines.push(`- Days since last automated transfer: ${stats.daysSinceLastTx}`);
  }

  const change = pctChange(stats.thisWeekTotal, stats.lastWeekTotal);
  if (change !== null) {
    lines.push(`- Week-over-week change: ${change >= 0 ? "+" : ""}${change}%`);
  }

  return lines.join("\n");
}
