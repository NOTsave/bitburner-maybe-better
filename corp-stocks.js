import { getNsDataThroughFile, log } from './helpers.js'

// Konfigurace akciového modulu
const STOCK_CONFIG = {
    checkInterval: 60000,        // Kontrola každých 60s
    buyThreshold: 1e12,         // Kupovat při 1T+ volných prostředků
    sellThreshold: 100e9,        // Prodávat při 100B+ zisku
    maxHoldingPercent: 0.4,     // Max 40% akcií
    minProfitMargin: 0.1,       // Min 10% profit margin
    dividendTarget: 0.3,           // Cílová dividendová sazba 30%
    selfTerminate: true,           // Samovypínání po dosažení cílů
    completionConditions: [        // Podmínky pro samovypínání
        { type: 'dividend_rate', operator: '>=', value: 0.35 }, // Dividendy >= 35%
        { type: 'shares_owned', operator: '>=', value: 0.8 },    // Vlastníme >= 80% akcií
        { type: 'profit_margin', operator: '>=', value: 0.2 },    // Profit margin >= 20%
        { type: 'total_value', operator: '>=', value: 10e12 }    // Celková hodnota >= 10T
    ]
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `📈 Spouštím Stock Manager (samovypínání: ${STOCK_CONFIG.selfTerminate ? 'ZAPNUTO' : 'VYPNUTO'})`, false, 'info');
    
    while (true) {
        try {
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            if (!corp) { await ns.sleep(10000); continue; }

            // --- KONTROLA SAMOVYPÍNÁNÍ ---
            if (STOCK_CONFIG.selfTerminate) {
                const shouldTerminate = await checkSelfTerminationConditions(ns, corp);
                if (shouldTerminate.terminate) {
                    log(ns, `🎯 Stock management dokončen: ${shouldTerminate.reason}`, false, 'success');
                    return; // Ukonči modul
                }
            }

            // --- SPRÁVA AKCIÍ ---
            await manageStocks(ns, corp);
            
            // --- SPRÁVA DIVIDEND ---
            await manageDividends(ns, corp);
            
        } catch (e) {
            log(ns, `📈 Akciová chyba: ${e}`, false, 'error');
        }
        
        await ns.sleep(STOCK_CONFIG.checkInterval);
    }
}

async function checkSelfTerminationConditions(ns, corp) {
    if (!STOCK_CONFIG.completionConditions || STOCK_CONFIG.completionConditions.length === 0) {
        return { terminate: false, reason: 'Samovypínání vypnuto' };
    }
    
    try {
        for (const condition of STOCK_CONFIG.completionConditions) {
            const result = await evaluateStockCondition(ns, corp, condition);
            if (result.shouldTerminate) {
                return result;
            }
        }
        
        return { terminate: false, reason: 'Pokračuji ve stock managementu' };
    } catch (e) {
        return { terminate: false, reason: `Chyba v kontrole: ${e}` };
    }
}

async function evaluateStockCondition(ns, corp, condition) {
    try {
        switch (condition.type) {
            case 'dividend_rate':
                return {
                    shouldTerminate: corp.dividendRate >= condition.value,
                    reason: `Dividendy dostatečně vysoké (${(corp.dividendRate*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'shares_owned':
                const totalShares = corp.totalShares || 0;
                const maxShares = corp.numShares || 0;
                const ownedPercent = totalShares / maxShares;
                
                return {
                    shouldTerminate: ownedPercent >= condition.value,
                    reason: `Dostatečně vlastněno akcií (${(ownedPercent*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'profit_margin':
                // Zjednodušený výpočet profit margin
                const profitPerShare = corp.sharePrice - (corp.issuedShares > 0 ? corp.shareSalePrice : 0);
                const margin = profitPerShare / corp.sharePrice;
                
                return {
                    shouldTerminate: margin >= condition.value,
                    reason: `Profit margin dostatečně vysoký (${(margin*100).toFixed(1)}% >= ${(condition.value*100).toFixed(1)}%)`
                };
                
            case 'total_value':
                const totalValue = corp.sharePrice * corp.totalShares;
                return {
                    shouldTerminate: totalValue >= condition.value,
                    reason: `Celková hodnota akcií dostatečně vysoká (${formatMoney(totalValue)} >= ${formatMoney(condition.value)})`
                };
                
            default:
                return { terminate: false, reason: 'Neznámá podmínka' };
        }
    } catch (e) {
        return { terminate: false, reason: `Chyba: ${e}` };
    }
}

async function manageStocks(ns, corp) {
    try {
        const totalStock = corp.totalShares || 0;
        const maxStock = corp.numShares || 0;
        const currentHolding = totalStock;
        const maxHolding = maxStock * STOCK_CONFIG.maxHoldingPercent;
        
        // Kupování akcií (pokud máme volné prostředky)
        if (corp.funds > STOCK_CONFIG.buyThreshold && currentHolding < maxHolding) {
            const toBuy = Math.min(
                Math.floor((corp.funds * 0.1) / corp.sharePrice), // 10% volných prostředků
                maxHolding - currentHolding
            );
            
            if (toBuy > 0) {
                await cc(ns, 'ns.corporation.buyBackShares(ns.args[0], ns.args[1])', [toBuy]);
                log(ns, `📈 Koupil jsem ${toBuy} akcií (${formatMoney(toBuy * corp.sharePrice)})`, false, 'success');
            }
        }
        
        // Prodej akcií (pokud máme zisk)
        const profitPerShare = corp.sharePrice - (corp.issuedShares > 0 ? corp.shareSalePrice : 0);
        if (profitPerShare > 0 && currentHolding > maxStock * 0.8) {
            const toSell = Math.floor(currentHolding * 0.2); // Prodej 20%
            
            if (toSell > 0 && profitPerShare > corp.sharePrice * STOCK_CONFIG.minProfitMargin) {
                await cc(ns, 'ns.corporation.sellShares(ns.args[0])', [toSell]);
                log(ns, `📉 Prodal jsem ${toSell} akcií (zisk: ${formatMoney(profitPerShare * toSell)})`, false, 'success');
            }
        }
        
    } catch (e) {
        log(ns, `💥 Akciová chyba: ${e}`, false, 'error');
    }
}

async function manageDividends(ns, corp) {
    try {
        // Cílová dividendová sazba
        const targetDividend = STOCK_CONFIG.dividendTarget;
        const currentDividend = corp.dividendRate || 0;
        
        if (Math.abs(currentDividend - targetDividend) > 0.05) { // Rozdíl > 5%
            await cc(ns, 'ns.corporation.setDividendPolicy(ns.args[0], ns.args[1])', [targetDividend, true]);
            log(ns, `💰 Nastavuji dividendy na ${(targetDividend*100).toFixed(0)}% (z ${currentDividend*100}%)`, false, 'success');
        }
        
        // Automatické vyplácení dividend
        if (corp.dividendEarnings > 0) {
            await cc(ns, 'ns.corporation.issueDividends(ns.args[0])', [corp.dividendEarnings]);
            log(ns, `💰 Vyplácím dividendy: ${formatMoney(corp.dividendEarnings)}`, false, 'success');
        }
        
    } catch (e) {
        log(ns, `💥 Dividendová chyba: ${e}`, false, 'error');
    }
}

function formatMoney(amount) {
    if (amount >= 1e12) return `${(amount / 1e12).toFixed(2)}T`;
    if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return `$${amount.toFixed(2)}`;
}
