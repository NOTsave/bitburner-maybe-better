import {
    log, getConfiguration, instanceCount, getNsDataThroughFile,
    formatMoney, formatDuration, formatNumberShort, tail, getErrorInfo, asleep
} from './helpers.js'

/**
 * Infiltration Automation - v3.x API Edition
 * 
 * Uses the native ns.infiltration API (no DOM clicking!) to:
 * - Find the best infiltration targets based on difficulty/reward
 * - Automate all minigames (bracket, cheat code, backward, etc.)
 * - Collect optimal rewards (money vs reputation)
 * - Coordinate with auto-hospital.js for healing between runs
 * 
 * RAM: 1.6GB base + dynamic ram-dodging (ns.infiltration calls via temp scripts)
 */

const argsSchema = [
    ['target-location', null], // Specific location to infiltrate (e.g., "MegaCorp")
    ['max-difficulty', 3], // Maximum difficulty level (1-5 scale)
    ['run-once', false], // Run once and exit
    ['continuous', true], // Run continuously
    ['min-reward', 100000], // Minimum expected reward
    ['prefer-reputation', false], // Prefer reputation over money rewards
    ['interval', 5000], // Delay between infiltration attempts (ms)
    ['max-runs', Infinity], // Maximum number of runs (-1 for infinite)
    ['port', 20], // Port for hospital communication
    ['coordination-port', 21], // Port to signal busy state
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

// Minigame solvers - pure functions that take game data and return answers
const MinigameSolvers = {
    /**
     * Slash Game: Press when guard is distracted
     * Game data: { type: "Slash", phase: "guarding"|"distracted" }
     */
    'Slash': {
        solve: (data) => data.phase === 'distracted',
        description: 'Timing the slash attack'
    },

    /**
     * Bracket Game: Close matching brackets
     * Game data: { type: "Bracket", openingBrackets: string }
     */
    'Bracket': {
        solve: (data) => {
            const pairs = { '[': ']', '<': '>', '(': ')', '{': '}' };
            return data.openingBrackets.split('').reverse().map(c => pairs[c]).join('');
        },
        description: 'Matching closing brackets'
    },

    /**
     * Cheat Code Game: Enter arrow sequence
     * Game data: { type: "CheatCode", arrows: string }
     */
    'CheatCode': {
        solve: (data) => data.arrows,
        description: 'Entering cheat code sequence'
    },

    /**
     * Backward Game: Type word in reverse
     * Game data: { type: "Backward", word: string }
     */
    'Backward': {
        solve: (data) => data.word.split('').reverse().join(''),
        description: 'Typing word backwards'
    },

    /**
     * Bribe Game: Select positive adjective
     * Game data: { type: "Bribe", words: string[], currentChoice: string }
     */
    'Bribe': {
        solve: (data) => {
            const negative = ['aggressive', 'aloof', 'arrogant', 'boastful', 'boring',
            'careless', 'cold', 'cowardly', 'cruel', 'dishonest', 'disloyal',
            'disorganized', 'disrespectful', 'dull', 'greedy', 'ignorant',
            'impatient', 'impolite', 'incompetent', 'indecisive', 'inflexible',
            'irresponsible', 'jealous', 'lazy', 'mean', 'moody', 'naive',
            'narrow-minded', 'nervous', 'obnoxious', 'passive', 'pessimistic',
            'reckless', 'rigid', 'rude', 'selfish', 'shy', 'sloppy', 'stingy',
            'stubborn', 'tactless', 'thoughtless', 'uncooperative', 'unethical',
            'unkind', 'unreliable', 'vague', 'vindictive', 'weak-willed'];
            return data.words.filter(w => !negative.includes(w.toLowerCase()))[0] || data.words[0];
        },
        description: 'Selecting positive word'
    },

    /**
     * Wire Cutting Game: Cut correct wires
     * Game data: { type: "WireCutting", wires: [{color, number}], instruction: string }
     */
    'WireCutting': {
        solve: (data) => {
            const colors = ['red', 'blue', 'yellow', 'green', 'white', 'black'];
            // Parse instructions like "Cut wire number 3" or "Cut all wires colored red"
            const numMatch = data.instruction.match(/number\s+(\d+)/i);
            const colorMatch = data.instruction.match(/colored\s+(\w+)/i);
            if (numMatch) {
                return [parseInt(numMatch[1])];
            }
            if (colorMatch) {
                const targetColor = colorMatch[1].toLowerCase();
                return data.wires.filter(w => w.color.toLowerCase() === targetColor).map(w => w.number);
            }
            return [data.wires[0].number]; // Fallback
        },
        description: 'Cutting correct wires'
    },

    /**
     * Cyberpunk 2077 Game: Navigate grid and select correct hex codes
     * Game data: { type: "Cyberpunk", grid: string[][], targetCode: string, position: {x,y} }
     */
    'Cyberpunk': {
        solve: (data) => {
            // Find path to target code in the grid
            const target = data.targetCode;
            for (let y = 0; y < data.grid.length; y++) {
                for (let x = 0; x < data.grid[y].length; x++) {
                    if (data.grid[y][x] === target) {
                        return moveToward(data.position, { x, y });
                    }
                }
            }
            return 'ArrowDown'; // Fallback
        },
        description: 'Navigating cyberpunk grid'
    },

    /**
     * Minesweeper Game: Remember and mark mines
     * Game data: { type: "Minesweeper", board: boolean[][], phase: "memory"|"action" }
     */
    'Minesweeper': {
        solve: (data) => {
            if (data.phase === 'memory') return null; // Just observe
            // Mark all mines on the board
            const minePositions = [];
            for (let y = 0; y < data.board.length; y++) {
                for (let x = 0; x < data.board[y].length; x++) {
                    if (data.board[y][x]) minePositions.push({ x, y });
                }
            }
            return minePositions;
        },
        description: 'Marking mine positions'
    },
};

/** Navigate from current position toward target using arrow keys */
function moveToward(current, target) {
    if (current.x < target.x) return 'ArrowRight';
    if (current.x > target.x) return 'ArrowLeft';
    if (current.y < target.y) return 'ArrowDown';
    if (current.y > target.y) return 'ArrowUp';
    return 'ArrowDown';
}

/** @param {NS} ns */
export async function main(ns) {
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return;
    const options = runOptions;

    ns.disableLog('ALL');
    tail(ns);

    log(ns, '🕵️ Infiltration Automation started (v3.x API)', false, 'success');

    const coordPort = options['coordination-port'];
    let runsCompleted = 0;

    while (runsCompleted < options['max-runs']) {
        try {
            // Signal busy to other scripts
            try { await ns.writePort(coordPort, 'INFILTRATION_BUSY'); } catch {}

            // Find best target
            const target = await findBestTarget(ns, options);
            if (!target) {
                log(ns, 'No suitable infiltration targets found. Waiting...', false, 'info');
                try { await ns.writePort(coordPort, 'IDLE'); } catch {}
                if (options['run-once']) break;
                await asleep(ns, options.interval * 6);
                continue;
            }

            log(ns, `🎯 Target: ${target.name} (difficulty ${target.difficulty}, reward: ${formatMoney(target.reward)})`, false, 'info');

            // Start infiltration
            const started = await getNsDataThroughFile(ns,
                'ns.infiltration.startInfiltration(ns.args[0])', null, [target.name]);

            if (!started) {
                log(ns, `ERROR: Failed to start infiltration at ${target.name}`, false, 'error');
                try { await ns.writePort(coordPort, 'IDLE'); } catch {}
                if (options['run-once']) break;
                await asleep(ns, options.interval);
                continue;
            }

            log(ns, `📍 Infiltration started at ${target.name}`, false, 'info');

            // Clear all minigames
            let gamesCleared = 0;
            let gameFailures = 0;
            const maxFailures = 3;

            while (gameFailures < maxFailures) {
                try {
                    // Get current game data
                    const stage = await getNsDataThroughFile(ns,
                        'ns.infiltration.getInfiltrationStage()');

                    // Check if infiltration is complete or failed
                    if (!stage || stage.type === 'complete') {
                        log(ns, `✅ All ${gamesCleared} minigames cleared!`, false, 'success');
                        break;
                    }

                    if (stage.type === 'failure') {
                        log(ns, `❌ Infiltration failed at game ${gamesCleared + 1}`, false, 'error');
                        gameFailures++;
                        break;
                    }

                    // Get minigame data and solve it
                    const gameData = await getNsDataThroughFile(ns,
                        'ns.infiltration.getGameData()');

                    if (!gameData) {
                        log(ns, 'WARN: No game data available, retrying...', false, 'warning');
                        await asleep(ns, 200);
                        continue;
                    }

                    const solver = MinigameSolvers[gameData.type];
                    if (!solver) {
                        log(ns, `WARN: No solver for game type: ${gameData.type}`, false, 'warning');
                        gameFailures++;
                        continue;
                    }

                    const answer = solver.solve(gameData);

                    // Some games (Minesweeper memory phase) require no action
                    if (answer === null) {
                        await asleep(ns, 2000); // Wait for memory phase to end
                        continue;
                    }

                    // Submit answer directly (no JSON stringify needed)
                    const result = await getNsDataThroughFile(ns,
                        'ns.infiltration.completeGame(ns.args[0])',
                        '/Temp/infiltrate-complete.txt', [answer]);

                    if (result) {
                        gamesCleared++;
                        log(ns, `🎮 Cleared: ${solver.description} (${gamesCleared} total)`, false, 'info');
                    } else {
                        gameFailures++;
                        log(ns, `❌ Failed: ${solver.description} (failure ${gameFailures}/${maxFailures})`, false, 'warning');
                    }

                    // Small delay between games
                    await asleep(ns, 100);

                } catch (err) {
                    gameFailures++;
                    log(ns, `ERROR: Game error: ${getErrorInfo(err)}`, false, 'error');
                }
            }

            // Collect reward if games were cleared
            if (gamesCleared > 0) {
                const reward = await getNsDataThroughFile(ns,
                    'ns.infiltration.getReward()');

                if (reward) {
                    const preferRep = options['prefer-reputation'];
                    const rewardType = (preferRep && reward.reputation > 0) ? 'reputation' : 'money';

                    const collected = await getNsDataThroughFile(ns,
                        'ns.infiltration.collectReward(ns.args[0])',
                        '/Temp/infiltrate-reward.txt', [rewardType]);

                    if (collected) {
                        runsCompleted++;
                        const rewardAmount = rewardType === 'money' ? reward.money : reward.reputation;
                        log(ns, `💰 Collected ${rewardType}: ${rewardType === 'money' ? formatMoney(rewardAmount) : formatNumberShort(rewardAmount)} (run ${runsCompleted})`, false, 'success');
                    } else {
                        log(ns, `ERROR: Failed to collect ${rewardType} reward`, false, 'error');
                    }
                }
            }

        } catch (err) {
            log(ns, `ERROR: Infiltration run failed: ${getErrorInfo(err)}`, false, 'error');
        } finally {
            // Signal idle
            try { await ns.writePort(coordPort, 'IDLE'); } catch {}
        }

        if (options['run-once']) break;

        // Check health and request healing if needed
        const player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/infiltration-player.txt');
        if (player.hp.current < player.hp.max * 0.5) {
            log(ns, `💔 HP low (${(player.hp.current / player.hp.max * 100).toFixed(0)}%), requesting hospital...`, false, 'warning');
            const port = options['port'];
            try { await ns.clearPort(port); } catch {}
            try {
                await ns.writePort(port, JSON.stringify({
                    type: 'HEAL_REQUEST',
                    hp: player.hp.current,
                    maxHp: player.hp.max,
                    timestamp: Date.now()
                }));
            } catch {}
            // Wait for healing
            await asleep(ns, 10000);
        }

        await asleep(ns, options.interval);
    }

    log(ns, `🏁 Infiltration complete. ${runsCompleted} runs finished.`, false, 'success');
    try { await ns.writePort(coordPort, 'IDLE'); } catch {}
}

/**
 * Find the best infiltration target based on difficulty and reward
 * 
 * @param {NS} ns
 * @param {object} options - Parsed configuration
 * @returns {Object|null} Best target or null if none available
 */
async function findBestTarget(ns, options) {
    // Check if specific location requested
    if (options['target-location']) {
        try {
            const location = options['target-location'];
            const info = await getNsDataThroughFile(ns,
                'ns.infiltration.getInfiltration(ns.args[0])', null, [location]);
            if (info && info.difficulty <= options['max-difficulty']) {
                return info;
            }
        } catch (e) {
            log(ns, `ERROR: Target location "${options['target-location']}" not found`, false, 'error');
            return null;
        }
    }

    // Get all available locations
    const locations = await getNsDataThroughFile(ns,
        'ns.infiltration.getPossibleLocations()');

    if (!locations || locations.length === 0) return null;

    // Get details for each location
    const details = [];
    for (const location of locations) {
        try {
            const info = await getNsDataThroughFile(ns,
                'ns.infiltration.getInfiltration(ns.args[0])', null, [location.name || location]);
            if (info && info.difficulty <= options['max-difficulty']) {
                details.push(info);
            }
        } catch (e) {
            continue; // Skip locations we can't get info for
        }
    }

    // Filter by minimum reward
    const validTargets = details.filter(t =>
        (t.reward?.sellCash || 0) >= options['min-reward'] ||
        (t.reward?.tradeRep || 0) >= options['min-reward'] / 10
    );

    if (validTargets.length === 0) return null;

    // Sort by efficiency (reward per difficulty)
    const preferRep = options['prefer-reputation'];
    validTargets.sort((a, b) => {
        const valueA = preferRep ?
            (a.reward?.tradeRep || 0) / Math.max(1, a.difficulty) :
            (a.reward?.sellCash || 0) / Math.max(1, a.difficulty);
        const valueB = preferRep ?
            (b.reward?.tradeRep || 0) / Math.max(1, b.difficulty) :
            (b.reward?.sellCash || 0) / Math.max(1, b.difficulty);
        return valueB - valueA;
    });

    return validTargets[0];
}
