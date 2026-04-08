/** @param {NS} ns **/
export async function main(ns) {
    // Whitelist: Protect corporate communication and essential data
    const PROTECTED_PREFIXES = ['corp-', 'permanent-', 'stock-'];
    const TEMP_DIR = 'Temp/';
    
    // Enhanced path safety validation to prevent directory traversal
    function isSafePath(file) {
        if (!file || typeof file !== 'string') return false;
        
        // Decode URL-encoded characters first
        let decodedPath;
        try {
            decodedPath = decodeURIComponent(file);
        } catch (e) {
            return false; // Invalid URL encoding
        }
        
        // Normalize path to prevent traversal attempts
        const normalizedPath = decodedPath.replace(/\\/g, '/').replace(/\/+/g, '/');
        
        // Check for directory escape attempts including decoded variants
        if (normalizedPath.includes('..') || 
            normalizedPath.includes('%2e%2e') || 
            normalizedPath.includes('%2E%2E') ||
            normalizedPath.includes('..%2f') ||
            normalizedPath.includes('..%2F') ||
            normalizedPath.includes('..\\') ||
            normalizedPath.startsWith('../') ||
            normalizedPath.startsWith('..\\')) {
            return false;
        }
        
        // Ensure it resides in the intended Temp directory (case-insensitive)
        const lowerPath = normalizedPath.toLowerCase();
        return lowerPath.startsWith(TEMP_DIR.toLowerCase()) || 
               lowerPath.startsWith('/temp/') || 
               lowerPath.startsWith('temp/');
    }
    
    // Additional validation for filename safety
    function isSafeFilename(filename) {
        if (!filename || typeof filename !== 'string') return false;
        
        // Reject dangerous characters and patterns
        const dangerousPatterns = [
            /[<>:"|?*]/,           // Windows reserved characters
            /^(con|prn|aux|nul)$/i, // Windows reserved names
            /^(com[1-9]|lpt[1-9])$/i, // Windows device names
            /^\./,                  // Hidden files starting with dot
            /\.$/,                  // Files ending with dot
        ];
        
        return !dangerousPatterns.some(pattern => pattern.test(filename));
    }
    
    try {
        const files = ns.ls('home', TEMP_DIR);
        
        for (const file of files) {
            // Skip directories and invalid paths
            if (!file || typeof file !== 'string' || file.endsWith('/')) {
                continue;
            }
            
            // Additional safety: only process files in Temp directory
            if (!isSafePath(file)) {
                ns.print(`WARN: Unsafe path skipped: ${file}`);
                continue; 
            }
            
            // Extract filename for additional validation
            const filename = file.replace(/^.*[\/\\]/, ''); // Extract just the filename
            
            // Validate filename safety
            if (!isSafeFilename(filename)) {
                ns.print(`WARN: Unsafe filename skipped: ${filename}`);
                continue;
            }
            
            // Check if file is protected
            if (PROTECTED_PREFIXES.some(prefix => filename.startsWith(prefix))) {
                ns.print(`INFO: Protected file skipped: ${filename}`);
                continue; 
            }
            
            // Additional safety: don't delete critical system files
            const CRITICAL_FILES = ['reserve.txt', 'daemon-running.txt', 'corp-state.txt', 'stock-probabilities.txt', 'stock-summary.txt'];
            if (CRITICAL_FILES.includes(filename)) {
                ns.print(`INFO: Critical file protected: ${filename}`);
                continue;
            }
            
            // Only attempt deletion if file actually exists
            if (ns.fileExists(file)) {
                const success = ns.rm(file);
                ns.print(`${success ? "INFO: Removed " : "WARN: Failed to remove "} ${file}`);
            } else {
                ns.print(`INFO: File already removed: ${file}`);
            }
        }
    } catch (error) {
        ns.print(`ERROR: Cleanup failed: ${error.message || error}`);
    }
}