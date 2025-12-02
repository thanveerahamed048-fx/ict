import 'dotenv/config';
import { Mailer } from './src/notify/mailer.js';

// Configuration from app.js
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;
const SMTP_SECURE = true;
const SMTP_USER = '123ninjaboy456@gmail.com';
const SMTP_PASS = 'process.env.SMTP_PASS'; // Placeholder, will check .env or need user input
const MAIL_FROM = 'Forex Signals <123ninjaboy456@gmail.com>';
const MAIL_TO = 'thanveerahamed048@gmail.com';

async function test() {
    console.log('Testing Mailer...');
    console.log(`User: ${SMTP_USER}`);
    // console.log(`Pass: ${SMTP_PASS}`); // Don't log password

    const mailer = new Mailer({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        user: SMTP_USER,
        pass: process.env.SMTP_PASS || '', // Try to get from env if not hardcoded
        from: MAIL_FROM,
        to: MAIL_TO,
        enabled: true,
        throttleMs: 0 // Disable throttle for test
    });

    try {
        console.log('Verifying connection...');
        await mailer.verify();
        console.log('Connection verified.');

        console.log('Sending test email...');
        await mailer.sendSignal({
            type: 'strategy_entry',
            strategy: 'TEST_STRAT',
            instrumentId: 'TEST_USD',
            direction: 'buy',
            entry: 1.2345,
            sl: 1.2300,
            tp: 1.2400,
            slPips: 45,
            tpPips: 55,
            tsMs: Date.now()
        });
        console.log('Test email sent successfully.');
    } catch (e) {
        console.error('Test failed:', e);
    }
}

test();
