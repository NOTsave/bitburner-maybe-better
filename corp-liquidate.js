import { getNsDataThroughFile, log, disableLogs, formatMoney, asleep } from './helpers.js';
import { maximizeDividends } from './Corp/corp-dividend-manager.js';

/** @param {NS} ns **/
export async function main(ns) {
    disableLogs(ns, ['sleep', 'run', 'kill']);
    
    const LIQUIDATE_MODE = ns.args.includes('--liquidate');
    
    try {
        // Check if corporation exists
        const hasCorp = await getNsDataThroughFile(ns, 'ns.corporation.hasCorporation()');
        if (!hasCorp) {
            log(ns, 'INFO: No corporation to liquidate.', false, 'info');
            return;
        }

        // Get corporation data
        const corp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
        if (!corp) {
            log(ns, 'ERROR: Failed to fetch corporation data.', false, 'error');
            return;
        }

        log(ns, `INFO: Corporation: ${corp.name} | Funds: ${formatMoney(corp.funds || 0)} | Revenue: ${formatMoney(corp.revenue || 0)}/s`, false, 'info');

        if (LIQUIDATE_MODE) {
            // Stop corp-manager to free RAM
            const managerPid = ns.isRunning('corp-manager.js', 'home');
            if (managerPid) {
                await ns.kill('corp-manager.js', 'home');
                log(ns, 'INFO: Stopped corp-manager.js (freeing RAM)', false, 'info');
                await asleep(ns, 1000);
            }

            // Stop other corp-related scripts
            const corpScripts = ['corp-fetcher.js', 'Corp/corp-hr.js', 'Corp/corp-research.js', 'Corp/corp-products.js', 'Corp/corp-logistics.js', 'Corp/corp-stocks.js'];
            for (const script of corpScripts) {
                if (ns.isRunning(script, 'home')) {
                    await ns.kill(script, 'home');
                    log(ns, `INFO: Stopped ${script}`, false, 'info');
                    await asleep(ns, 500);
                }
            }

            // Set dividend rate to 100% to extract all possible money
            await maximizeDividends(ns, 'Liquidation - maximizing dividend extraction');

            // Calculate potential dividend payout (fetch fresh data after dividend change)
            const DIVIDEND_TAX = 0.15;
            const updatedCorp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
            const potentialDividend = (updatedCorp.revenue || 0) * (1.0 - DIVIDEND_TAX);
            
            log(ns, `INFO: Corp funds remain in corporation (~${formatMoney(corp.funds || 0)})`, false, 'info');
            log(ns, `INFO: Future revenue will be paid as dividends (~${formatMoney(potentialDividend)}/s after tax)`, false, 'info');
            log(ns, 'WARNING: Corporation persists across resets. Funds stay in corp.', true, 'warning');
        }

    } catch (e) {
        log(ns, `ERROR: Corp liquidation failed: ${e.message || e}`, false, 'error');
    }
}
