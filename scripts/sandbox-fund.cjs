// Funds a ProofPay milestone through real PayPal sandbox checkout. Sandbox only: no real money moves.
// - With SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD (in .env or the environment): clicks
//   "Pay with PayPal" and logs in as that sandbox buyer.
// - Otherwise: "Debit or Credit Card" guest checkout with a public test card.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function buyerFromEnv() {
  const file = path.join(__dirname, '..', '.env');
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
  return env.SANDBOX_BUYER_EMAIL && env.SANDBOX_BUYER_PASSWORD ? { email: env.SANDBOX_BUYER_EMAIL, password: env.SANDBOX_BUYER_PASSWORD } : null;
}

async function payWithLogin(ctx, p, buyer) {
  const btnFrame = p.frames().find(f => f.url().includes('/smart/buttons'));
  const [pop] = await Promise.all([ctx.waitForEvent('page'), btnFrame.click('[data-funding-source="paypal"]')]);
  await pop.waitForLoadState('domcontentloaded');
  await pop.waitForSelector('#email', { timeout: 30000 });
  await pop.fill('#email', buyer.email);
  await pop.click('#btnNext');
  await pop.waitForSelector('#password', { timeout: 30000 });
  await pop.click('#acceptAllButton', { timeout: 2000 }).catch(() => {});
  await pop.fill('#password', buyer.password);
  await pop.click('#btnLogin');
  const confirm = pop.locator('button:has-text("Confirm and Pay"), button:has-text("Pay Now"), button:has-text("Continue"), #payment-submit-btn').first();
  await confirm.waitFor({ timeout: 45000 });
  await confirm.click();
  return pop;
}

module.exports = async function fund(B, clientLink, { shot, method } = {}) {
  const buyer = method === 'card' ? null : buyerFromEnv();
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  const p = await ctx.newPage();
  try {
    await p.goto(B + clientLink); await p.waitForTimeout(5000);
    if (buyer) {
      const pop = await payWithLogin(ctx, p, buyer);
      const closed = await pop.waitForEvent('close', { timeout: 60000 }).then(() => true).catch(() => false);
      await p.waitForTimeout(6000);
      if (shot) await p.screenshot({ path: shot + '-client.png' });
      return { method: 'paypal-login', popupClosed: closed, text: closed ? '' : (await pop.innerText('body').catch(() => '')).slice(0, 600) };
    }
    const btnFrame = p.frames().find(f => f.url().includes('/smart/buttons'));
    const [pop] = await Promise.all([ctx.waitForEvent('page'), btnFrame.click('[data-funding-source="card"]')]);
    await pop.waitForLoadState('domcontentloaded'); await pop.waitForSelector('#cardNumber', { timeout: 30000 });
    await pop.click('text=Yes, I accept', { timeout: 3000 }).catch(() => {});
    await pop.selectOption('#country', 'US').catch(() => {});
    await pop.waitForTimeout(4000);
    await pop.waitForSelector('#cardNumber');
    const fill = async (sel, v) => { const el = await pop.$(sel); if (el) { await el.click(); await el.fill(''); await el.type(v, { delay: 15 }); } };
    await fill('#email', `pp-guest-${Date.now()}@example.com`);
    await pop.waitForTimeout(2500);
    await fill('#phone', '4155550100');
    await fill('#cardNumber', '4111111111111111');
    await fill('#cardExpiry', '1230');
    await fill('#cardCvv', '123');
    await fill('#firstName', 'Kopi');
    await fill('#lastName', 'Crumbs');
    await fill('#billingLine1', '1 Market St');
    await fill('#billingCity', 'San Francisco');
    await pop.selectOption('#billingState', 'CA').catch(() => {});
    await fill('#billingPostalCode', '94105');
    await fill('#phone', '4155550100');
    
    if (shot) await pop.screenshot({ path: shot + '-form.png', fullPage: true });
    await pop.click('button[type=submit], input[type=submit], #submit-button').catch(async () => { await pop.keyboard.press('Enter'); });
    // Popup closes on success, then onApprove calls our /authorize.
    const closed = await pop.waitForEvent('close', { timeout: 60000 }).then(() => true).catch(() => false);
    if (!closed && shot) await pop.screenshot({ path: shot + '-after.png', fullPage: true });
    await p.waitForTimeout(6000);
    if (shot) await p.screenshot({ path: shot + '-client.png', fullPage: false });
    return { method: 'guest-card', popupClosed: closed, text: closed ? '' : (await pop.innerText('body')).slice(0, 600) };
  } finally { await br.close(); }
};
if (require.main === module) {
  // Usage: node scripts/sandbox-fund.cjs <baseUrl> <clientLink>
  module.exports(process.argv[2], process.argv[3], { method: process.argv[4] }).then(r => console.log(JSON.stringify(r))).catch(e => { console.error('ERR', e.message); process.exit(1); });
}
