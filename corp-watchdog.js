import {
    log, getNsDataThroughFile, getErrorInfo, getFilePath
} from './helpers.js'

// RAM-dodging wrapper functions
async function cc(ns, command, args = []) {
    return await getNsDataThroughFile(ns, command, '/Temp/corp-watchdog-data.txt', args);
}

// Helper functions moved before main loop for better structure
async function checkAndRestartCorp(ns, restartAttempts, maxRestartAttempts) {
    const runningScripts = await cc(ns, 'ns.ps(ns.args[0])', ["home"]);
    // Fix #7: Monitoring the correct script
    const managerRunning = runningScripts.some(s => s.filename.includes('corp-manager.js'));
    
    if (!managerRunning) {
        return await restartCorp(ns, restartAttempts, maxRestartAttempts);
    }
    return restartAttempts;
}

async function restartCorp(ns, restartAttempts, maxRestartAttempts) {
    if (restartAttempts >= maxRestartAttempts) {
        log(ns, `ERROR: Max restart attempts (${maxRestartAttempts}) reached. Giving up.`, true, 'error');
        return restartAttempts;
    }

    const newAttempts = restartAttempts + 1;
    log(ns, `INFO: Restarting corp-manager.js (attempt ${newAttempts}/${maxRestartAttempts})...`, false, 'info');
    
    const pid = ns.run(getFilePath('corp-manager.js'), 1);
    if (pid > 0) {
        log(ns, `SUCCESS: Restarted corp-manager.js with pid ${pid}`, true, 'success');
        await ns.sleep(5000); // Give it time to start
        return 0; // Reset counter on successful restart
    } else {
        log(ns, `ERROR: Failed to restart corp-manager.js`, true, 'error');
        return newAttempts;
    }
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    ns.clearLog();

    log(ns, '════════════════════════════════════════');
    log(ns, '  corp-watchdog.js — Corp-Manager Protection');
    log(ns, '  Restarts corp-manager.js if killed unexpectedly');
    log(ns, '════════════════════════════════════════');

    const checkInterval = 10000; // Check every 10 seconds
    const maxRestartAttempts = 10;
    let restartAttempts = 0;

    while (true) {
        try {
            await ns.sleep(checkInterval);

            // Check if corp-manager.js protection file exists and is recent
            const protectionData = ns.read('/Temp/corp-protection.txt');
            if (!protectionData) {
                log(ns, 'WARNING: corp-manager.js protection file not found, checking if corp-manager.js is running...', false, 'warning');
                restartAttempts = await checkAndRestartCorp(ns, restartAttempts, maxRestartAttempts);
                continue;
            }

            let protection;
            try {
                protection = JSON.parse(protectionData);
            } catch (e) {
                log(ns, `ERROR: Invalid protection data: ${e.message || e}. Checking corp-manager.js status...`, false, 'error');
                restartAttempts = await checkAndRestartCorp(ns, restartAttempts, maxRestartAttempts);
                continue;
            }

            const now = Date.now();
            
            // If protection file hasn't been updated in 15 seconds, corp-manager.js might be dead
            if (now - protection.lastCheck > 15000) {
                log(ns, `WARNING: corp-manager.js hasn't checked in for ${Math.floor((now - protection.lastCheck) / 1000)}s, checking status...`, false, 'warning');
                restartAttempts = await checkAndRestartCorp(ns, restartAttempts, maxRestartAttempts);
                continue;
            }

            // Verify PID is still running (RAM-dodged)
            const runningScripts = await cc(ns, 'ns.ps(ns.args[0])', ["home"]);
            const managerRunning = runningScripts.find(s => s.pid === protection.pid && s.filename.includes('corp-manager.js'));
            
            if (!managerRunning) {
                log(ns, `WARNING: corp-manager.js (pid ${protection.pid}) not found in process list, restarting...`, false, 'warning');
                restartAttempts = await restartCorp(ns, restartAttempts, maxRestartAttempts);
            }

        } catch (err) {
            log(ns, `ERROR: Watchdog error: ${getErrorInfo(err)}`, false, 'error');
            await ns.sleep(30000); // Wait longer on error
        }
    }
}
