/**
 * modules/electronics/flows/index.js
 *
 * Entry point for the Electronics module flows.
 *
 * Re-exports every flow handler so moduleRegistry.js can import them
 * from a single path. Also re-exports the config so the webhookController
 * can read UI settings (welcome buttons, fallback buttons, etc.) without
 * importing the config folder directly.
 *
 * Registered flows (see moduleRegistry.js):
 *   ELECTRONICS : ORDER        → handleElectronicsOrder
 *   ELECTRONICS : SPEC_REQUEST → handleSpecRequest
 *   ELECTRONICS : COMPARE      → handleCompare
 *   ELECTRONICS : WARRANTY     → handleWarranty
 */

export {
  handleElectronicsOrder,
  handleSpecRequest,
  handleCompare,
  handleWarranty,
} from './orderFlow.js';

export { ELECTRONICS_CONFIG } from '../configs/index.js';
