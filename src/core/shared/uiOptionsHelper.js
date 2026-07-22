/**
 * core/shared/uiOptionsHelper.js
 *
 * [FIX-EXPOSED-BUTTONS-1] Single source of truth for "here are your main
 * options" replies (post-cancel, post-order, fallback nudges, etc).
 *
 * Root cause fixed here: buildWelcomeSequence() in moduleRouter.js already
 * preferred cfg.ui.welcomeList (the "Choose an option ▼" dropdown) over the
 * raw 3-button + "⋯ More" layout for the FIRST greeting — but ~15 other call
 * sites across flowEngine.js, moduleRouter.js, webhookController.js,
 * postFlowHandler.js, and leadCaptureService.js built their own reply
 * directly as `{ type: 'buttons', buttons: cfg.ui?.welcomeButtons }`,
 * bypassing that preference entirely. That's why a customer would see the
 * clean dropdown on first greeting, then the raw "Order Food / Book a Table
 * / ⋯ More" buttons exposed after cancelling an order or any other secondary
 * prompt — the SAME option set, just rendered inconsistently depending on
 * which code path built it.
 *
 * buildOptionsReply() is the one place that decides "list or buttons" for
 * any full-menu-style reply. Every call site listed above now goes through
 * it, so a mode that defines cfg.ui.welcomeList only ever shows the
 * dropdown, never the raw buttons underneath it.
 */
export function buildOptionsReply(cfg, body, fallbackButtons = [{ id: 'SHOW_MENU', title: '🔄 Start Over' }]) {
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
    buttons: cfg?.ui?.welcomeButtons || fallbackButtons,
  };
}
