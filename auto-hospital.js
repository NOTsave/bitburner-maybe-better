import {
    log, getConfiguration, getErrorInfo, tail, getNsDataThroughFile, formatMoney
} from './helpers.js'

const HOSPITAL_COST_PER_HP = 10000; // From Constants.ts: HospitalCostPerHp = 10k

const argsSchema = [
    ['min-hp-percent', 30], // Visit hospital when HP falls below this percentage
    ['enable-logging', false], // Set to true to pop up a tail window
    ['check-interval', 5000], // How often to check HP (ms)
    ['hospital-city', 'Sector-12'], // City with hospital (default has one in every city, but specify preferred)
    ['port', 20], // Port to listen for heal requests from other scripts
    ['max-cost', 0], // Max hospital cost to pay (0 = unlimited). If cost exceeds this, wait for natural regen.
    ['warn-cost', 1000000], // Warn if hospital cost exceeds this amount
    ['coordination-port', 21], // Port to check if infiltration (or other scripts) are busy
    ['respect-busy', true], // If true, don't navigate if infiltration is busy
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return;

    const verbose = options['enable-logging'];
    const minHpPercent = options['min-hp-percent'];
    const checkInterval = options['check-interval'];

    // Use ns.asleep for Web version background tab stability
    const sleep = ns.asleep || ns.sleep;

    if (verbose) {
        tail(ns);
    } else {
        ns.disableLog("ALL");
    }

    log(ns, `INFO: Auto-hospital monitoring started (threshold: ${minHpPercent}%)`);

    let isHealing = false;
    let skippedDueToCost = false;
    const port = options['port'];
    const coordPort = options['coordination-port'];
    const respectBusy = options['respect-busy'];
    const maxCost = options['max-cost'];
    const warnCost = options['warn-cost'];

    /** Calculate hospital cost based on Bitburner source formula */
    function calculateHospitalCost(player) {
        if (player.money < 0) return 0;
        const hpToHeal = player.hp.max - player.hp.current;
        const costPerHp = HOSPITAL_COST_PER_HP;
        const rawCost = hpToHeal * costPerHp;
        const maxMoneyCost = player.money * 0.1; // 10% of money cap
        return Math.min(rawCost, maxMoneyCost);
    }

    // Clear port on startup
    ns.clearPort(port);

    while (true) {
        try {
            const player = ns.getPlayer();
            const hpPercent = (player.hp.current / player.hp.max) * 100;

            if (verbose) {
                log(ns, `DEBUG: HP at ${hpPercent.toFixed(1)}% (${player.hp.current}/${player.hp.max})`);
            }

            // Check for heal requests from other scripts (e.g., infiltration)
            if (!isHealing && ns.peek(port) !== 'NULL PORT DATA') {
                const data = ns.readPort(port);
                try {
                    const request = JSON.parse(data);
                    if (request.type === 'HEAL_REQUEST') {
                        log(ns, `INFO: Received heal request from ${request.source || 'another script'}`, false, 'info');
                        // Trigger immediate heal check
                        if (!isHealing && player.hp.current < player.hp.max * 0.9) {
                            isHealing = true;
                            const healed = await visitHospital(player.city);
                            if (healed) {
                                log(ns, `SUCCESS: Emergency heal completed.`, true, 'success');
                            }
                            isHealing = false;
                        }
                    }
                } catch { }
            }

            // Check if infiltration is active (don't interfere)
            if (respectBusy) {
                const status = ns.peek(coordPort);
                if (status === 'INFILTRATION_BUSY') {
                    if (verbose) {
                        log(ns, `DEBUG: Infiltration in progress, deferring hospital visit`);
                    }
                    await sleep(checkInterval);
                    continue;
                }
            }

            // Check if healing is needed based on threshold
            if (hpPercent < minHpPercent && !isHealing && !skippedDueToCost) {
                const cost = calculateHospitalCost(player);

                // Check if cost exceeds max allowed
                if (maxCost > 0 && cost > maxCost) {
                    if (!skippedDueToCost) {
                        log(ns, `WARNING: Hospital cost ${formatMoney(cost)} exceeds max-cost ${formatMoney(maxCost)}. Waiting for natural regen...`, true, 'warning');
                        skippedDueToCost = true;
                    }
                    await sleep(checkInterval);
                    continue;
                }

                // Warn about expensive heals
                if (cost > warnCost) {
                    log(ns, `WARNING: Hospital will cost ${formatMoney(cost)}!`, true, 'warning');
                }

                // Reset skip flag since cost is now acceptable
                skippedDueToCost = false;

                log(ns, `WARNING: HP low (${hpPercent.toFixed(1)}%). Traveling to hospital (cost: ${formatMoney(cost)})...`, true, 'warning');
                isHealing = true;

                const healed = await visitHospital(player.city);

                if (healed) {
                    log(ns, `SUCCESS: Hospital visit complete. HP restored.`, true, 'success');
                } else {
                    log(ns, `ERROR: Failed to visit hospital.`, true, 'error');
                }

                isHealing = false;
            }

            // Reset skip flag if HP recovered naturally
            if (skippedDueToCost && hpPercent >= minHpPercent) {
                skippedDueToCost = false;
            }

            await sleep(checkInterval);

        } catch (err) {
            log(ns, `ERROR: ${getErrorInfo(err)}`, true, 'error');
            isHealing = false;
            await sleep(checkInterval * 2); // Wait longer after error
        }
    }

    /** Visit hospital to restore HP */
    async function visitHospital(currentCity) {
        try {
            // Try singularity API first
            try {
                const result = await getNsDataThroughFile(
                    ns,
                    `(() => {
                        const player = ns.getPlayer();
                        if (player.hp.current < player.hp.max) {
                            // Hospital is available in all cities, just need to visit it
                            return ns.singularity.hospitalize();
                        }
                        return true;
                    })()`,
                    null
                );
                if (result) return true;
            } catch { }

            // Fall back to DOM navigation
            const doc = eval("document");

            // Navigate to City -> Hospital
            const cityBtn = doc.evaluate(
                "//div[@role='button' and contains(., 'City')]",
                doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;

            if (cityBtn) {
                const onClick = cityBtn[Object.keys(cityBtn)[1]]?.onClick;
                if (onClick) await onClick({ isTrusted: true });
                await sleep(200);
            }

            // Find and click Hospital
            const hospitalBtn = doc.evaluate(
                "//span[contains(text(), 'Hospital') or contains(text(), 'hospital')]",
                doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;

            if (hospitalBtn) {
                const parent = hospitalBtn.parentElement;
                const onClick = parent[Object.keys(parent)[1]]?.onClick;
                if (onClick) await onClick({ isTrusted: true });
                await sleep(500);

                // Look for "Visit Hospital" or "Get Treatment" button
                const treatBtn = doc.evaluate(
                    "//button[contains(text(), 'Hospital') or contains(text(), 'Treatment') or contains(text(), 'Treat')]",
                    doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;

                if (treatBtn) {
                    const btnOnClick = treatBtn[Object.keys(treatBtn)[1]]?.onClick;
                    if (btnOnClick) await btnOnClick({ isTrusted: true });
                    await sleep(1000); // Wait for healing animation
                    return true;
                }
            }

            return false;

        } catch (err) {
            log(ns, `ERROR in visitHospital: ${getErrorInfo(err)}`, false, 'error');
            return false;
        }
    }
}
