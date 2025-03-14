/**
 * Utilities module for Rotaeno Stabilizer
 */

/**
 * Lock class for managing asynchronous operations
 */
export class Lock {
    constructor() {
        this.queue = [];
        this.locked = false;
    }

    acquire() {
        if (!this.locked) {
            this.locked = true;
            return Promise.resolve();
        }

        let r = new Promise(r => {
            this.queue.push(r);
        });

        return r.then(() => {
            this.locked = true;
        });
    }

    release() {
        this.locked = false;
        if (this.queue.length)
            (this.queue.shift())();
    }
}

/**
 * Creates a delay promise
 * @param {number} t - Time in milliseconds
 * @returns {Promise} - Promise that resolves after the specified time
 */
export const delay = t => new Promise(r => setTimeout(r, t)); 