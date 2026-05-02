import express from "express";
import {
  registerTenant,
  listTenants,
  getTenant,
  updateTenant,
  rotateApiKey,
  setTenantStatus,
  deleteTenant,
  connectWhatsApp
} from "../controllers/tenantController.js";

const router = express.Router();

// Note: requireSuperAdminKey is already applied at the app.js level for all /admin/tenants routes.

router.post("/register", registerTenant);               // Step 1: Onboard new client
router.post("/:id/connect-whatsapp", connectWhatsApp);  // Step 2: Connect their WhatsApp (Meta Embedded Signup or manual)
router.get("/", listTenants);                           // List all clients
router.get("/:id", getTenant);                          // Get single client
router.put("/:id", updateTenant);                       // Update client
router.post("/:id/rotate-key", rotateApiKey);           // Rotate client API key
router.put("/:id/status", setTenantStatus);             // Suspend / activate
router.delete("/:id", deleteTenant);                    // Remove client

export default router;
