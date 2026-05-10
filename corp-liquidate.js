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
            // Kill ALL Corp modules to ensure clean liquidation
            const CORP_SCRIPTS = [
                'corp-manager.js',
                'corp-fetcher.js', 
                'Corp/corp-hr.js',
                'Corp/corp-research.js',
                'Corp/corp-products.js',
                'Corp/corp-logistics.js',
                'Corp/corp-stocks.js',
                'Corp/corp-dividend-manager.js'
            ];

            log(ns, 'INFO: Stopping all Corp modules for clean liquidation...', false, 'info');
            
            for (const script of CORP_SCRIPTS) {
                const runningProcesses = ns.ps('home').filter(p => p.filename === script);
                for (const process of runningProcesses) {
                    try {
                        await ns.kill(process.pid);
                        log(ns, `SUCCESS: Killed ${script} (PID: ${process.pid})`, false, 'success');
                        await asleep(ns, 500); // Throttle kills to prevent API spam
                    } catch (killError) {
                        log(ns, `WARN: Failed to kill ${script} (PID: ${process.pid}): ${killError.message || killError}`, false, 'warning');
                    }
                }
            }
            
            // Double-check all Corp scripts are stopped
            const remainingCorpScripts = ns.ps('home').filter(p => 
                CORP_SCRIPTS.some(script => p.filename === script)
            );
            
            if (remainingCorpScripts.length > 0) {
                log(ns, `WARNING: ${remainingCorpScripts.length} Corp scripts still running after cleanup`, false, 'warning');
                // Force kill remaining scripts
                for (const process of remainingCorpScripts) {
                    try {
                        await ns.kill(process.pid);
                        log(ns, `FORCE: Killed remaining ${process.filename}`, false, 'warning');
                    } catch (e) {
                        log(ns, `ERROR: Could not force kill ${process.filename}: ${e.message || e}`, false, 'error');
                    }
                }
            } else {
                log(ns, 'SUCCESS: All Corp modules stopped successfully', false, 'success');
            }
            
            await asleep(ns, 1000); // Allow system to stabilize

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
