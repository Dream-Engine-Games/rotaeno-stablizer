/**
 * Renderer module for Rotaeno Stabilizer
 */

import { delay } from './utils.js';

/**
 * Renderer class for handling frame rendering and processing
 */
export class Renderer {
    /**
     * Initialize the renderer
     */
    constructor() {
        this.renderWorkers = [];
        this.renderQueue = [];
        this.renderIds = [];
        this.renderBusy = [];
        this.prevRot = null;
        this.scale = 1;
        
        this.initializeWorkers();
    }

    /**
     * Initialize render workers
     */
    initializeWorkers() {
        for (let i = 0; i < 6; i++) {
            let noWorker = false;
            try {
                this.renderWorkers.push(new Worker('js/render-worker.js?v=1/2025-03-04/1741056551/82ed9e8'));
            } catch {
                if (i !== 0) break;
                noWorker = true;
                window.renderWorkerCompat = {
                    onmessage: null,
                    postMessage: msg => setTimeout(() => window.renderWorkerCompat.proxy.onmessage?.({data: msg})),
                    proxy: {
                        onmessage: null,
                        postMessage: msg => setTimeout(() => window.renderWorkerCompat.onmessage?.({data: msg})),
                    }
                };

                const renderScript = document.createElement('script');
                renderScript.src = 'js/render-worker.js?v=1/2025-03-04/1741056551/82ed9e8';
                document.head.appendChild(renderScript);
                this.renderWorkers.push(window.renderWorkerCompat.proxy);
            }

            this.renderBusy.push(false);
            this.renderWorkers.at(-1).onmessage = ((i) => {
                return (ev) => {
                    const [renderId, success, renderFrame, thr, rot] = ev.data;
                    const prevWorker = this.renderIds.indexOf(renderId) - 1;

                    const queueCompletion = (fn) => {
                        switch (prevWorker) {
                            case -2: throw null;
                            case -1: fn(); break;
                            default: this.renderQueue[prevWorker][0].then(fn); break;
                        }
                    };

                    if (!success) {
                        queueCompletion(() => {
                            this.renderWorkers[i].postMessage([renderId, this.config, renderFrame, rot, this.prevRot], [renderFrame]);
                        });
                    } else {
                        this.renderBusy[i] = false;
                        queueCompletion(() => {
                            this.prevRot = rot;
                            if(renderId !== this.renderIds.shift()) throw null;
                            const [, resolve] = this.renderQueue.shift();
                            ev.data.shift();
                            resolve(ev.data);
                        });
                    }
                };
            })(i);

            if (noWorker) {
                alert(window.translation?.workerDegradation || 'Web Worker is not supported, expect poor performance.');
                break;
            }
        }
    }

    /**
     * Set the current configuration
     * @param {Object} config - Current configuration
     */
    setConfig(config) {
        this.config = config;
        this.scale = null;
    }

    /**
     * Process a video frame
     * @param {VideoFrame|ImageBitmap} frame - Frame to process
     * @returns {Promise<Array>} - Processed frame data
     */
    async processFrame(frame) {
        const frameWidth = (frame.displayWidth ?? frame.width) - this.config.cropL - this.config.cropR;
        const frameHeight = (frame.displayHeight ?? frame.height) - this.config.cropT - this.config.cropB;

        if (!this.scale) {
            let outputDim = Math.floor(Math.sqrt(frameWidth * frameWidth + frameHeight * frameHeight));
            let mbDim = Math.floor(outputDim / 16) * 16;
            document.getElementById('outputDim').max = Math.min(mbDim, 5968);
            document.getElementById('outputDim').value = this.config.outputDim = Math.min(this.config.outputDim, mbDim, 5968);

            this.scale = Math.min(this.config.outputDim / outputDim, 1);
        }

        return new Promise(resolve => {
            const resolveFn = () => {
                for (let i = 0; i < this.renderBusy.length; i++) {
                    if (!this.renderBusy[i]) {
                        const renderId = new Date().getTime() + Math.random().toString().substring(1);
                        const renderCb = [null, null];
                        renderCb[0] = new Promise(resolve => renderCb[1] = resolve);
                        this.renderIds.push(renderId);
                        this.renderQueue.push(renderCb);

                        this.renderWorkers[i].postMessage([renderId, this.config, frame, this.scale, null], [frame]);
                        this.renderBusy[i] = true;

                        resolve([renderCb[0].then(v => {
                            const [blockImage, renderFrame, , rot] = v;
                            blockImage.close();
                            renderFrame['rotationNum'] = rot;
                            return renderFrame;
                        })]);
                        return;
                    }
                }

                throw null;
            };

            if (this.renderBusy.reduce((a, b) => a && b, true)) {
                this.renderQueue.at(-1)[0].then(resolveFn);
            } else {
                resolveFn();
            }
        });
    }

    /**
     * Update the preview canvas with the current frame
     * @param {HTMLCanvasElement} previewCanvas - Canvas element to update
     * @param {ImageBitmap} previewFrame - Frame to display
     * @param {number} currentStep - Current step in the process
     * @returns {Promise<void>}
     */
    async updatePreview(previewCanvas, previewFrame, currentStep) {
        if (!previewFrame) return;

        const outputDim = this.config.outputDim;
        let previewCtx = previewCanvas.getContext('2d');
        previewCanvas.width = previewCanvas.height = this.config.outputDim / 2;
        previewCtx.fillStyle = '#665577';
        previewCtx.fillRect(0, 0, outputDim, outputDim);

        if (currentStep <= 2) { // CODE_BLOCK step or earlier
            let visibleSize = Math.ceil(this.config.blockSize / 2) * 4;
            const scaleFactor = Math.min(Math.floor((outputDim - 4) / 4 / visibleSize), 4);
            visibleSize = Math.max(visibleSize, Math.floor((outputDim - 4) / 16 / scaleFactor) * 4);
            const imageOption = {
                resizeQuality: "pixelated",
                resizeWidth: visibleSize * scaleFactor, resizeHeight: visibleSize * scaleFactor
            };

            const sourceLeft = Math.max(this.config.cropL - visibleSize / 4, 0);
            const sourceTop = Math.max(this.config.cropT - visibleSize / 4, 0);
            const sourceRight = previewFrame.width - Math.max(this.config.cropR - visibleSize / 4, 0) - visibleSize;
            const sourceBottom = previewFrame.height - Math.max(this.config.cropB - visibleSize / 4, 0) - visibleSize;
            const previewRight = previewCanvas.width - visibleSize * scaleFactor;

            const topLeft = createImageBitmap(previewFrame, sourceLeft, sourceTop, visibleSize, visibleSize, imageOption);
            const topRight = createImageBitmap(previewFrame, sourceRight, sourceTop, visibleSize, visibleSize, imageOption);
            const bottomLeft = createImageBitmap(previewFrame, sourceLeft, sourceBottom, visibleSize, visibleSize, imageOption);
            const bottomRight = createImageBitmap(previewFrame, sourceRight, sourceBottom, visibleSize, visibleSize, imageOption);

            previewCtx.drawImage(await topLeft, 0, 0);
            previewCtx.drawImage(await topRight, previewRight, 0);
            previewCtx.drawImage(await bottomLeft, 0, previewRight);
            previewCtx.drawImage(await bottomRight, previewRight, previewRight);

            previewCtx.fillStyle = 'red';
            previewCtx.fillRect((this.config.cropL - sourceLeft) * scaleFactor, 0, 1, previewCanvas.height);
            previewCtx.fillRect(0, (this.config.cropT - sourceTop) * scaleFactor, previewCanvas.width, 1);
            previewCtx.fillRect(previewCanvas.width - 1 - (this.config.cropR - Math.max(this.config.cropR - visibleSize / 4, 0)) * scaleFactor, 0, 1, previewCanvas.height);
            previewCtx.fillRect(0, previewCanvas.height - 1 - (this.config.cropB - Math.max(this.config.cropB - visibleSize / 4, 0)) * scaleFactor, previewCanvas.width, 1);
            previewCtx.fillStyle = 'green';
            previewCtx.fillRect((this.config.cropL - sourceLeft + this.config.blockSize) * scaleFactor, 0, 1, previewCanvas.height);
            previewCtx.fillRect(0, (this.config.cropT - sourceTop + this.config.blockSize) * scaleFactor, previewCanvas.width, 1);
            previewCtx.fillRect(previewCanvas.width - 1 - (this.config.cropR + this.config.blockSize - Math.max(this.config.cropR - visibleSize / 4, 0)) * scaleFactor, 0, 1, previewCanvas.height);
            previewCtx.fillRect(0, previewCanvas.height - 1 - (this.config.cropB + this.config.blockSize - Math.max(this.config.cropB - visibleSize / 4, 0)) * scaleFactor, previewCanvas.width, 1);
        } else {
            this.prevRot = 0;
            const processedFrame = await ((await this.processFrame(await createImageBitmap(previewFrame)))[0]);
            previewCtx.drawImage(processedFrame,
                0, 0, processedFrame.width, processedFrame.height,
                0, 0, previewCanvas.width, previewCanvas.height
            );
            previewCtx.drawImage(processedFrame, 0, 0, outputDim, outputDim,
                0, 0, outputDim / 2, outputDim / 2
            );
        }
    }
} 