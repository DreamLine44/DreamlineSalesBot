const fs = require('fs');
const path = require('path');

const dir = 'c:\\Users\\DreamLineKing YM\\OneDrive\\Desktop\\WhatSalesAgent_(Normal)\\src\\services';

const barrels = [
  'activeOrderResolver.js',
  'activityLookupService.js',
  'activityStatusService.js',
  'adminAuthService.js',
  'adminCommandService.js',
  'auditService.js',
  'bookingDateFlow.js',
  'bookingDateFlowProvisioner.js',
  'bookingDateParser.js',
  'bookingDatePickerUI.js',
  'bookingService.js',
  'metaCredentialService.js',
  'orderService.js',
  'promoService.js',
  'questionAnswerService.js',
  'questionModeHelper.js',
  'whatsappNotificationService.js',
  'whatsappOnboardingService.js'
];

let deleted = 0;
for (const barrel of barrels) {
  const filePath = path.join(dir, barrel);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    deleted++;
  }
}

console.log(`Deleted ${deleted} barrel files`);
