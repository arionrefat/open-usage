import type { ModelSpend, Money } from "../data/types";

/** Presentation helpers for money and model names. Pure layout math, no React. */

/** Exact to the minor unit - a rounded bill reads as a wrong bill. */
export function formatMoney(money: Money): string {
  const digits = Math.max(0, Math.min(money.exponent, 2));
  const amount = money.amountMinor / 10 ** money.exponent;
  const text = amount.toFixed(digits);
  return money.currency === "USD" ? `$${text}` : `${text} ${money.currency}`;
}

/**
 * `claude-opus-4-8` reads as `opus 4.8`. The vendor prefix is redundant on a
 * screen already headed "claude code", and the dashes are version separators.
 */
export function shortModelName(model: string): string {
  const withoutVendor = model.replace(/^claude-/, "");
  const match = /^([a-z]+)-(\d+(?:-\d+)*)$/.exec(withoutVendor);
  if (!match) return withoutVendor;
  return `${match[1]} ${match[2]?.replace(/-/g, ".")}`;
}

/**
 * Share of the period each model accounts for, by cost where costs exist and by
 * token volume otherwise, so the bars still rank correctly for unpriced models.
 */
export function modelShares(models: readonly ModelSpend[]): number[] {
  const costTotal = models.reduce((sum, model) => sum + (model.cost?.amountMinor ?? 0), 0);
  if (costTotal > 0) {
    return models.map((model) => ((model.cost?.amountMinor ?? 0) / costTotal) * 100);
  }
  const volume = (model: ModelSpend) =>
    model.tokens.input + model.tokens.output + model.tokens.cacheWrite;
  const tokenTotal = models.reduce((sum, model) => sum + volume(model), 0);
  if (tokenTotal <= 0) return models.map(() => 0);
  return models.map((model) => (volume(model) / tokenTotal) * 100);
}
