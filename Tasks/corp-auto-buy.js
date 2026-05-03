/**
 * Auto-buy corporation when player has sufficient funds
 * Corporation costs $150b to self-fund
 * Only runs in BN3 or when SF3 is unlocked (excluded in BN8)
 */

import { log, getNsDataThroughFile } from '../helpers.js';

/** @param {NS} ns **/
export async function main(ns) {
    try {
        // Check if corporation API is available
        const hasApi = await getNsDataThroughFile(ns, 'typeof ns.corporation !== "undefined" && ns.corporation !== null');
        if (!hasApi) {
            return;
        }

        // Check if already has corporation
        const hasCorp = await getNsDataThroughFile(ns, 'ns.corporation.hasCorporation()');
        if (hasCorp) {
            return;
        }

        // Check if we can afford to create a corporation ($150b self-fund)
        const playerMoney = await getNsDataThroughFile(ns, 'ns.getPlayer().money');
        const CORP_COST = 150e9; // $150 billion to self-fund

        if (playerMoney < CORP_COST) {
            return;
        }

        // Create the corporation with self-funding
        const success = await getNsDataThroughFile(ns, 'ns.corporation.createCorporation(ns.args[0], ns.args[1])', null, ['AutoCorp', true]);

        if (success) {
            log(ns, 'SUCCESS: Created corporation "AutoCorp" for $150b! corp-fetcher.js will start shortly.', true, 'success');
        } else {
            log(ns, 'WARNING: Failed to create corporation. May already exist or insufficient funds.', false, 'warning');
        }
    } catch (error) {
        log(ns, `ERROR: corp-auto-buy.js failed: ${error?.message || error}`, false, 'error');
    }
}
