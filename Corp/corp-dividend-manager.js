import { getNsDataThroughFile, runCommand, log, TIMEOUT } from '../helpers.js'

/**
 * Standardized dividend management for corporation
 * Provides unified interface for setting dividend percentages across all modules
 */

const DIVIDEND_CONFIG = {
    maxRetries: 3,
    retryDelay: TIMEOUT,
    validationDelay: TIMEOUT * 2 // Wait for dividend changes to take effect
};

/**
 * Safely set dividend percentage with validation and retry logic
 * @param {NS} ns - Netscript namespace
 * @param {number} targetPercent - Target dividend percentage (0-100)
 * @param {string} reason - Reason for the dividend change (for logging)
 * @returns {Promise<boolean>} Success status
 */
export async function setDividendPercentage(ns, targetPercent, reason = 'Unknown') {
    if (typeof targetPercent !== 'number' || targetPercent < 0 || targetPercent > 100) {
        log(ns, `ERROR: Invalid dividend percentage: ${targetPercent}. Must be between 0-100.`, false, 'error');
        return false;
    }

    let attempts = 0;
    
    while (attempts < DIVIDEND_CONFIG.maxRetries) {
        try {
            // Check current dividend rate
            const currentDividendRate = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation().dividendRate');
            const currentPercent = (currentDividendRate || 0) * 100;
            
            // Only proceed if change is needed
            if (Math.abs(currentPercent - targetPercent) < 0.1) {
                log(ns, `INFO: Dividend already at target ${targetPercent.toFixed(1)}% (${reason})`, false, 'info');
                return true;
            }

            // Set the dividend percentage
            await runCommand(ns, `ns.corporation.issueDividends(ns.args[0] / 100)`, '/Temp/dividend-adjust.js', [targetPercent]);
            
            // Verify the change took effect
            await ns.sleep(DIVIDEND_CONFIG.validationDelay);
            const newRate = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation().dividendRate');
            const newPercent = (newRate || 0) * 100;
            
            if (Math.abs(newPercent - targetPercent) < 0.1) {
                log(ns, `SUCCESS: Dividend set to ${newPercent.toFixed(1)}% (was ${currentPercent.toFixed(1)}%) - ${reason}`, false, 'success');
                return true;
            } else {
                log(ns, `WARN: Dividend setting verification failed. Expected ${targetPercent}%, got ${newPercent}%`, false, 'warning');
            }
            
        } catch (error) {
            log(ns, `ERROR: Failed to set dividend to ${targetPercent}% (attempt ${attempts + 1}): ${error.message || error}`, false, 'error');
        }
        
        attempts++;
        if (attempts < DIVIDEND_CONFIG.maxRetries) {
            await ns.sleep(DIVIDEND_CONFIG.retryDelay);
        }
    }
    
    log(ns, `ERROR: Failed to set dividend to ${targetPercent}% after ${DIVIDEND_CONFIG.maxRetries} attempts`, false, 'error');
    return false;
}

/**
 * Get current dividend percentage
 * @param {NS} ns - Netscript namespace
 * @returns {Promise<number>} Current dividend percentage (0-100)
 */
export async function getCurrentDividendPercentage(ns) {
    try {
        const rate = await getNsDataThroughFile(ns, 'ns.corporation.getCorporation().dividendRate');
        return (rate || 0) * 100;
    } catch (error) {
        log(ns, `ERROR: Failed to get current dividend rate: ${error.message || error}`, false, 'error');
        return 0;
    }
}

/**
 * Set dividend to maximum (100%) - typically used before resets
 * @param {NS} ns - Netscript namespace
 * @param {string} reason - Reason for maximizing dividends
 * @returns {Promise<boolean>} Success status
 */
export async function maximizeDividends(ns, reason = 'Final payout before reset') {
    return await setDividendPercentage(ns, 100, reason);
}

/**
 * Set dividend to optimal operating level (typically 30-35%)
 * @param {NS} ns - Netscript namespace
 * @param {number} targetPercent - Target operating dividend percentage
 * @param {string} reason - Reason for dividend adjustment
 * @returns {Promise<boolean>} Success status
 */
export async function setOperatingDividends(ns, targetPercent = 35, reason = 'Optimal operations') {
    return await setDividendPercentage(ns, targetPercent, reason);
}
