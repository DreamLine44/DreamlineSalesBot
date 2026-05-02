import rateLimit from "express-rate-limit";

export default rateLimit({
  windowMs: 60 * 1000,
  max: 60,             // High enough to handle Meta webhook bursts
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests" }
});
