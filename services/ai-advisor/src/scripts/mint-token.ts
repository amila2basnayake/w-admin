// Reference token minter — mirrors EXACTLY what the CRM JSP produces.
// Usage: npm run mint -- <uid> "<name>" <usertype>
import crypto from 'node:crypto';
import { config } from '../config';

const [, , uidArg, nameArg, utArg] = process.argv;
const uid = Number(uidArg ?? 1);
const name = nameArg ?? 'Test User';
const ut = Number(utArg ?? 2);

const now = Math.floor(Date.now() / 1000);
const claims = { uid, name, ut, iat: now, exp: now + config.tokenTtl, nonce: crypto.randomBytes(8).toString('hex') };
const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
const sig = crypto.createHmac('sha256', config.sharedSecret).update(body).digest('base64url');
console.log(body + '.' + sig);
