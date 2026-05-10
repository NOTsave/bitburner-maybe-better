import { log, getNsDataThroughFile } from './helpers.js';
import { checkCorpAPI, getCachedDivision, updateCorpState, CorpState, getProfitabilitySummary, logCorpState } from './corp-helpers.js';

/**
 * Corp API Test Harness
 * Validates Corporation API functionality and provides debugging information
 * 
 * Usage: run corp-test-harness.js [--test-api] [--test-cache] [--test-state] [--test-profit] [--debug]
 */

const argsSchema = [
    ['test-api', false], // Test basic Corp API functions
    ['test-cache', false], // Test division caching
    ['test-state', false], // Test state machine
    ['test-profit', false], // Test profitability calculations
    ['debug', false], // Enable debug logging to file
    ['verbose', false], // Verbose output
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return;

    // Check API availability first
    if (!checkCorpAPI(ns)) {
        return;
    }

    log(ns, "🏢 Starting Corp Test Harness...", true, "info");

    try {
        // Test 1: Basic API connectivity
        if (options['test-api']) {
            await testBasicAPI(ns, options.verbose);
        }

        // Test 2: Division caching
        if (options['test-cache']) {
            await testDivisionCache(ns, options.verbose);
        }

        // Test 3: State machine
        if (options['test-state']) {
            await testStateMachine(ns, options.verbose);
        }

        // Test 4: Profitability calculations
        if (options['test-profit']) {
            await testProfitability(ns, options.verbose);
        }

        // Debug logging
        if (options.debug) {
            await performDebugLogging(ns);
        }

        log(ns, "✅ Corp Test Harness completed successfully!", true, "success");

    } catch (e) {
        log(ns, `❌ Test Harness failed: ${e.message || e}`, true, "error");
        if (options.verbose) {
            log(ns, `Stack trace: ${e.stack}`, true, "error");
        }
    }
}

/**
 * Test basic Corporation API functions
 */
async function testBasicAPI(ns, verbose = false) {
    log(ns, "📡 Testing basic Corp API...", true, "info");

    try {
        // Test corporation data
        const corp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
        if (!corp) {
            throw new Error("Failed to get corporation data");
        }

        log(ns, `✅ Corporation: ${corp.name}`, true, "success");
        log(ns, `   Funds: ${formatMoney(corp.funds)}`, true, "info");
        log(ns, `   Revenue: ${formatMoney(corp.revenue)}`, true, "info");
        log(ns, `   Divisions: ${corp.divisions?.length || 0}`, true, "info");

        if (verbose && corp.divisions) {
            for (const div of corp.divisions) {
                log(ns, `   - ${div.name} (${div.type})`, true, "info");
            }
        }

        // Test division data for each division
        if (corp.divisions && corp.divisions.length > 0) {
            for (const div of corp.divisions) {
                try {
                    const divData = await getNsDataThroughFile(ns, `ns.corporation.getDivision(ns.args[0])`, null, [div.name]);
                    log(ns, `✅ Division data: ${div.name}`, true, "success");
                    
                    if (verbose) {
                        log(ns, `   Revenue: ${formatMoney(divData.revenue)}`, true, "info");
                        log(ns, `   Expenses: ${formatMoney(divData.expenses)}`, true, "info");
                        log(ns, `   Cities: ${divData.cities?.length || 0}`, true, "info");
                    }
                } catch (e) {
                    log(ns, `❌ Failed to get division ${div.name}: ${e.message || e}`, true, "error");
                }
            }
        }

    } catch (e) {
        log(ns, `❌ API test failed: ${e.message || e}`, true, "error");
        throw e;
    }
}

/**
 * Test division caching functionality
 */
async function testDivisionCache(ns, verbose = false) {
    log(ns, "💾 Testing division cache...", true, "info");

    try {
        const corp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
        if (!corp.divisions || corp.divisions.length === 0) {
            log(ns, "⚠️ No divisions found for cache test", true, "warning");
            return;
        }

        const testDiv = corp.divisions[0];
        const divName = typeof testDiv === 'string' ? testDiv : testDiv.name;

        // Test cache miss (first call)
        const start1 = Date.now();
        const div1 = await getCachedDivision(ns, divName);
        const time1 = Date.now() - start1;

        // Test cache hit (second call)
        const start2 = Date.now();
        const div2 = await getCachedDivision(ns, divName);
        const time2 = Date.now() - start2;

        if (div1 && div2 && div1.name === div2.name) {
            log(ns, `✅ Cache test passed for ${divName}`, true, "success");
            log(ns, `   First call: ${time1}ms, Second call: ${time2}ms`, true, "info");
            
            if (time2 < time1) {
                log(ns, `   Cache speedup: ${time1 - time2}ms (${((time1 - time2) / time1 * 100).toFixed(1)}%)`, true, "success");
            }
        } else {
            throw new Error("Cache returned inconsistent results");
        }

    } catch (e) {
        log(ns, `❌ Cache test failed: ${e.message || e}`, true, "error");
        throw e;
    }
}

/**
 * Test state machine functionality
 */
async function testStateMachine(ns, verbose = false) {
    log(ns, "🔄 Testing state machine...", true, "info");

    try {
        const corp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
        
        // Test state transitions
        let currentState = CorpState.INIT;
        log(ns, `   Initial state: ${currentState}`, true, "info");

        // Test state update
        const newState = updateCorpState(ns, currentState, corp);
        log(ns, `   Updated state: ${newState}`, true, "info");

        if (verbose) {
            log(ns, `   Divisions: ${corp.divisions?.length || 0}`, true, "info");
            log(ns, `   Revenue: ${formatMoney(corp.revenue)}`, true, "info");
            
            if (corp.divisions) {
                const coreDivisions = corp.divisions.filter(d => 
                    ['Agriculture', 'Chemical', 'Tobacco'].includes(d.type)
                );
                log(ns, `   Core divisions: ${coreDivisions.length}`, true, "info");
            }
        }

        log(ns, `✅ State machine test completed`, true, "success");

    } catch (e) {
        log(ns, `❌ State machine test failed: ${e.message || e}`, true, "error");
        throw e;
    }
}

/**
 * Test profitability calculations
 */
async function testProfitability(ns, verbose = false) {
    log(ns, "💰 Testing profitability calculations...", true, "info");

    try {
        const corp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
        const profitability = getProfitabilitySummary(ns, corp);

        if (profitability.length === 0) {
            log(ns, "⚠️ No divisions found for profitability test", true, "warning");
            return;
        }

        log(ns, `✅ Profitability analysis for ${profitability.length} divisions:`, true, "success");

        for (const div of profitability) {
            log(ns, `   ${div.name} (${div.type}):`, true, "info");
            log(ns, `     Revenue: ${formatMoney(div.revenue)}`, true, "info");
            log(ns, `     Expenses: ${formatMoney(div.expenses)}`, true, "info");
            log(ns, `     Profit: ${formatMoney(div.profit)}`, true, "info");
            log(ns, `     ROI: ${(div.roi * 100).toFixed(2)}%`, true, "info");
            
            if (verbose) {
                log(ns, `     Cities: ${div.cityCount}, Products: ${div.productCount}`, true, "info");
            }
        }

        // Show most profitable division
        const mostProfitable = profitability[0];
        if (mostProfitable && mostProfitable.profit > 0) {
            log(ns, `🏆 Most profitable: ${mostProfitable.name} (${formatMoney(mostProfitable.profit)})`, true, "success");
        }

    } catch (e) {
        log(ns, `❌ Profitability test failed: ${e.message || e}`, true, "error");
        throw e;
    }
}

/**
 * Perform debug logging to file
 */
async function performDebugLogging(ns) {
    log(ns, "📝 Performing debug logging...", true, "info");

    try {
        const corp = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation()');
        logCorpState(ns, corp, "/Temp/corp-debug.txt");
        
        log(ns, "✅ Debug data written to /Temp/corp-debug.txt", true, "success");
        
        // Show file size
        const debugData = ns.read("/Temp/corp-debug.txt");
        log(ns, `   File size: ${(debugData.length / 1024).toFixed(1)}KB`, true, "info");

    } catch (e) {
        log(ns, `❌ Debug logging failed: ${e.message || e}`, true, "error");
        throw e;
    }
}

// Helper function for formatting money
function formatMoney(amount) {
    if (amount >= 1e12) return `$${(amount / 1e12).toFixed(2)}t`;
    if (amount >= 1e9) return `$${(amount / 1e9).toFixed(2)}b`;
    if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}m`;
    if (amount >= 1e3) return `$${(amount / 1e3).toFixed(2)}k`;
    return `$${amount.toFixed(2)}`;
}

// Import getConfiguration
function getConfiguration(ns, schema) {
    // Simple implementation - in real code this would be from helpers.js
    const flags = schema.reduce((acc, [name, defaultValue]) => {
        acc[name] = ns.args.includes(`--${name}`) ? true : defaultValue;
        return acc;
    }, {});
    return flags;
}
