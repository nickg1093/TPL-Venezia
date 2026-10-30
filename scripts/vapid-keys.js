// Genera una coppia di chiavi VAPID per le notifiche di arrivo. Uso:  node scripts/vapid-keys.js
// Copia i due valori nelle variabili d'ambiente del servizio (Render > Environment): così le notifiche restano valide anche dopo i riavvii.
const v = require('../push').loadVapid({});
console.log('VAPID_PUBLIC_KEY=' + require('../push').b64u(v.pub));
console.log('VAPID_PRIVATE_KEY=' + v.privB64);
