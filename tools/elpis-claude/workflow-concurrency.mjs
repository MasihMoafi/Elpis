import os from 'node:os';

/** How many workflow agents run at once: chosen by Elpis from the machine, never a setting (Masih, 2 Nov).
 * Free memory is checked separately before each agent starts. */
export const autoConcurrency = () => Math.max(1, Math.min(16, os.availableParallelism() - 2));
