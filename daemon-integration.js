/**
 * DAEMON INTEGRATION FOR AUTOPILOT.JS
 * 
 * This script provides the interface that autopilot.js expects
 * but uses the ultra-efficient unified daemon internally
 * 
 * Usage: Replace calls to "run daemon.js" with "run daemon-integration.js"
 */

import { getConfiguration } from './helpers.js';

const argsSchema = [
    ['mode', 'unified'], // Default: use unified daemon
    ['mode', 'original'], // Fallback: use original daemon
    ['verbose', false],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return;

    const mode = options.mode || 'unified';
    const verbose = options.verbose || false;

    if (verbose) {
        ns.print(`Daemon Integration Mode: ${mode}`);
    }

    if (mode === 'unified') {
        // Launch the ultra-efficient unified daemon
        const daemonArgs = ['--verbose', verbose ? 'true' : 'false'];
        const pid = ns.run('daemon-unified.js', daemonArgs);
        
        if (pid) {
            ns.print(`Launched unified daemon (PID: ${pid}) - RAM usage should be ~200-400MB`);
            ns.print('Monitoring with: top');
        } else {
            ns.print('ERROR: Failed to launch unified daemon');
        }
    } else if (mode === 'original') {
        // Launch the original daemon (current behavior)
        const daemonArgs = ['--verbose', verbose ? 'true' : 'false'];
        const pid = ns.run('daemon.js', daemonArgs);
        
        if (pid) {
            ns.print(`Launched original daemon (PID: ${pid}) - RAM usage will be ~2.8GB`);
            ns.print('Monitor with: top');
        } else {
            ns.print('ERROR: Failed to launch original daemon');
        }
    } else {
        ns.print('ERROR: Invalid mode. Use --mode unified or --mode original');
    }

    // Keep the integration script running to maintain the interface
    while (true) {
        await ns.sleep(10000);
        
        // Check if daemon is still running
        const processes = ns.ps('home');
        const daemonProcess = processes.find(p => 
            p.filename.includes('daemon') && p.pid !== ns.pid
        );
        
        if (!daemonProcess) {
            ns.print('WARNING: Daemon process not found. Restarting...');
            
            // Restart the appropriate daemon
            if (mode === 'unified') {
                const daemonArgs = ['--verbose', verbose ? 'true' : 'false'];
                ns.run('daemon-unified.js', daemonArgs);
            } else {
                const daemonArgs = ['--verbose', verbose ? 'true' : 'false'];
                ns.run('daemon.js', daemonArgs);
            }
        }
    }
}
