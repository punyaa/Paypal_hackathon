// Funds a ProofPay milestone through real PayPal sandbox guest card checkout, using a
// public test card number. Sandbox only: no real money moves.
const { chromium } = require('playwright');
module.exports = async function fund(B, clientLink, { shot } = {}) {
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  const p = await ctx.newPage();
  try {
    await p.goto(B + clientLink); await p.waitForTimeout(5000);
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
    return { popupClosed: closed, text: closed ? '' : (await pop.innerText('body')).slice(0, 600) };
  } finally { await br.close(); }
};
if (require.main === module) {
  // Usage: node scripts/sandbox-fund.cjs <baseUrl> <clientLink>
  module.exports(process.argv[2], process.argv[3]).then(r => console.log(JSON.stringify(r))).catch(e => { console.error('ERR', e.message); process.exit(1); });
}
