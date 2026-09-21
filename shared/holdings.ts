/**
 * shared/holdings.ts
 *
 * Turning SimpleFin's `holdings` array into the one snapshot Wealthfolio wants
 * for an investment account.
 *
 * Why this exists at all: until v1.50 the sync read `transactions` and ignored
 * `holdings` outright, so a brokerage account got its cash balance and its cash
 * activity and no positions — the account looked like a bank account that
 * happened to be at a broker. SimpleFin publishes the positions; nothing was
 * reading them.
 *
 * Why it is a pure function in `shared/`: the snapshot is a data transform with
 * a handful of load-bearing edge cases (below), and the two halves reach the
 * host differently — the addon calls the SDK's `snapshots` API, and the
 * companion CANNOT, because the self-hosted REST server exposes no snapshot
 * route (verified against Wealthfolio 3.8's router: `/snapshots/holdings` is a
 * read path only). Keeping the transform here means the edge cases are tested
 * once and the capability difference stays in the adapters.
 *
 * A snapshot is a FULL statement of what an account holds on a date, not a
 * delta. That single fact drives every decision in here: anything less than a
 * complete, usable positions list must produce NO snapshot rather than a
 * partial one, because a partial snapshot is indistinguishable from "I sold the
 * rest".
 */
import type { SimplefinAccount } from './types.js';

/** One line of a snapshot: a position, in the shape the host's snapshot import
 *  takes. Declared here rather than imported from the SDK so `shared/` stays
 *  SDK-free (the companion has no SDK); the addon adapter maps it across. */
export interface HoldingsPosition {
  symbol: string;
  /** Share count as a decimal STRING. Money and share counts never become
   *  floats in this codebase — the host takes strings and parses them with a
   *  decimal type, and routing through a JS number is how an 8-decimal crypto
   *  position loses its tail. */
  quantity: string;
  /** Per-share cost basis, absent when SimpleFin reported none. */
  avgCost?: string;
  currency: string;
}

export interface HoldingsSnapshot {
  /** A bare `YYYY-MM-DD`, unlike an activity's date, which is a full instant. A
   *  snapshot is a valuation bucket for a calendar day, and the host's
   *  idempotency signal (`existingDates`) is keyed the same way. */
  date: string;
  positions: HoldingsPosition[];
  /** Currency → balance, as strings. SimpleFin reports one balance per account,
   *  so this map always has exactly one entry. */
  cashBalances: Record<string, string>;
}

/**
 * The snapshot for one SimpleFin account, or `null` when there is nothing
 * honest to write.
 *
 * `null` in three cases, all the same underlying reason — a snapshot states the
 * WHOLE position list, so an incomplete one is a false claim:
 *
 *  1. No `holdings` key. Every bank and card account, and the normal case. The
 *     account is not an investment account and never had positions to state.
 *  2. An empty `holdings` array. Same conclusion, and deliberately NOT read as
 *     "the account is empty": SimpleFin sends an empty array for accounts it has
 *     no holdings data for as readily as for a genuinely empty brokerage, and
 *     the two are indistinguishable from here. Writing a positions-free snapshot
 *     on that guess would zero a real portfolio for that date.
 *  3. Every holding unusable. The filter below drops holdings that cannot be
 *     resolved, and if it drops all of them the remainder is an empty list —
 *     case 2 again, reached by a different road.
 *
 * A holding is unusable without a symbol (nothing to resolve an asset from) or
 * without a share count (nothing to value). Either one makes the host reject the
 * ENTIRE batch, which is why they are filtered rather than passed through and
 * left to fail: one junk line would cost the account its whole snapshot.
 *
 * `balanceIncludesHoldings` — set per-account on the Sync page's account
 * mapper — is for the institutions where that assumption is wrong: see
 * `cashBalanceFor` below.
 */
export function toHoldingsSnapshot(
  account: SimplefinAccount,
  balanceIncludesHoldings = false,
): HoldingsSnapshot | null {
  const holdings = account.holdings;
  if (!Array.isArray(holdings) || holdings.length === 0) return null;

  const positions: HoldingsPosition[] = [];
  for (const holding of holdings) {
    const symbol = String(holding.symbol ?? '').trim();
    const shares = holding.shares === null || holding.shares === undefined
      ? ''
      : String(holding.shares).trim();
    if (!symbol || !shares) continue;
    positions.push({
      symbol,
      quantity: shares,
      // `undefined` (an absent key), never a zero: a zero cost basis is a
      // positive claim that the position was free, which shows up as fictional
      // gains on the holdings page.
      avgCost: holding.purchase_price ? String(holding.purchase_price) : undefined,
      // SimpleFin omits a holding's currency when it matches the account's,
      // which is the overwhelmingly common case.
      currency: String(holding.currency ?? account.currency),
    });
  }
  if (positions.length === 0) return null;

  return {
    // The BALANCE date, not today: a feed can be a day or more behind, and
    // dating a snapshot today would attribute yesterday's positions to a day
    // they were not held — then collide with the real snapshot for today.
    date: new Date(account['balance-date'] * 1000).toISOString().slice(0, 10),
    positions,
    cashBalances: { [account.currency]: cashBalanceFor(account, balanceIncludesHoldings) },
  };
}

/**
 * SimpleFin's `balance` is documented as one number per account, and for the
 * overwhelming majority of institutions that number IS the cash sub-balance —
 * separate from `holdings`, which is why the positions above can be added
 * alongside it without double-counting anything.
 *
 * Some institutions' bridges instead put the account's TOTAL value (cash plus
 * the market value of every holding) in that same field. Nothing in the feed
 * says which convention is in play — a cash-only balance and a total-value
 * balance can both look like a perfectly ordinary number — so this cannot be
 * auto-detected without risking silently corrupting the accounts that already
 * work. It only ever changes behaviour for an account the user has explicitly
 * marked, via `balanceIncludesHoldings` (Sync page → account mapper →
 * "Balance already includes securities value").
 *
 * For a marked account, cash is `balance − Σ market_value`, computed from
 * every reported holding (not just the ones that became a `HoldingsPosition`
 * above) — a holding's value still counts against the broker's total even when
 * its symbol or share count was too broken to record as a position. If any
 * holding is missing a usable `market_value`, or `balance` itself will not
 * parse, this falls back to the unmarked behaviour (raw `balance`) rather than
 * writing a guess — an unmarked account's cash stays exactly as it was before
 * this function existed.
 */
function cashBalanceFor(account: SimplefinAccount, balanceIncludesHoldings: boolean): string {
  if (!balanceIncludesHoldings) return account.balance;

  const balance = Number(account.balance);
  if (!Number.isFinite(balance)) return account.balance;

  let marketValueTotal = 0;
  for (const holding of account.holdings ?? []) {
    const raw = holding.market_value;
    if (raw === null || raw === undefined || raw === '') return account.balance;
    const value = Number(raw);
    if (!Number.isFinite(value)) return account.balance;
    marketValueTotal += value;
  }
  // Rounded to cents, same as every other money subtraction in this codebase
  // (see e.g. the starting-balance math in sync-core.ts): plain float
  // subtraction on decimal dollar amounts routinely lands one bit off zero —
  // 1512.34 - 512.34 is 999.9999999999999, not 1000 — which would otherwise
  // write a cash balance with a phantom fractional cent on every sync.
  return String(Math.round((balance - marketValueTotal) * 100) / 100);
}
