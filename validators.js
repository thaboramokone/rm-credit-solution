const MIN_AMOUNT = 100;
const MAX_AMOUNT = 3000;
const MONTHLY_RATE = 0.05; // 5% interest charged per month
const DOC_MAX_AGE_MONTHS = 3;
const ADMIN_SUFFIX = "rm@outlook.com";
const MIN_DAYS = 1;
const MAX_DAYS = 90;

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAdminEmail(email) {
  return typeof email === "string" && email.toLowerCase().endsWith(ADMIN_SUFFIX);
}

function isValidSaId(id) {
  return typeof id === "string" && /^\d{13}$/.test(id);
}

// Interest is never trusted from the client — always recomputed server-side
// from amount + days so a tampered request body can't alter the terms.
function computeLoanTerms(amount, days) {
  const termMonths = days / 30;
  const interest = Math.round(amount * MONTHLY_RATE * termMonths * 100) / 100;
  const total = Math.round((amount + interest) * 100) / 100;
  return { termMonths, interest, total, monthlyRate: MONTHLY_RATE };
}

function validateLoanAmount(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "Enter a valid amount.";
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) return `Amount must be between R${MIN_AMOUNT} and R${MAX_AMOUNT}.`;
  return null;
}

function validateLoanDays(days) {
  if (typeof days !== "number" || !Number.isInteger(days)) return "Enter a valid number of days.";
  if (days < MIN_DAYS || days > MAX_DAYS) return `Days must be between ${MIN_DAYS} and ${MAX_DAYS}.`;
  return null;
}

// Returns an error message if dateStr isn't a valid date within the last
// `months` months (and not in the future), or "" if it's fine.
function documentDateError(dateStr, months) {
  if (!dateStr) return "Date is required.";
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return "Enter a valid date.";
  const now = new Date();
  if (d > now) return "Date can't be in the future.";
  const threshold = new Date(now);
  threshold.setMonth(threshold.getMonth() - months);
  if (d < threshold) return `Must be dated within the last ${months} months.`;
  return "";
}

module.exports = {
  MIN_AMOUNT,
  MAX_AMOUNT,
  MONTHLY_RATE,
  DOC_MAX_AGE_MONTHS,
  ADMIN_SUFFIX,
  MIN_DAYS,
  MAX_DAYS,
  isValidEmail,
  isAdminEmail,
  isValidSaId,
  computeLoanTerms,
  validateLoanAmount,
  validateLoanDays,
  documentDateError,
};
