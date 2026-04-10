import { getNsDataThroughFile, log, formatMoney, formatNumber, formatRam, getFilePath, 
    getFnRunViaNsExec, getFnIsAliveViaNsIsRunning, runCommand, getNsDataThroughFile_Custom, getCachedCorpData, asleep } from '../helpers.js'
import { setOperatingDividends } from './corp-dividend-manager.js'

// Stock module configuration
const STOCK_CONFIG = {
    checkInterval: 60000,        // Check every 60s
    buyThreshold: 1e12,         // Buy at 1T+ available funds
    sellThreshold: 100e9,        // Sell at 100B+ profit
    maxHoldingPercent: 0.4,     // Max 40% of shares
    minProfitMargin: 0.1,       // Min 10% profit margin
    dividendTarget: 0.3,           // Target dividend rate 30%
    selfTerminate: true,           // Self-termination after reaching goals
    completionConditions: [        // Conditions for self-termination
        { type: 'dividend_rate', operator: '>=', value: 0.35 }, // Dividends >= 35%
        { type: 'shares_owned', operator: '>=', value: 0.8 },    // Own >= 80% of shares
        { type: 'profit_margin', operator: '>=', value: 0.2 },    // Profit margin >= 20%
        { type: 'total_value', operator: '>=', value: 10e12 }    // Total value >= 10T
    ]
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `📈 Starting Stock Manager (self-termination: ${STOCK_CONFIG.selfTerminate ? 'ENABLED' : 'DISABLED'})`, false, 'info');
    
    while (true) {
        try {
            // Fix #1, #8: Use cached data instead of direct API call
            const corp = await getCachedCorpData(ns);
            if (!corp) { await ns.sleep(10000); continue; }

            // --- SELF-TERMINATION CHECK ---
            if (STOCK_CONFIG.selfTerminate) {
                // Fix #7: Standardized Termination - direct boolean check
                const shouldExit = await checkSelfTerminationConditions(ns, corp);
                if (shouldExit) {
                    log(ns, "Stock conditions met or error occurred. Terminating module.", false, 'success');
                    return;
                }
            }

            // --- STOCK MANAGEMENT ---
            await manageStocks(ns, corp);
            
            // --- DIVIDEND MANAGEMENT ---
            await manageDividends(ns, corp);
            
        } catch (e) {
            log(ns, `📈 Stock error: ${e}`, false, 'error');
        }
        
        await asleep(ns, STOCK_CONFIG.checkInterval);
    }
}

async function checkSelfTerminationConditions(ns, corp) {
    if (!STOCK_CONFIG.completionConditions || STOCK_CONFIG.completionConditions.length === 0) {
        return false; // Fix #7: Return boolean directly
    }
    
    try {
        for (const condition of STOCK_CONFIG.completionConditions) {
            const result = await evaluateStockCondition(ns, corp, condition);
            if (result.shouldTerminate) {
                return true; // Fix #7: Return boolean directly
            }
        }
        
        return false; // Fix #7: Return boolean directly
    } catch (e) {
        log(ns, `Error in stock termination check: ${e}`, false, 'error'); // Fix #6: Proper error logging
        return false; // Fix #7: Return boolean directly
    }
}

async function evaluateStockCondition(ns, corp, condition) {
    try {
        switch (condition.type) {
            case 'dividend_rate':
                return {
                    shouldTerminate: corp.dividendRate >= condition.value,
                    reason: `Dividends high enough (${(corp.dividendRate*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'shares_owned':
                const totalShares = corp.totalShares || 0;
                const maxShares = corp.numShares || 0;
                const ownedPercent = totalShares / maxShares;
                
                return {
                    shouldTerminate: ownedPercent >= condition.value,
                    reason: `Sufficient shares owned (${(ownedPercent*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'profit_margin':
                // Simplified profit margin calculation with zero protection
                const profitPerShare = corp.sharePrice - (corp.issuedShares > 0 ? corp.shareSalePrice : 0);
                const margin = corp.sharePrice > 0 ? profitPerShare / corp.sharePrice : 0;
                
                return {
                    shouldTerminate: margin >= condition.value,
                    reason: `Profit margin high enough (${(margin*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'total_value':
                const totalValue = corp.sharePrice * corp.totalShares;
                return {
                    shouldTerminate: totalValue >= condition.value,
                    reason: `Total share value high enough (${formatMoney(totalValue)} >= ${formatMoney(condition.value)})`
                };
                
            default:
                return { shouldTerminate: false, reason: 'Unknown condition' };
        }
    } catch (e) {
        return { shouldTerminate: false, reason: `Error: ${e}` };
    }
}

async function manageStocks(ns, corp) {
    try {
        const totalStock = corp.totalShares || 0;
        const maxStock = corp.numShares || 0;
        const currentHolding = totalStock;
        const maxHolding = maxStock * STOCK_CONFIG.maxHoldingPercent;
        
        // Buy shares (if we have available funds)
        if (corp.funds > STOCK_CONFIG.buyThreshold && currentHolding < maxHolding) {
            const toBuy = Math.min(
                Math.floor((corp.funds * 0.1) / corp.sharePrice), // 10% of available funds
                maxHolding - currentHolding
            );
            
            if (toBuy > 0) {
                await cc(ns, 'ns.corporation.buyBackShares(ns.args[0], ns.args[1])', [toBuy]);
                log(ns, `SUCCESS: Bought ${toBuy} shares (${formatMoney(toBuy * corp.sharePrice)})`, false, 'success');
            }
        }
        
        // Sell shares (if we have profit)
        const profitPerShare = corp.sharePrice - (corp.issuedShares > 0 ? corp.shareSalePrice : 0);
        if (profitPerShare > 0 && currentHolding > maxStock * 0.8) {
            const toSell = Math.floor(currentHolding * 0.2); // Sell 20%
            
            if (toSell > 0 && profitPerShare > corp.sharePrice * STOCK_CONFIG.minProfitMargin) {
                await cc(ns, 'ns.corporation.sellShares(ns.args[0])', [toSell]);
                log(ns, `SUCCESS: Sold ${toSell} shares. Profit: ${formatMoney(profitPerShare * toSell)}`, false, 'success');
            }
        }
        
    } catch (e) {
        log(ns, `ERROR in ${ns.getScriptName()} managing stock sales: ${e.message || e}`, false, 'error');
    }
}

async function manageDividends(ns, corp) {
    try {
        // Fix: Use correct API - setDividendPercent(percent) where percent is 0-100
        const targetDividendPercent = STOCK_CONFIG.dividendTarget * 100; // Convert 0.3 → 30
        const currentDividendPercent = (corp.dividendRate || 0) * 100;
        
        log(ns, `DEBUG: Dividend check - target=${targetDividendPercent.toFixed(1)}%, current=${currentDividendPercent.toFixed(1)}%, diff=${Math.abs(currentDividendPercent - targetDividendPercent).toFixed(1)}%`, false, 'info');
        
        if (Math.abs(currentDividendPercent - targetDividendPercent) > 5) { // Difference > 5%
            log(ns, `INFO: Calling setOperatingDividends with ${targetDividendPercent.toFixed(0)} (0-100 range expected)`, false, 'info');
            await setOperatingDividends(ns, targetDividendPercent, 'Adjusting dividend rate for stock market stability');
            log(ns, `INFO: Setting dividend rate to ${targetDividendPercent.toFixed(0)}% (from ${currentDividendPercent.toFixed(0)}%)`, false, 'info');
        }
        
        // Note: Dividends are paid automatically based on the percentage set.
        // No need to call issueDividends - that function doesn't exist in the API.
        
    } catch (e) {
        log(ns, `ERROR in ${ns.getScriptName()} managing dividends: ${e.message || e}`, false, 'error');
    }
}
