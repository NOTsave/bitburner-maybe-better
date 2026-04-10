import { getNsDataThroughFile, log, formatMoney, getCachedCorpData, asleep } from '../helpers.js'

// Product Module Configuration
const PRODUCT_CONFIG = {
    maxProducts: 3,              // Maximum 3 products
    minInvestment: 1e9,          // Minimum investment 1B
    maxInvestment: 2e12,          // Maximum investment 2T
    investmentPercent: 0.01,        // 1% of funds for investment (guide: exponent is only 0.1)
    developmentCheckInterval: 3000,  // Check every 3s
    sellDelay: 5000,              // 5s delay after completion
    profitMargin: 0.7              // Minimum profit margin to continue
};

// Target cities for products
const HOME_CITIES = {
    'TobacDiv': 'Sector-12',
    'AgriDiv': 'Sector-12'
};

async function cc(ns, cmd, args = []) { 
    return await getNsDataThroughFile(ns, cmd, null, args); 
}

export async function main(ns) {
    log(ns, `📦 Starting Product Manager (max ${PRODUCT_CONFIG.maxProducts} products)`, false, 'info');
    
    while (true) {
        try {
            // Fix #1, #8: Use cached data instead of direct API call
            const corp = await getCachedCorpData(ns);
            if (!corp) { await ns.sleep(10000); continue; }

            // --- TOBACCO PRODUCTS MANAGEMENT ---
            await manageTobaccoProducts(ns, corp);
            
        } catch (e) {
            log(ns, `📦 Product error: ${e}`, false, 'error');
        }
        
        await asleep(ns, 10000); // Products check every 10s
    }
}

async function manageTobaccoProducts(ns, corp) {
    // Fix #2: Dynamic Detection - use industry type instead of hardcoded names
    const tobaccoDiv = corp.divisions.find(d => d.type === 'Tobacco');
    if (!tobaccoDiv) {
        log(ns, "Tobacco division not found yet. Skipping product management.", false, 'info');
        return;
    }
    
    const homeCity = 'Sector-12'; // Default city, could be made dynamic
    
    try {
        const products = tobaccoDiv.products || [];
        
        // --- 1. MANAGE EXISTING PRODUCTS ---
        await sellCompletedProducts(ns, tobaccoDiv.name, homeCity, products);
        
        // --- 2. DEVELOP NEW PRODUCTS ---
        await developNewProducts(ns, corp, tobaccoDiv.name, homeCity, products);
        
        // --- 3. MANAGE WAREHOUSES ---
        await manageWarehouses(ns, tobaccoDiv.name, corp);
        
    } catch (e) {
        log(ns, `💥 Tobacco product error: ${e}`, false, 'error');
    }
}

async function sellCompletedProducts(ns, divName, homeCity, products) {
    for (const productName of products) {
        try {
            const product = await cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', 
                [divName, homeCity, productName]);
            
            if (product && product.developmentProgress >= 100 && !product.sName) {
                // Product is complete and not yet selling -> set up sales
                await cc(ns, "ns.corporation.sellProduct(ns.args[0], ns.args[1], ns.args[2], 'MAX', 'MP', true)", 
                    [divName, homeCity, productName]);
                
                // Activate Market-TA.II for maximum profit
                if (await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', ['Market-TA.II'])) {
                    await cc(ns, 'ns.corporation.setProductMarketTA2(ns.args[0], ns.args[1], true)', 
                        [divName, productName]);
                }
                
                log(ns, `SUCCESS: ${productName} launched to market (Rating: ${product.rat?.toFixed(1) || 'N/A'})`, false, 'success');
            }
        } catch (e) {
            // Fix Priority 1: Error logging instead of silent catch
            log(ns, `ERROR in ${ns.getScriptName()} selling product ${productName}: ${e.message || e}`, false, 'error');
        }
    }
}

async function developNewProducts(ns, corp, divName, homeCity, products) {
    // Fix #4: Correct Async Filtering Logic
    const productData = await Promise.all(products.map(p => 
        cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', 
            [divName, homeCity, p]).catch(() => ({ name: p, developmentProgress: 100 }))
    ));

    // Now filter synchronously on resolved data
    const incompleteProducts = productData.filter(p => p.developmentProgress < 100);

    if (incompleteProducts.length > 0) {
        log(ns, `Focusing on ${incompleteProducts.length} products in development.`);
    }
    
    // If we have max products or all are complete, develop new one
    if (products.length < PRODUCT_CONFIG.maxProducts || incompleteProducts.length === 0) {
        await createNewProduct(ns, corp, divName, homeCity, products);
    } else {
        log(ns, `📊 Development in progress (${incompleteProducts.length}/${PRODUCT_CONFIG.maxProducts} active)`, false, 'info');
    }
}

async function createNewProduct(ns, corp, divName, homeCity, products) {
    // If we have max products, remove worst one
    if (products.length >= PRODUCT_CONFIG.maxProducts) {
        await removeWorstProduct(ns, divName, homeCity, products);
        await asleep(ns, 2000); // Allow time for processing
    }
    
    // Calculate investment
    const investment = calculateInvestment(corp.funds);
    const productName = `Cig-v${Date.now() % 1000}`; // Unique number
    
    try {
        await cc(ns, 'ns.corporation.makeProduct(ns.args[0], ns.args[1], ns.args[2], ns.args[3], ns.args[3])', 
            [divName, homeCity, productName, investment, investment]);
        
        log(ns, `🚀 Developing ${productName} (Investment: ${formatMoney(investment)} - ${(investment/corp.funds*100).toFixed(1)}%)`, false, 'success');
        
        // Fix #2: Wait for development completion
        await waitForDevelopment(ns, divName, homeCity, productName);
        
    } catch (e) {
        log(ns, `ERROR in ${ns.getScriptName()} developing ${productName}: ${e.message || e}`, false, 'error');
    }
}

async function removeWorstProduct(ns, divName, homeCity, products) {
    let worstProduct = null;
    let worstRating = Infinity;
    
    for (const productName of products) {
        try {
            const product = await cc(ns, 'ns.corporation.getProduct(ns.args[0], ns.args[1], ns.args[2])', 
                [divName, homeCity, productName]);
            
            // Skip products in development
            if (product && product.developmentProgress >= 100) {
                const rating = product.rat || 0;
                if (rating < worstRating) {
                    worstRating = rating;
                    worstProduct = productName;
                }
            }
            
        } catch (e) {
            // Fix #1, #4: Standardized error logging
            log(ns, `ERROR in ${ns.getScriptName()} evaluating product ${productName}: ${e.message || e}`, false, 'error');
        }
    }
    
    if (worstProduct) {
        try {
            await cc(ns, 'ns.corporation.discontinueProduct(ns.args[0], ns.args[1])', [divName, worstProduct]);
            log(ns, `🗑️ Discontinued worst product: ${worstProduct}`, false, 'success');
        } catch (e) {
            // Fix #1, #4: Standardized error logging
            log(ns, `ERROR in ${ns.getScriptName()} discontinuing product ${worstProduct}: ${e.message || e}`, false, 'error');
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
                log(ns, `ERROR: Product ${productName} not found`, false, 'error');
                break;
            }
            
            if (product.developmentProgress >= 100) {
                log(ns, `SUCCESS: ${productName} complete (${product.developmentProgress.toFixed(1)}%)`, false, 'success');
                
                // Delay before setting up sales
                await asleep(ns, PRODUCT_CONFIG.sellDelay);
                
                // Set up sales in all cities
                await setupProductSales(ns, divName, productName);
                break;
            }
            
            const pct = Math.floor(product.developmentProgress / 10) * 10;
            if (pct !== lastPct) {
                log(ns, `📈 ${productName}: ${product.developmentProgress.toFixed(1)}%`, false, 'info');
                lastPct = pct;
            }
            
        } catch (e) {
            log(ns, `ERROR in ${ns.getScriptName()} tracking development for ${productName}: ${e.message || e}`, false, 'error');
        }
        
        await asleep(ns, PRODUCT_CONFIG.developmentCheckInterval);
    }
}

async function setupProductSales(ns, divName, productName) {
    for (const city of ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven']) {
        try {
            await cc(ns, "ns.corporation.sellProduct(ns.args[0], ns.args[1], ns.args[2], 'MAX', 'MP', true)", 
                [divName, city, productName]);
            
            // Activate Market-TA for better prices
            if (await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', ['Market-TA.I'])) {
                await cc(ns, 'ns.corporation.setMarketTA1(ns.args[0], ns.args[1], true)', [divName, productName]);
            }
            
            if (await cc(ns, 'ns.corporation.hasUnlock(ns.args[0])', ['Market-TA.II'])) {
                await cc(ns, 'ns.corporation.setMarketTA2(ns.args[0], ns.args[1], true)', [divName, productName]);
            }
            
        } catch (e) {
            log(ns, `ERROR in ${ns.getScriptName()} setting up sales for ${productName} in ${city}: ${e.message || e}`, false, 'error');
        }
    }
}

async function manageWarehouses(ns, divName, corp) {
    try {
        if (!corp) corp = await getCachedCorpData(ns);
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
                        log(ns, `SUCCESS: Warehouse upgrade ${city} (${(warehouse.sizeUsed/warehouse.size*100).toFixed(1)}% full)`, false, 'info');
                    }
                }
            } catch (e) {
                log(ns, `ERROR in ${ns.getScriptName()} managing warehouse for ${divName}/${city}: ${e.message || e}`, false, 'error');
            }
        }
    } catch (e) {
        log(ns, `ERROR in ${ns.getScriptName()} managing warehouses for ${divName}: ${e.message || e}`, false, 'error');
    }
}

function calculateInvestment(availableFunds) {
    // Dynamic investment based on corporation size
    // Per corp guide: DesignInvestment and AdvertisingInvestment have exponent 0.1
    // So 1% of funds is sufficient - spending more has diminishing returns
    let investment;
    
    if (availableFunds > 1e12) { // Late game: 1% max 2T
        investment = Math.min(availableFunds * PRODUCT_CONFIG.investmentPercent, PRODUCT_CONFIG.maxInvestment);
    } else if (availableFunds > 500e9) { // Mid game: 1% max 500B
        investment = Math.min(availableFunds * PRODUCT_CONFIG.investmentPercent, 500e9);
    } else { // Early game: 1% max 100B
        investment = Math.min(availableFunds * PRODUCT_CONFIG.investmentPercent, 100e9);
    }
    
    return Math.max(investment, PRODUCT_CONFIG.minInvestment);
}

