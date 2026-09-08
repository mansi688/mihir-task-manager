// Generates the VAPID key pair push notifications need — run this ONCE and paste the output
// into your .env file. These must stay the same across restarts (like JWT_SECRET), or every
// device that already subscribed will silently stop receiving push notifications.
//
// Run from the project folder:   node generate-vapid-keys.js
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('Add these two lines to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('\nThen restart the server. Push notifications will work once these are set.');
