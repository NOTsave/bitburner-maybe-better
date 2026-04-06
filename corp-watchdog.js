import {
    log, getNsDataThroughFile, getErrorInfo
} from './helpers.js'

// RAM-dodging wrapper functions
async function cc(ns, command, args = []) {
    return await getNsDataThroughFile(ns, command, `/Temp/watchdog-${Date.now()}.txt`, args);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    ns.clearLog();

    log(ns, '════════════════════════════════════════');
    log(ns, '  corp-watchdog.js — Corp.js Protection');
    log(ns, '  Restarts corp.js if killed unexpectedly');
    log(ns, '════════════════════════════════════════');

    const checkInterval = 10000; // Check every 10 seconds
    const maxRestartAttempts = 10;
    let restartAttempts = 0;

    while (true) {
        try {
            await ns.sleep(checkInterval);

            // Check if corp.js protection file exists and is recent
            const protectionData = ns.read('Temp/corp-protection.txt');
            if (!protectionData) {
                log(ns, 'WARNING: corp.js protection file not found, checking if corp.js is running...', false, 'warning');
                await checkAndRestartCorp(ns);
                continue;
            }

            let protection;
            try {
                protection = JSON.parse(protectionData);
            } catch (_) {
                log(ns, 'ERROR: Invalid protection data, checking corp.js status...', false, 'error');
                await checkAndRestartCorp(ns);
                continue;
            }

            const now = Date.now();
            
            // If protection file hasn't been updated in 15 seconds, corp.js might be dead
            if (now - protection.lastCheck > 15000) {
                log(ns, `WARNING: corp.js hasn't checked in for ${Math.floor((now - protection.lastCheck) / 1000)}s, checking status...`, false, 'warning');
                await checkAndRestartCorp(ns);
                continue;
            }

            // Verify the PID is still running (RAM-dodged)
            const runningScripts = await cc(ns, 'ns.ps(ns.args[0])', ["home"]);
            const corpRunning = runningScripts.find(s => s.pid === protection.pid && s.filename.includes('corp.js'));
            
            if (!corpRunning) {
                log(ns, `WARNING: corp.js (pid ${protection.pid}) not found in process list, restarting...`, false, 'warning');
                await restartCorp(ns);
            }

        } catch (err) {
            log(ns, `ERROR: Watchdog error: ${getErrorInfo(err)}`, false, 'error');
            await ns.sleep(30000); // Wait longer on error
        }
    }

    async function checkAndRestartCorp(ns) {
        const runningScripts = await cc(ns, 'ns.ps(ns.args[0])', ["home"]);
        const corpRunning = runningScripts.find(s => s.filename.includes('corp.js'));
        
        if (!corpRunning) {
            await restartCorp(ns);
        }
    }

    async function restartCorp(ns) {
        if (restartAttempts >= maxRestartAttempts) {
            log(ns, `ERROR: Max restart attempts (${maxRestartAttempts}) reached. Giving up.`, true, 'error');
            return;
        }

        restartAttempts++;
        log(ns, `INFO: Restarting corp.js (attempt ${restartAttempts}/${maxRestartAttempts})...`, false, 'info');
        
        const pid = ns.run('corp.js', 1);
        if (pid > 0) {
            log(ns, `SUCCESS: Restarted corp.js with pid ${pid}`, true, 'success');
            restartAttempts = 0; // Reset counter on successful restart
        } else {
            log(ns, `ERROR: Failed to restart corp.js`, true, 'error');
        }
        
        await ns.sleep(5000); // Give it time to start
    }
}
