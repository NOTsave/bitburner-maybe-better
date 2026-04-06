import { getNsDataThroughFile, log } from './helpers.js'

// Konfigurace produktového modulu
const PRODUCT_CONFIG = {
    maxProducts: 3,              // Maximální počet produktů
    minInvestment: 1e9,          // Minimální investice 1B
    maxInvestment: 2e12,          // Maximální investice 2T
    investmentPercent: 0.02,        // 2% fondů na investici
    developmentCheckInterval: 3000,  // Kontrola každých 3s
    sellDelay: 5000,              // Prodlev 5s po dokončení
    profitMargin: 0.7              // Minimální profit margin pro pokračování
};

// Cílová města pro produkty
const HOME_CITIES = {
    'TobacDiv': 'Sector-12',
    'AgriDiv': 'Sector-12'
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `📦 Spouštím Product Manager (max ${PRODUCT_CONFIG.maxProducts} produktů)`, false, 'info');
    
    while (true) {
        try {
            const corp = await cc(ns, 'ns.corporation.getCorporation()');
            if (!corp) { await ns.sleep(10000); continue; }

            // --- SPRÁVA TOBACCO PRODUKTŮ ---
            await manageTobaccoProducts(ns, corp);
            
        } catch (e) {
            log(ns, `📦 Produktová chyba: ${e}`, false, 'error');
        }
        
        await ns.sleep(10000); // Produkty stačí kontrolovat každých 10s
    }
}

async function manageTobaccoProducts(ns, corp) {
    const divName = 'TobacDiv';
    const homeCity = HOME_CITIES[divName];
    
    try {
        const division = await cc(ns, 'ns.corporation.getDivision(ns.args[0])', [divName]);
        if (!division) return;
        
        const products = division.products || [];
        
        // --- 1. SPRÁVA STÁVAJÍCÍCH PRODUKTŮ ---
        await sellCompletedProducts(ns, divName, homeCity, products);
        
        // --- 2. VÝVOJ NOVÝCH PRODUKTŮ ---
        await developNewProducts(ns, corp, divName, homeCity, products);
        
        // --- 3. SPRÁVA SKLADŮ ---
        await manageWarehouses(ns, divName);
        
    } catch (e) {
        log(ns, `💥 Tobacco produktová chyba: ${e}`, false, 'error');
    }
}

async function sellCompletedProducts(ns, divName, homeCity, products) {
    for (const productName of products) {
        try {
            const product = await cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', 
                [divName, homeCity, productName]);
            
            if (product && product.developmentProgress >= 100 && !product.sName) {
                // Produkt je hotový a ještě se neprodává -> nastav prodej
                await cc(ns, "ns.corporation.sellProduct(ns.args[0], ns.args[1], ns.args[2], 'MAX', 'MP', true)", 
                    [divName, homeCity, productName]);
                
                // Aktivuj Market-TA.II pro maximální profit
                if (await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', ['Market-TA.II'])) {
                    await cc(ns, 'ns.corporation.setProductMarketTA2(ns.args[0], ns.args[1], true)', 
                        [divName, productName]);
                }
                
                log(ns, `💰 ${productName} uveden na trh (Rating: ${product.rat?.toFixed(1) || 'N/A'})`, false, 'success');
            }
        } catch (_) {}
    }
}

async function developNewProducts(ns, corp, divName, homeCity, products) {
    const incompleteProducts = products.filter(async p => {
        try {
            const product = await cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', 
                [divName, homeCity, p]);
            return product && product.developmentProgress < 100;
        } catch (_) { return true; }
    });
    
    // Pokud máme méně než max produktů nebo všechny jsou hotové, vyvíjej nový
    if (products.length < PRODUCT_CONFIG.maxProducts || incompleteProducts.length === 0) {
        await createNewProduct(ns, corp, divName, homeCity, products);
    } else {
        log(ns, `📊 Vývoj probíhá (${incompleteProducts.length}/${PRODUCT_CONFIG.maxProducts} aktivních)`, false, 'info');
    }
}

async function createNewProduct(ns, corp, divName, homeCity, products) {
    // Pokud máme max produktů, zRUŠ nejhORŠÍ
    if (products.length >= PRODUCT_CONFIG.maxProducts) {
        await removeWorstProduct(ns, divName, homeCity, products);
        await ns.sleep(2000); // Dej čas na zpracování
    }
    
    // VYPOČÍT INVESTICI
    const investment = calculateInvestment(corp.funds);
    const productName = `Cig-v${Date.now() % 1000}`; // Unikátní číslo
    
    try {
        await cc(ns, 'ns.corporation.makeProduct(ns.args[0], ns.args[1], ns.args[2], ns.args[3], ns.args[3])', 
            [divName, homeCity, productName, investment, investment]);
        
        log(ns, `🚀 Vyvíjím ${productName} (Investice: ${formatMoney(investment)} - ${(investment/corp.funds*100).toFixed(1)}%)`, false, 'success');
        
        // Čekej na dokončení vývoje
        await waitForDevelopment(ns, divName, homeCity, productName);
        
    } catch (e) {
        log(ns, `💥 Vývoj ${productName} selhal: ${e}`, false, 'error');
    }
}

async function removeWorstProduct(ns, divName, homeCity, products) {
    let worstProduct = null;
    let worstRating = Infinity;
    
    for (const productName of products) {
        try {
            const product = await cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', 
                [divName, homeCity, productName]);
            
            // Přeskočit produkty ve vývoji
            if (product && product.developmentProgress >= 100) {
                const rating = product.rat || 0;
                if (rating < worstRating) {
                    worstRating = rating;
                    worstProduct = productName;
                }
            }
        } catch (_) {}
    }
    
    if (worstProduct) {
        try {
            await cc(ns, 'ns.corporation.discontinueProduct(ns.args[0], ns.args[1])', [divName, worstProduct]);
            log(ns, `🗑️ Ruším ${worstProduct} (Rating: ${worstRating.toFixed(1)})`, false, 'warning');
        } catch (e) {
            log(ns, `💥 Rušení ${worstProduct} selhalo: ${e}`, false, 'error');
        }
    }
}

async function waitForDevelopment(ns, divName, homeCity, productName) {
    let lastPct = -1;
    
    while (true) {
        try {
            const product = await cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', 
                [divName, homeCity, productName]);
            
            if (!product) {
                log(ns, `❌ Produkt ${productName} nenalezen`, false, 'error');
                break;
            }
            
            if (product.developmentProgress >= 100) {
                log(ns, `✅ ${productName} hotov (${product.developmentProgress.toFixed(1)}%)`, false, 'success');
                
                // Prodlev před nastavením prodeje
                await ns.sleep(PRODUCT_CONFIG.sellDelay);
                
                // Nastav prodej ve všech městech
                await setupProductSales(ns, divName, productName);
                break;
            }
            
            const pct = Math.floor(product.developmentProgress / 10) * 10;
            if (pct !== lastPct) {
                log(ns, `📈 ${productName}: ${product.developmentProgress.toFixed(1)}%`, false, 'info');
                lastPct = pct;
            }
            
        } catch (_) {}
        
        await ns.sleep(PRODUCT_CONFIG.developmentCheckInterval);
    }
}

async function setupProductSales(ns, divName, productName) {
    for (const city of ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven']) {
        try {
            await cc(ns, "ns.corporation.sellProduct(ns.args[0], ns.args[1], ns.args[2], 'MAX', 'MP', true)", 
                [divName, city, productName]);
            
            // Aktivuj Market-TA pro lepší ceny
            if (await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', ['Market-TA.I'])) {
                await cc(ns, 'ns.corporation.setMarketTA1(ns.args[0], ns.args[1], true)', [divName, productName]);
            }
            
            if (await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', ['Market-TA.II'])) {
                await cc(ns, 'ns.corporation.setMarketTA2(ns.args[0], ns.args[1], true)', [divName, productName]);
            }
            
        } catch (_) {}
    }
}

async function manageWarehouses(ns, divName) {
    try {
        const corp = await cc(ns, 'ns.corporation.getCorporation()');
        if (!corp) return;
        
        const cities = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];
        
        for (const city of cities) {
            try {
                const warehouse = await cc(ns, 'ns.corporation.getWarehouse(ns.args[0], ns.args[1])', [divName, city]);
                if (warehouse && warehouse.sizeUsed > warehouse.size * 0.9) {
                    const upgradeCost = await cc(ns, 'ns.corporation.getUpgradeWarehouseCost(ns.args[0], ns.args[1])', 
                        [divName, city]);
                    
                    if (corp.funds > upgradeCost * 2) {
                        await cc(ns, 'ns.corporation.upgradeWarehouse(ns.args[0], ns.args[1])', [divName, city]);
                        log(ns, `📦 Upgrade skladu ${city} (${(warehouse.sizeUsed/warehouse.size*100).toFixed(1)}% plný)`, false, 'info');
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
}

function calculateInvestment(availableFunds) {
    // Dynamická investice podle velikosti korporace
    let investment;
    
    if (availableFunds > 1e12) { // Late game: 2% max 2T
        investment = Math.min(availableFunds * PRODUCT_CONFIG.investmentPercent, PRODUCT_CONFIG.maxInvestment);
    } else if (availableFunds > 500e9) { // Mid game: 2% max 500B
        investment = Math.min(availableFunds * PRODUCT_CONFIG.investmentPercent, 500e9);
    } else { // Early game: 2% max 100B
        investment = Math.min(availableFunds * PRODUCT_CONFIG.investmentPercent, 100e9);
    }
    
    return Math.max(investment, PRODUCT_CONFIG.minInvestment);
}

function formatMoney(amount) {
    if (amount >= 1e12) return `${(amount / 1e12).toFixed(2)}T`;
    if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return `$${amount.toFixed(2)}`;
}
