---
trigger: glob
globs:
  - "**/*.js"
---

# Netscript Expert Mode

When editing JavaScript files in this repo:
1. **Analyze before Edit:** Read the function boundaries first.
2. **Protect Imports:** Never remove or break the `import { ... } from './helpers.js'` block.
3. **No Nested Try-Catch in Loops:** In long-running loops (especially in `daemon.js`), use a single top-level try-catch to ensure the loop can recover without crashing the whole script.
4. **Final Audit:** After editing, verify that the script is still a valid ES module.