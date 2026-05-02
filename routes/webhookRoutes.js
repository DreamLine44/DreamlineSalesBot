import express from "express";
import { verifyWebhook, handleWebhook } from "../controllers/webhookController.js";

const router = express.Router();

// Meta sends webhook verification to GET /webhook or GET /webhook/:phoneNumberId
router.get("/", verifyWebhook);
router.get("/:phoneNumberId", verifyWebhook);

// Incoming messages — Meta can POST to either /webhook or /webhook/:phoneNumberId
// [FIX-ROUTE] Added /:phoneNumberId POST route — Meta sometimes sends to the
// phone-number-scoped path, which previously had no handler and dropped messages.
router.post("/", handleWebhook);
router.post("/:phoneNumberId", handleWebhook);

export default router;
