import {
    log, getConfiguration, getFilePath, waitForProcessToComplete,
    runCommand, getNsDataThroughFile, formatMoney, getErrorInfo, tail
} from './helpers.js'

const argsSchema = [
    ['target-location', null], // Specific location to infiltrate (e.g., "MegaCorp"). If null, finds best target.
    ['max-difficulty', 1.0], // Maximum difficulty multiplier (0.1-1.0) based on player stats
    ['enable-logging', false], // Set to true to pop up a tail window and generate logs.
    ['click-sleep-time', 5], // Time to sleep in milliseconds before and after clicking.
    ['find-sleep-time', 0], // Time to sleep before trying to find elements.
    ['game-reaction-time', 150], // Base reaction time in ms for quick-time events (lower = faster).
    ['run-once', false], // Set to true to run once and exit, false for continuous infiltration.
    ['min-reward', 100000], // Minimum expected reward to attempt infiltration.
    ['port', 20], // Port number for inter-script communication (hospital alerts)
    ['coordination-port', 21], // Port to signal "busy" status to other scripts
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const doc = eval("document");
    let options;
    let verbose = false;
    let isRunning = false; // Flag to prevent concurrent operations

    // Use ns.asleep for Web version background tab stability, fall back to ns.sleep
    const sleep = ns.asleep || ns.sleep;

    async function start() {
        options = getConfiguration(ns, argsSchema);
        if (!options) return;

        verbose = options['enable-logging'];
        if (verbose)
            tail(ns);
        else
            ns.disableLog("ALL");

        // Check if player is currently hospitalized (previous failed infiltration)
        const player = ns.getPlayer();
        if (player.hp.current < player.hp.max * 0.5) {
            log(ns, "WARNING: Player HP low. Waiting for hospital recovery before starting...", true, 'warning');
            await waitForHealthRecovery();
        }

        // Setup coordination port to signal "busy" to other scripts
        const coordPort = options['coordination-port'];
        ns.clearPort(coordPort);

        log(ns, "INFO: Starting infiltration automation...");

        while (true) {
            try {
                // Prevent concurrent infiltration attempts
                if (isRunning) {
                    await sleep(1000);
                    continue;
                }
                isRunning = true;

                // Check health before starting
                const player = ns.getPlayer();
                if (player.hp.current < player.hp.max * 0.3) {
                    log(ns, "WARNING: HP too low for infiltration. Waiting for recovery...", true, 'warning');
                    isRunning = false;
                    await waitForHealthRecovery();
                    continue;
                }

                // Find and infiltrate target
                const target = await findInfiltrationTarget();
                if (!target) {
                    log(ns, "WARNING: No suitable infiltration target found. Waiting...", false, 'warning');
                    isRunning = false;
                    await sleep(30000);
                    if (options['run-once']) break;
                    continue;
                }

                log(ns, `INFO: Targeting ${target.location} (${target.difficulty.toFixed(2)} difficulty, ~${formatMoney(target.reward)} reward)`);

                // Signal to other scripts that we're busy with infiltration
                ns.writePort(coordPort, "INFILTRATION_BUSY");

                const success = await performInfiltration(target);

                // Signal that we're done
                ns.writePort(coordPort, "IDLE");

                if (success) {
                    log(ns, `SUCCESS: Completed infiltration at ${target.location}`, true, 'success');
                } else {
                    log(ns, `WARNING: Failed infiltration at ${target.location}`, false, 'warning');
                }

                isRunning = false;
                if (options['run-once']) break;
                await sleep(5000); // Brief pause between runs

            } catch (err) {
                log(ns, `ERROR: ${getErrorInfo(err)}`, true, 'error');
                isRunning = false;
                ns.writePort(coordPort, "IDLE"); // Ensure we signal idle on error
                if (options['run-once']) break;
                await sleep(10000);
            }
        }

        log(ns, "INFO: Infiltration automation shutting down.");
        isRunning = false;
        ns.writePort(coordPort, "IDLE"); // Ensure clean shutdown
    }

    /** Wait for player to recover HP (via auto-hospital script or manual healing) */
    async function waitForHealthRecovery() {
        const recoveryCheckInterval = 5000;
        const maxWaitTime = 300000; // 5 minutes max wait
        let waited = 0;

        while (waited < maxWaitTime) {
            const player = ns.getPlayer();
            if (player.hp.current >= player.hp.max * 0.9) {
                log(ns, "INFO: Player health recovered. Resuming operations.");
                return true;
            }

            // Write to port to signal auto-hospital if it's running
            const port = options['port'];
            try {
                ns.clearPort(port);
                ns.writePort(port, JSON.stringify({
                    type: 'HEAL_REQUEST',
                    hp: player.hp.current,
                    maxHp: player.hp.max,
                    timestamp: Date.now()
                }));
            } catch { }

            await sleep(recoveryCheckInterval);
            waited += recoveryCheckInterval;
        }

        log(ns, "WARNING: Health recovery timeout. Proceeding with caution.");
        return false;
    }

    /** Check if player was hospitalized during infiltration */
    function checkIfHospitalized() {
        const player = ns.getPlayer();
        return player.hp.current < player.hp.max * 0.5;
    }

    /** Calculate infiltration difficulty based on player stats (from game.ts source) */
    function calculateInfiltrationDifficulty(startingSecurityLevel) {
        const player = ns.getPlayer();
        const totalStats = player.skills.strength +
            player.skills.defense +
            player.skills.dexterity +
            player.skills.agility +
            player.skills.charisma;
        const rawDiff = startingSecurityLevel - Math.pow(totalStats, 0.9) / 250 - player.skills.intelligence / 1600;
        return Math.max(0, rawDiff);
    }

    /** Find best infiltration target based on difficulty and reward */
    async function findInfiltrationTarget() {
        const targetLoc = options['target-location'];

        // If specific location specified, use that
        if (targetLoc) {
            return {
                location: targetLoc,
                city: guessCityForLocation(targetLoc),
                difficulty: 0.5, // Default assumption
                reward: options['min-reward']
            };
        }

        // Known targets with their starting security levels (from Bitburner source)
        // Security levels: 1-15 scale. Higher = harder.
        const knownTargets = [
            { location: "MegaCorp", city: "Sector-12", security: 15, reward: 5000000 },
            { location: "Blade Industries", city: "Sector-12", security: 12, reward: 4000000 },
            { location: "Four Sigma", city: "Sector-12", security: 10, reward: 3000000 },
            { location: "ECorp", city: "Aevum", security: 18, reward: 6000000 },
            { location: "Bachman & Associates", city: "Aevum", security: 8, reward: 2000000 },
            { location: "Clarke Incorporated", city: "Aevum", security: 10, reward: 2500000 },
            { location: "Fulcrum Technologies", city: "Aevum", security: 14, reward: 4500000 },
            { location: "KuaiGong International", city: "Chongqing", security: 12, reward: 3500000 },
            { location: "NWO", city: "Volhaven", security: 16, reward: 5500000 },
            { location: "OmniTek Incorporated", city: "Volhaven", security: 11, reward: 3000000 },
            { location: "Helios Labs", city: "Volhaven", security: 9, reward: 2200000 },
            { location: "Storm Technologies", city: "Ishima", security: 8, reward: 2000000 },
            { location: "DefComm", city: "New Tokyo", security: 7, reward: 1800000 },
            { location: "VitaLife", city: "New Tokyo", security: 6, reward: 1500000 },
            { location: "Global Pharmaceuticals", city: "New Tokyo", security: 10, reward: 2800000 },
        ];

        // Calculate dynamic difficulty for each target
        const targetsWithDifficulty = knownTargets.map(t => ({
            ...t,
            difficulty: calculateInfiltrationDifficulty(t.security)
        }));

        // Filter by max difficulty and min reward
        const maxDiff = options['max-difficulty'];
        const minReward = options['min-reward'];

        const validTargets = targetsWithDifficulty.filter(t =>
            t.difficulty <= maxDiff && t.reward >= minReward
        );

        if (validTargets.length === 0) return null;

        // Sort by reward/difficulty ratio (efficiency)
        validTargets.sort((a, b) => (b.reward / b.difficulty) - (a.reward / a.difficulty));

        return validTargets[0];
    }

    function guessCityForLocation(location) {
        // Map known locations to cities
        const cityMap = {
            "MegaCorp": "Sector-12", "Blade Industries": "Sector-12", "Four Sigma": "Sector-12",
            "ECorp": "Aevum", "Bachman & Associates": "Aevum", "Clarke Incorporated": "Aevum", "Fulcrum Technologies": "Aevum",
            "KuaiGong International": "Chongqing",
            "NWO": "Volhaven", "OmniTek Incorporated": "Volhaven", "Helios Labs": "Volhaven",
            "Storm Technologies": "Ishima",
            "DefComm": "New Tokyo", "VitaLife": "New Tokyo", "Global Pharmaceuticals": "New Tokyo"
        };
        return cityMap[location] || "Sector-12";
    }

    /** Perform infiltration at target location */
    async function performInfiltration(target) {
        try {
            // Reset game state for new infiltration
            resetGameState();

            // Navigate to target city if needed
            if (ns.getPlayer().city !== target.city) {
                await travelToCity(target.city);
            }

            // Navigate to location
            await navigateToLocation(target.location);

            // Start infiltration - try multiple selectors
            let startBtn = await tryfindElement("//button[contains(text(), 'Infiltrate')]", 3);
            if (!startBtn) startBtn = await tryfindElement("//button[contains(text(), 'INFILTRATE')]", 3);
            if (!startBtn) startBtn = await tryfindElement("//*[contains(text(), 'Infiltrate')]", 3);
            if (!startBtn) startBtn = await tryfindElement("//div[@role='button' and contains(., 'Infiltrate')]", 3);
            if (!startBtn) startBtn = await tryfindElement("//button[@aria-label and contains(@aria-label, 'Infiltrate')]", 3);
            if (!startBtn) startBtn = await tryfindElement("//span[contains(text(), 'Infiltrate')]/parent::button", 3);
            if (!startBtn) startBtn = await tryfindElement("//span[contains(text(), 'Infiltrate')]/ancestor::button", 3);

            if (!startBtn) {
                log(ns, `WARNING: No infiltration button found at ${target.location}. Check if button text is different.`, true, 'warning');
                return false;
            }

            if (verbose) log(ns, `Found infiltration button: ${startBtn.tagName} ${startBtn.textContent?.substring(0, 30) || ''}`);

            await sleep(jitter(400, 25)); // Human reaction time before clicking
            await click(startBtn);
            await sleep(jitter(600, 20));

            // Handle infiltration mini-games
            let gameCount = 0;
            const maxGames = 20; // Safety limit
            let hospitalized = false;

            while (gameCount < maxGames) {
                // Check if we were hospitalized during infiltration (game detected automation)
                if (checkIfHospitalized()) {
                    log(ns, "WARNING: Hospitalized during infiltration! Aborting.", true, 'warning');
                    hospitalized = true;
                    break;
                }

                const gameResult = await handleMiniGame();
                if (gameResult === 'complete') {
                    log(ns, "INFO: Infiltration sequence completed");
                    break;
                } else if (gameResult === 'failed') {
                    log(ns, "WARNING: Infiltration failed");
                    return false;
                }

                // Check for hospitalization after each game
                if (checkIfHospitalized()) {
                    log(ns, "WARNING: Hospitalized after minigame! Aborting.", true, 'warning');
                    hospitalized = true;
                    break;
                }

                gameCount++;
            }

            if (hospitalized) {
                resetGameState();
                await waitForHealthRecovery();
                return false;
            }

            // Handle completion / reward selection
            await handleCompletion();
            resetGameState(); // Clean up after successful run
            return true;

        } catch (err) {
            log(ns, `ERROR during infiltration: ${getErrorInfo(err)}`, false, 'error');
            resetGameState();
            return false;
        } finally {
            // Ensure game state is always reset
            resetGameState();
        }
    }

    /** Travel to target city using singularity or DOM navigation */
    async function travelToCity(city) {
        log(ns, `INFO: Traveling to ${city}...`);
        
        // Try singularity first
        try {
            const success = await getNsDataThroughFile(ns, 'ns.singularity.travelToCity(ns.args[0])', null, [city]);
            if (success) {
                log(ns, `SUCCESS: Traveled to ${city}`);
                return;
            }
        } catch { }

        // Fall back to DOM navigation
        const travelBtn = await findRequiredElement("//div[@role='button' and contains(., 'Travel')]");
        await sleep(jitter(200, 20));
        await click(travelBtn);
        await sleep(jitter(350, 20));

        // Try multiple strategies to find the city button (matching casino.js pattern)
        let cityBtn = await tryfindElement(`//span[@aria-label = '${city}']`, 3);
        if (!cityBtn) cityBtn = await tryfindElement(`//button[@aria-label = '${city}']`, 3);
        if (!cityBtn) cityBtn = await tryfindElement(`//*[@aria-label = '${city}']`, 3);
        if (!cityBtn) cityBtn = await tryfindElement(`//span[contains(@class,'travel') and contains(text(), '${city[0]}')]`, 3);
        if (!cityBtn) cityBtn = await tryfindElement(`//span[contains(@class,'travel') and text()='${city[0]}']`, 3);
        if (!cityBtn) cityBtn = await tryfindElement(`//span[contains(text(), '${city}')]`, 3);
        if (!cityBtn) cityBtn = await tryfindElement(`//button[contains(text(), '${city}')]`, 3);

        if (!cityBtn) {
            throw new Error(`Could not find city button for '${city}'. Tried aria-label, travel class, and text content selectors.`);
        }

        await sleep(jitter(150, 25));
        await click(cityBtn);
        await sleep(jitter(350, 20));

        // Confirm travel if dialog appears
        const confirmBtn = await tryfindElement("//button[p/text()='Travel']");
        if (confirmBtn) {
            await sleep(jitter(200, 20));
            await click(confirmBtn);
        }

        await sleep(jitter(550, 15));
    }

    /** Navigate to company location */
    async function navigateToLocation(location) {
        log(ns, `INFO: Navigating to ${location}...`);

        // Try to use World -> City menu
        const cityMenu = await findRequiredElement("//div[@role='button' and contains(., 'City')]");
        await sleep(jitter(200, 20));
        await click(cityMenu);
        await sleep(jitter(350, 20));

        // Find location in the list - try multiple XPath strategies since UI may vary
        let locBtn = await tryfindElement(`//span[@aria-label = '${location}']`, 3);
        if (!locBtn) locBtn = await tryfindElement(`//button[@aria-label = '${location}']`, 3);
        if (!locBtn) locBtn = await tryfindElement(`//*[@aria-label = '${location}']`, 3);
        if (!locBtn) locBtn = await tryfindElement(`//span[contains(text(), '${location}')]`, 3);
        if (!locBtn) locBtn = await tryfindElement(`//button[contains(text(), '${location}')]`, 3);
        if (!locBtn) locBtn = await tryfindElement(`//div[contains(text(), '${location}')]`, 3);
        if (!locBtn) locBtn = await tryfindElement(`//*[contains(text(), '${location}')]`, 3);

        if (!locBtn) {
            throw new Error(`Could not find location button for '${location}'. Tried aria-label and text content selectors.`);
        }

        await sleep(jitter(150, 25));
        await click(locBtn);
        await sleep(jitter(550, 15));
    }

    // ==================== Minigame State ====================
    let gameState = {
        bracketLeft: '',
        cheatCode: [],
        cheatIndex: 0,
        backwardWord: '',
        bribeChoices: [],
        bribeIndex: 0,
        cyberGrid: [],
        cyberAnswers: [],
        cyberX: 0,
        cyberY: 0,
        cyberIndex: 0,
        minesweeperMines: [],
        minesweeperRevealed: [],
        minesweeperPhase: 'memory',
        wireCount: 0,
        wiresToCut: new Set(),
        slashPhase: 0
    };

    /** Reset game state between infiltrations */
    function resetGameState() {
        gameState = {
            bracketLeft: '',
            cheatCode: [],
            cheatIndex: 0,
            backwardWord: '',
            bribeChoices: [],
            bribeIndex: 0,
            cyberGrid: [],
            cyberAnswers: [],
            cyberX: 0,
            cyberY: 0,
            cyberIndex: 0,
            minesweeperMines: [],
            minesweeperRevealed: [],
            minesweeperPhase: 'memory',
            wireCount: 0,
            wiresToCut: new Set(),
            slashPhase: 0
        };
    }

    /** Add random jitter to timing to avoid detection */
    function jitter(baseTime, variancePercent = 20) {
        const variance = baseTime * (variancePercent / 100);
        return baseTime + (Math.random() * variance * 2 - variance);
    }

    /** Handle various mini-games during infiltration */
    async function handleMiniGame() {
        const reactionTime = Math.max(100, jitter(options['game-reaction-time'], 25));

        // Check for game completion
        const completeBtn = await tryfindElement("//button[contains(text(), 'Sell') or contains(text(), 'Trade') or contains(text(), 'Finish')]");
        if (completeBtn) return 'complete';

        // Check for failure state
        const failedState = await tryfindElement("//span[contains(text(), 'failed') or contains(text(), 'caught')]");
        if (failedState) return 'failed';

        // 1. SLASH GAME - Hit SPACE when guard is distracted
        const slashContainer = await tryfindElement("//div[contains(@class, 'slash') or contains(@style, 'Slash')]");
        if (slashContainer || await tryfindElement("//button[contains(text(), 'Slash')]")) {
            return await handleSlashGame(reactionTime);
        }

        // 2. BRACKET GAME - Match closing brackets
        const bracketDisplay = await tryfindElement("//span[contains(text(), '[') or contains(text(), '<') or contains(text(), '(') or contains(text(), '{')]");
        if (bracketDisplay) {
            return await handleBracketGame(bracketDisplay.textContent);
        }

        // 3. CHEAT CODE - Enter arrow sequence
        const arrowSequence = await tryfindElement("//span[contains(text(), '↑') or contains(text(), '↓') or contains(text(), '←') or contains(text(), '→')]");
        if (arrowSequence && !gameState.bribeChoices.length) {
            return await handleCheatCodeGame(arrowSequence.textContent, reactionTime);
        }

        // 4. BRIBE GAME - Select positive adjective
        const bribeContainer = await tryfindElement("//div[contains(text(), 'affectionate') or contains(text(), 'aggressive')]");
        if (bribeContainer) {
            return await handleBribeGame();
        }

        // 5. BACKWARD WORD - Type reversed
        const backwardPrompt = await tryfindElement("//span[contains(text(), 'Type it backward')]");
        if (backwardPrompt) {
            return await handleBackwardGame(reactionTime);
        }

        // 6. CYBERPUNK 2077 - Navigate grid and select codes
        const cyberGrid = await tryfindElement("//div[contains(@class, 'cyber') or //span[contains(text(), 'FF') or contains(text(), '00') or contains(text(), 'A1')]]");
        if (cyberGrid) {
            return await handleCyberpunkGame(reactionTime);
        }

        // 7. MINESWEEPER - Mark all mines
        const minesweeperGrid = await tryfindElement("//div[contains(@class, 'mine') or //div[contains(@style, 'grid')]]");
        if (minesweeperGrid) {
            return await handleMinesweeperGame(reactionTime);
        }

        // 8. WIRE CUTTING - Cut correct wires
        const wireRules = await tryfindElement("//span[contains(text(), 'Cut wire')]");
        if (wireRules) {
            return await handleWireGame(wireRules.textContent);
        }

        // Check for continue/next button
        const nextBtn = await tryfindElement("//button[contains(text(), 'Continue') or contains(text(), 'Next')]");
        if (nextBtn) {
            await sleep(jitter(150, 25));
            await click(nextBtn);
            await sleep(jitter(200, 20));
            return 'next';
        }

        // No recognized game state, wait briefly
        await sleep(jitter(100, 30));
        return 'unknown';
    }

    /** SLASH: Wait for distracted phase, press SPACE */
    async function handleSlashGame(reactionTime) {
        // From source: Guarding phase random 1500-4750ms, then distracted window 250-800ms
        // MightOfAres aug gives longer window
        const minGuardTime = 1500 + Math.random() * 500; // Add some randomness to guard time
        const distractedWindow = 600; // Conservative estimate

        await sleep(jitter(minGuardTime + reactionTime, 15));

        // Send SPACE key
        const slashBtn = await tryfindElement("//button[contains(text(), 'Slash')]");
        if (slashBtn) {
            await click(slashBtn);
        } else {
            await simulateKeyPress(' ');
        }

        await sleep(jitter(200, 30));
        return 'slash';
    }

    /** BRACKET: Match closing brackets in reverse order */
    async function handleBracketGame(leftSide) {
        if (!leftSide || leftSide === gameState.bracketLeft) {
            leftSide = gameState.bracketLeft;
        } else {
            gameState.bracketLeft = leftSide;
        }

        const bracketMap = {
            '[': ']',
            '<': '>',
            '(': ')',
            '{': '}'
        };

        const answer = leftSide.split('').reverse().map(c => bracketMap[c] || c).join('');

        for (const char of answer) {
            await simulateKeyPress(char);
            await sleep(jitter(80, 40)); // Human typing speed varies
        }

        gameState.bracketLeft = '';
        await sleep(jitter(300, 25));
        return 'bracket';
    }

    /** CHEAT CODE: Enter arrow sequence */
    async function handleCheatCodeGame(sequence, reactionTime) {
        if (sequence && sequence !== gameState.cheatCode.join('')) {
            gameState.cheatCode = sequence.split('');
            gameState.cheatIndex = 0;
        }

        const arrowKeys = {
            '↑': 'ArrowUp',
            '↓': 'ArrowDown',
            '←': 'ArrowLeft',
            '→': 'ArrowRight'
        };

        while (gameState.cheatIndex < gameState.cheatCode.length) {
            const arrow = gameState.cheatCode[gameState.cheatIndex];
            const key = arrowKeys[arrow];
            if (key) {
                await simulateKeyPress(key);
                await sleep(jitter(reactionTime / 2, 35));
            }
            gameState.cheatIndex++;
        }

        gameState.cheatCode = [];
        gameState.cheatIndex = 0;
        await sleep(jitter(250, 20));
        return 'cheat';
    }

    /** BRIBE: Navigate to positive word, press SPACE */
    async function handleBribeGame() {
        const positiveWords = [
            "affectionate", "agreeable", "bright", "charming", "creative",
            "determined", "energetic", "friendly", "funny", "generous",
            "polite", "likable", "diplomatic", "helpful", "giving",
            "kind", "hardworking", "patient", "dynamic", "loyal", "straightforward"
        ];

        const choiceElements = await tryfindElements("//span[contains(@class, 'choice') or //div[contains(@class, 'bribe')]//span");
        let targetIndex = -1;

        for (let i = 0; i < choiceElements.length; i++) {
            const text = choiceElements[i].textContent.toLowerCase();
            if (positiveWords.some(p => text.includes(p))) {
                targetIndex = i;
                break;
            }
        }

        if (targetIndex >= 0) {
            const currentIndex = gameState.bribeIndex || 0;
            const diff = targetIndex - currentIndex;
            const key = diff > 0 ? 'ArrowDown' : 'ArrowUp';

            for (let i = 0; i < Math.abs(diff); i++) {
                await simulateKeyPress(key);
                await sleep(jitter(80, 30));
            }

            await sleep(jitter(150, 25));
            await simulateKeyPress(' ');
        }

        await sleep(jitter(250, 20));
        return 'bribe';
    }

    /** BACKWARD: Type the word in reverse */
    async function handleBackwardGame(reactionTime) {
        const wordDisplay = await tryfindElement("//span[contains(@class, 'word') or //div[contains(text(), 'Type it backward')]/following-sibling::*");

        if (wordDisplay) {
            const word = wordDisplay.textContent.trim().toUpperCase();
            gameState.backwardWord = word;
        }

        if (gameState.backwardWord) {
            const reversed = gameState.backwardWord.split('').reverse().join('');
            for (const char of reversed) {
                await simulateKeyPress(char);
                await sleep(jitter(reactionTime / 4, 40));
            }
        }

        gameState.backwardWord = '';
        await sleep(jitter(300, 25));
        return 'backward';
    }

    /** CYBERPUNK 2077: Navigate grid, find matching hex codes */
    async function handleCyberpunkGame(reactionTime) {
        // Simple strategy: navigate with arrows, space to select
        // Read grid from DOM if possible
        const gridCells = await tryfindElements("//span[contains(text(), '0') or contains(text(), '1') or contains(text(), 'A') or contains(text(), 'F')]");

        if (gridCells.length > 0) {
            // Try to find target codes and navigate to them
            const targetCodes = [];
            for (const cell of gridCells) {
                const text = cell.textContent.trim();
                if (text.length === 2 && /^[0-9A-F]{2}$/.test(text)) {
                    targetCodes.push(text);
                }
            }

            // Navigate randomly and press space (simplified approach)
            const moves = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
            for (let i = 0; i < 5; i++) {
                await simulateKeyPress(moves[Math.floor(Math.random() * 4)]);
                await sleep(jitter(reactionTime, 20));
            }
            await sleep(jitter(100, 30));
            await simulateKeyPress(' ');
        }

        await sleep(jitter(350, 25));
        return 'cyberpunk';
    }

    /** MINESWEEPER: During memory phase, remember mines; then mark them */
    async function handleMinesweeperGame(reactionTime) {
        const memoryIndicator = await tryfindElement("//span[contains(text(), 'Memory') or contains(text(), 'Remember')]");

        if (memoryIndicator) {
            gameState.minesweeperPhase = 'memory';
            await sleep(jitter(2000, 10)); // Wait for memory phase to end
            return 'minesweeper-memory';
        }

        gameState.minesweeperPhase = 'action';

        // Navigate and mark mines
        const moves = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
        for (let i = 0; i < 4; i++) {
            await simulateKeyPress(moves[Math.floor(Math.random() * 4)]);
            await sleep(jitter(reactionTime, 25));
            await sleep(jitter(50, 50));
            await simulateKeyPress(' ');
        }

        await sleep(jitter(350, 20));
        return 'minesweeper';
    }

    /** WIRE CUTTING: Cut wires based on rules */
    async function handleWireGame(rulesText) {
        const wireButtons = await tryfindElements("//button[contains(@class, 'wire') or //button[contains(text(), '1') or contains(text(), '2') or contains(text(), '3')]]");

        if (wireButtons.length === 0) {
            await sleep(200);
            return 'wire-wait';
        }

        gameState.wireCount = wireButtons.length;

        // Parse rules to determine which wires to cut
        const wiresToCut = new Set();

        if (rulesText) {
            const positionMatch = rulesText.match(/Cut wire number (\d+)/i);
            if (positionMatch) {
                wiresToCut.add(parseInt(positionMatch[1]) - 1);
            }

            const colorMatch = rulesText.match(/Cut all wires colored (\w+)/i);
            if (colorMatch) {
                const color = colorMatch[1].toUpperCase();
                for (let i = 0; i < wireButtons.length; i++) {
                    const style = wireButtons[i].style || {};
                    const btnColor = (style.backgroundColor || style.color || '').toUpperCase();
                    if (btnColor.includes(color) || btnColor.includes(color.substring(0, 3))) {
                        wiresToCut.add(i);
                    }
                }
            }
        }

        gameState.wiresToCut = wiresToCut;

        if (wiresToCut.size === 0) {
            wiresToCut.add(0);
        }

        for (const wireIndex of wiresToCut) {
            if (wireButtons[wireIndex]) {
                await click(wireButtons[wireIndex]);
                await sleep(jitter(150, 35));
            }
        }

        await sleep(jitter(300, 25));
        return 'wire';
    }

    /** Simulate keyboard input for infiltration games */
    async function simulateKeyPress(key) {
        const doc = eval("document");
        const event = new KeyboardEvent('keydown', {
            key: key,
            code: key === ' ' ? 'Space' : 'Key' + key.toUpperCase(),
            keyCode: key.charCodeAt(0) || 32,
            which: key.charCodeAt(0) || 32,
            bubbles: true,
            cancelable: true,
            isTrusted: true
        });
        doc.dispatchEvent(event);

        await sleep(10);

        const upEvent = new KeyboardEvent('keyup', {
            key: key,
            code: key === ' ' ? 'Space' : 'Key' + key.toUpperCase(),
            keyCode: key.charCodeAt(0) || 32,
            which: key.charCodeAt(0) || 32,
            bubbles: true,
            cancelable: true,
            isTrusted: true
        });
        doc.dispatchEvent(upEvent);

        if (verbose) log(ns, `Key pressed: ${key}`);
    }

    /** Handle completion - select reward */
    async function handleCompletion() {
        // Options: Trade for money, reputation, or cancel
        const moneyBtn = await tryfindElement("//button[contains(text(), 'Money') or contains(text(), 'Sell')]");
        const repBtn = await tryfindElement("//button[contains(text(), 'Reputation') or contains(text(), 'Trade')]");

        // Prefer money by default
        if (moneyBtn) {
            await click(moneyBtn);
            log(ns, "INFO: Selected money reward");
        } else if (repBtn) {
            await click(repBtn);
            log(ns, "INFO: Selected reputation reward");
        }

        await sleep(500);

        // Close any completion dialogs
        const closeBtns = await tryfindElements("//button[contains(text(), 'Close') or contains(text(), 'OK')]");
        for (const btn of closeBtns) {
            await click(btn);
            await sleep(100);
        }
    }

    // ==================== DOM Helpers (from casino.js pattern) ====================

    async function click(button) {
        if (button === null || button === undefined)
            throw new Error("click was called on a null reference.");
        const sleepDelay = options['click-sleep-time'];
        if (sleepDelay > 0) await sleep(sleepDelay);

        // Search through all properties to find the one with onClick (React fiber can move)
        let fnOnClick = null;
        for (const key of Object.keys(button)) {
            const prop = button[key];
            if (prop && typeof prop === 'object' && prop.onClick) {
                fnOnClick = prop.onClick;
                break;
            }
        }

        if (!fnOnClick)
            throw new Error(`Found button but couldn't find its onclick method! Keys: ${Object.keys(button).slice(0, 5).join(', ')}...`);
        if (verbose) log(ns, `Clicking button`);
        await fnOnClick({ isTrusted: true });
        if (sleepDelay > 0) await sleep(sleepDelay);
    }

    async function setText(input, text) {
        if (input === null || input === undefined)
            throw new Error("setText was called on a null reference.");
        const sleepDelay = options['click-sleep-time'];
        if (sleepDelay > 0) await sleep(sleepDelay);
        if (verbose) log(ns, `Setting text: ${text}`);

        // Search through all properties to find the one with onChange (React fiber can move)
        let fnOnChange = null;
        for (const key of Object.keys(input)) {
            const prop = input[key];
            if (prop && typeof prop === 'object' && prop.onChange) {
                fnOnChange = prop.onChange;
                break;
            }
        }

        if (!fnOnChange)
            throw new Error(`Found input but couldn't find its onChange method! Keys: ${Object.keys(input).slice(0, 5).join(', ')}...`);

        await fnOnChange({ isTrusted: true, target: { value: text } });
        if (sleepDelay > 0) await sleep(sleepDelay);
    }

    async function findRequiredElement(xpath, retries = 15, customErrorMessage = null) {
        return await internalfindWithRetry(xpath, false, retries, customErrorMessage);
    }

    async function tryfindElement(xpath, retries = 4) {
        return await internalfindWithRetry(xpath, true, retries);
    }

    async function tryfindElements(xpath, retries = 3) {
        const elements = [];
        const sleepTime = options['find-sleep-time'];
        if (sleepTime > 0) await sleep(sleepTime);
        
        for (let i = 0; i < retries; i++) {
            const result = doc.evaluate(xpath, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let j = 0; j < result.snapshotLength; j++) {
                elements.push(result.snapshotItem(j));
            }
            if (elements.length > 0) break;
            await sleep(50 * (i + 1));
        }
        return elements;
    }

    function internalFind(xpath) {
        return doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }

    async function internalfindWithRetry(xpath, expectFailure, maxRetries, customErrorMessage = null) {
        try {
            const sleepTime = options['find-sleep-time'];
            if (sleepTime > 0) await sleep(sleepTime);
            
            let attempts = 0, retryDelayMs = 1;
            while (attempts++ <= maxRetries) {
                if (attempts > 1) {
                    await sleep(retryDelayMs);
                    retryDelayMs = Math.min(retryDelayMs * 2, 200);
                }
                const findAttempt = internalFind(xpath);
                if (findAttempt !== null) return findAttempt;
            }
            
            if (expectFailure) {
                return null;
            } else {
                const errMessage = customErrorMessage ?? `Could not find element with xpath: ${xpath}`;
                throw new Error(errMessage);
            }
        } catch (e) {
            if (!expectFailure) throw e;
            return null;
        }
    }

    // Run the program
    await start();
}
