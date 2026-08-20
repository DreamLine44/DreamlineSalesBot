/**
 * core/shared/uiOptionsHelper.js
 *
 * [FIX-EXPOSED-BUTTONS-1] Single source of truth for "here are your main
 * options" replies (post-cancel, post-order, fallback nudges, etc).
 *
 * Root cause originally fixed here: buildWelcomeSequence() in moduleRouter.js
 * already preferred cfg.ui.welcomeList (the "Choose an option ▼" dropdown)
 * over the raw 3-button + "⋯ More" layout for the FIRST greeting — but ~15
 * other call sites across flowEngine.js, moduleRouter.js, webhookController.js,
 * postFlowHandler.js, and leadCaptureService.js built their own reply
 * directly as `{ type: 'buttons', buttons: cfg.ui?.welcomeButtons }`,
 * bypassing that preference entirely. buildOptionsReply() became the one
 * place that decides "list or buttons" for a GENERIC full-menu-style reply
 * (calls with no explicit `customButtons` argument), so those call sites now
 * show the tenant's standard nav consistently instead of a duplicated/drifted
 * copy of it.
 *
 * [FIX-CONTEXTUAL-BUTTONS-1] That fix over-corrected: it made cfg.ui.welcomeList
 * / cfg.ui.welcomeButtons win even when a caller explicitly passed its own
 * `customButtons` for a specific moment (e.g. adminCommandService.js's
 * order-cancellation notice passing `[{id:'ORDER', title:'🛒 Place New
 * Order'}, {id:'QUESTION', title:'❓ Ask a Question'}]`). Those specific,
 * context-appropriate buttons were silently discarded in favor of the
 * tenant's generic "Choose an option ▼" welcome dropdown for any mode that
 * configures cfg.ui.welcomeList (restaurant, salon, services) — a customer
 * who just had their order cancelled saw an unrelated 4-item main menu
 * instead of a direct "Place New Order" / "Ask a Question" pair.
 *
 * Fix: a caller-supplied `customButtons` array now always wins and is
 * rendered as native quick-reply buttons (WhatsApp supports up to 3 — every
 * caller in this codebase passes 1-2). cfg.ui.welcomeList / welcomeButtons
 * remain the default ONLY for the generic "what would you like to do?"
 * call sites that don't pass their own buttons — those still get the
 * consistent, tenant-configured main-nav control exactly as before.
 */
export function buildOptionsReply(cfg, body, customButtons) {
  const hasCustomButtons = Array.isArray(customButtons) && customButtons.length > 0;

  if (hasCustomButtons) {
    return {
      type:    'buttons',
      body,
      buttons: customButtons,
    };
  }

  if (cfg?.ui?.welcomeList) {
    return {
      type:   'list',
      body,
      button: cfg.ui.welcomeList.button || 'Choose an option',
      rows:   cfg.ui.welcomeList.rows || [],
    };
  }
  return {
    type:    'buttons',
    body,
    buttons: cfg?.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
  };
}

