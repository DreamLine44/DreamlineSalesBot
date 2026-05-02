import rateLimit from "express-rate-limit";

// ✅ FIX: Added standardHeaders and legacyHeaders options
// Also increased limit slightly — 20 per minute is very low for a chatbot
// that may send multiple rapid messages
export default rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // ✅ Raised from 20 — Meta may send bursts of webhook events
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests" }
});
